#!/usr/bin/env node

/**
 * Postinstall script — auto-applies rebrowser-patches and the
 * DevToolsConnectionAdapter patch so that `npx chrome-devtools-mcp-rebrowser`
 * works out of the box with zero manual setup.
 *
 * Uses the pure-JS `diff` (jsdiff) library to apply unified patches,
 * eliminating platform-specific differences between macOS/Linux/Windows
 * `patch` binaries.
 *
 * Runs after `npm install` (via package.json "postinstall" script).
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parsePatch, applyPatch } from 'diff';
// rebrowser-patches >= 1.1 ships one patch set per upstream version under
// patches/<package>/<version>/; reuse its own selection logic (exact match →
// newest same major.minor → newest overall) so we stay in sync with its CLI.
import { resolvePatchVersion } from 'rebrowser-patches/scripts/utils/index.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory of an installed package by its main/package.json.
 * @param {string} packageName
 */
function pkgDir(packageName) {
  return dirname(require.resolve(`${packageName}/package.json`));
}

/**
 * Fuzzy line comparator for jsdiff's applyPatch.
 *
 * jsdiff has a hard constraint: context lines immediately adjacent to an
 * insertion must match *exactly* (regardless of fuzzFactor). This fails when
 * an upstream update adds parameters: `newPage()` → `newPage(options)`.
 *
 * This compareLine requires everything outside parentheses to match exactly,
 * and inside parentheses one side must be a substring of the other — so
 * `f()` matches `f(options)` but `f(a)` does NOT match `f(completely_different)`.
 *
 * This is safe because jsdiff keeps the file's original content for context
 * lines — the comparator only affects *where* the hunk is placed.
 *
 * @param {number} _lineNumber — 1-based line number in the target file
 * @param {string} line — line from the target file
 * @param {'+' | '-' | ' '} _operation — hunk operation (unused)
 * @param {string} patchContent — expected line from the patch
 */
function fuzzyCompareLine(_lineNumber, line, _operation, patchContent) {
  if (line === patchContent) return true;
  if (line == null || patchContent == null) return false;

  const openL = line.indexOf('('),  closeL = line.lastIndexOf(')');
  const openP = patchContent.indexOf('('), closeP = patchContent.lastIndexOf(')');
  if (openL < 0 || closeL < 0 || openP < 0 || closeP < 0) return false;

  // Everything outside the parens must match exactly
  if (line.slice(0, openL) !== patchContent.slice(0, openP)) return false;
  if (line.slice(closeL + 1) !== patchContent.slice(closeP + 1)) return false;

  // Inside: one must be a substring of the other
  const innerL = line.slice(openL + 1, closeL);
  const innerP = patchContent.slice(openP + 1, closeP);
  return innerL.includes(innerP) || innerP.includes(innerL);
}

/**
 * Apply a single-file patch with fuzzing.
 * Returns the patched string, or false if it cannot be applied.
 * @param {string} source — original file content
 * @param {import('diff').StructuredPatch} filePatch — parsed single-file patch
 * @param {number} [maxFuzz=10] — maximum fuzz factor (number of context lines that can mismatch)
 */
function applyWithFuzz(source, filePatch, maxFuzz = 10) {
  // Try with exact context lines first (jsdiff internally tries 0..maxFuzz errors)
  const exact = applyPatch(source, filePatch, { fuzzFactor: maxFuzz });
  if (exact !== false) return exact;
  // Fallback: fuzzy context for changed function signatures (e.g. newPage() → newPage(options))
  return applyPatch(source, filePatch, { fuzzFactor: maxFuzz, compareLine: fuzzyCompareLine });
}

/**
 * Apply a multi-file unified patch to a target directory.
 * Handles new files (/dev/null → b/path) and skips already-patched files.
 * @param {string} targetDir — absolute path to the package root
 * @param {string | import('diff').StructuredPatch[]} patchContent — raw unified diff string, or already-parsed file patches
 * @param {object} [options]
 * @param {number} [options.maxFuzz] — maximum fuzz factor passed to applyWithFuzz
 * @param {(fp: import('diff').StructuredPatch) => boolean} [options.filter] — predicate to select file patches
 * @returns {Promise<{applied: number, skipped: number, failed: string[]}>}
 */
async function applyMultiPatch(targetDir, patchContent, { maxFuzz , filter } = {}) {
  let filePatches = typeof patchContent === 'string' ? parsePatch(patchContent) : patchContent;
  if (filter) filePatches = filePatches.filter(filter);

  const stats = { applied: 0, skipped: 0, failed: [] };

  for (const fp of filePatches) {
    // New file: oldFileName is "/dev/null", use newFileName ("b/path/to/file")
    // Existing file: oldFileName is "a/path/to/file"
    const isNewFile = fp.oldFileName === '/dev/null';
    const rel = isNewFile ? fp.newFileName.slice(2) : fp.oldFileName.slice(2);

    // For new files, check if already created by a previous run
    let src;
    try { src = await readFile(join(targetDir, rel), 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT' && isNewFile) src = '';
      else throw e;
    }

    // Check if patch content is already present (idempotent)
    const added = fp.hunks.flatMap(h => h.lines.filter(l => l[0] === '+').map(l => l.slice(1).trim())).filter(Boolean);
    if (added.length > 0 && added.every(l => src.includes(l))) { stats.skipped++; continue; }

    const result = applyWithFuzz(src, fp, maxFuzz);
    if (result !== false) {
      const dest = join(targetDir, rel);
      if (isNewFile) await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, result);
      stats.applied++;
    } else {
      stats.failed.push(rel);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Read the installed version of a package, or 'unknown' if it can't be resolved.
 * @param {string} packageName
 */
function pkgVersion(packageName) {
  try { return require(`${packageName}/package.json`).version; }
  catch { return 'unknown'; }
}

/**
 * Print a big, impossible-to-miss error block with diagnostic info and a link to
 * the known-compatibility issue. Tuned specifically for issue #4: a
 * `puppeteer-core` / `rebrowser-patches` version mismatch silently produces an
 * unpatchable install. Both are now pinned exact in package.json, so this path
 * should only fire if a user has overridden the pins or is running from a fork.
 *
 * @param {string} stage — human-readable stage name that failed
 * @param {string[]} failed — list of patch target files that did not apply
 * @param {Record<string, string>} versions — installed versions for context
 */
function printPatchFailureReport(stage, failed, versions) {
  const lines = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `✘ chrome-devtools-mcp-rebrowser postinstall: ${stage} FAILED`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'The following patch targets could not be applied:',
    ...failed.map(f => `  • ${f}`),
    '',
    'Installed versions:',
    ...Object.entries(versions).map(([k, v]) => `  • ${k}: ${v}`),
    '',
    'This usually means one of the patched dependencies was upgraded past',
    'what rebrowser-patches knows how to handle. See:',
    '  https://github.com/liqi0816/chrome-devtools-mcp-rebrowser/issues/4',
    '',
    'Quickest workaround: pin the known-good versions locally, e.g.',
    '  npx -y @liqi0816/chrome-devtools-mcp-rebrowser@1.0.4',
    '(or whatever the latest published version is).',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];
  console.error(lines.join('\n'));
}

async function main() {
  console.log('\n🔧 chrome-devtools-mcp-rebrowser: postinstall\n');

  const puppeteerCoreDir = pkgDir('puppeteer-core');
  const chromeDevtoolsMcpDir = pkgDir('chrome-devtools-mcp');
  const ownDir = resolve(
    dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  );

  const versions = {
    'puppeteer-core': pkgVersion('puppeteer-core'),
    'rebrowser-patches': pkgVersion('rebrowser-patches'),
    'chrome-devtools-mcp': pkgVersion('chrome-devtools-mcp'),
  };
  console.log('Installed:', Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(', '));
  console.log('');

  // 1. Apply rebrowser-patches to puppeteer-core
  console.log('--- Applying rebrowser-patches to puppeteer-core ---');
  const resolved = resolvePatchVersion('puppeteer-core', versions['puppeteer-core'], 'lib');
  if (!resolved) {
    printPatchFailureReport('rebrowser-patches → puppeteer-core', ['(no lib.patch shipped for puppeteer-core)'], versions);
    throw new Error('No rebrowser-patches lib.patch found for puppeteer-core');
  }
  console.log(`  Using rebrowser patch set ${resolved.version}` +
    (resolved.exact ? '' : ` (closest match; not tested upstream on ${versions['puppeteer-core']})`));
  const rebrowserPatch = await readFile(resolved.path, 'utf8');

  // Local per-file overrides for puppeteer-core versions newer than what
  // rebrowser-patches has tested: patches/puppeteer-core/<version>/lib.patch.
  // A file listed there replaces the upstream hunk for that same file.
  let overridePatches = [];
  try {
    overridePatches = parsePatch(await readFile(
      join(ownDir, 'patches', 'puppeteer-core', versions['puppeteer-core'], 'lib.patch'), 'utf8',
    ));
    console.log(`  Local overrides: ${overridePatches.map(fp => fp.oldFileName.slice(2)).join(', ')}`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const overridden = new Set(overridePatches.map(fp => fp.oldFileName));
  const upstreamPatches = parsePatch(rebrowserPatch)
    .filter(({ oldFileName }) => !oldFileName.startsWith('a/lib/es5-iife') && !overridden.has(oldFileName));

  const r1 = await applyMultiPatch(puppeteerCoreDir, [...upstreamPatches, ...overridePatches], { maxFuzz: 10 });
  console.log(`  ✔ ${r1.applied} applied, ${r1.skipped} skipped`);
  if (r1.failed.length) {
    printPatchFailureReport('rebrowser-patches → puppeteer-core', r1.failed, versions);
    throw new Error(`Failed patches: ${r1.failed.join(', ')}`);
  }

  // 2. Block Runtime.enable in chrome-devtools-mcp's DevToolsConnectionAdapter.
  // Since chrome-devtools-mcp 1.x the adapter is bundled (minified, on a single
  // ~900 KB line) into third_party/browser.js, so a unified diff is impractical.
  // Instead, anchor on the adapter's send() signature + its unique error string
  // and inject the guard using whatever parameter names the minifier chose.
  console.log('--- Applying DevToolsConnectionAdapter patch ---');
  const adapterRel = join('out', 'Default', 'gen', 'src', 'third_party', 'browser.js');
  const adapterPath = join(chromeDevtoolsMcpDir, adapterRel);
  const adapterSrc = await readFile(adapterPath, 'utf8');
  const MARKER = '/*rebrowser-patches:DevToolsConnectionAdapter*/';
  if (adapterSrc.includes(MARKER)) {
    console.log('  ✔ 0 applied, 1 skipped');
  } else {
    const anchor = /send\(([\w$]+),([\w$]+),([\w$]+)\)\{if\(\3===void 0\)throw new Error\("Attempting to send on the root session\. This must not happen"\);/g;
    const matches = [...adapterSrc.matchAll(anchor)];
    if (matches.length !== 1) {
      printPatchFailureReport('DevToolsConnectionAdapter patch → chrome-devtools-mcp',
        [`${adapterRel} (expected 1 anchor match, found ${matches.length})`], versions);
      throw new Error(`Failed patches: ${adapterRel}`);
    }
    const [m, method, , sessionId] = matches[0];
    // The DevTools Universe models call Runtime.enable on their own CDP session,
    // which leaks as a detectable CDP marker. Suppress it here just like
    // rebrowser-patches suppresses it inside Puppeteer's FrameManager.
    const guard = `${MARKER}if(${method}==="Runtime.enable"&&process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE!=="0"){` +
      `process.env.REBROWSER_PATCHES_DEBUG&&console.error("[rebrowser-patches][DevToolsConnection] Blocked Runtime.enable on session",${sessionId});` +
      `return Promise.resolve({result:{}})}`;
    const idx = matches[0].index + m.length;
    await writeFile(adapterPath, adapterSrc.slice(0, idx) + guard + adapterSrc.slice(idx));
    console.log('  ✔ 1 applied, 0 skipped');
  }

  console.log('\n✅ All patches applied. Ready to use!\n');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
