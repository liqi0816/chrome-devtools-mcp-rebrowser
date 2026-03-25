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
 * @param {string} patchContent — raw unified diff string
 * @param {object} [options]
 * @param {number} [options.maxFuzz] — maximum fuzz factor passed to applyWithFuzz
 * @param {(fp: import('diff').StructuredPatch) => boolean} [options.filter] — predicate to select file patches
 * @returns {Promise<{applied: number, skipped: number, failed: string[]}>}
 */
async function applyMultiPatch(targetDir, patchContent, { maxFuzz , filter } = {}) {
  let filePatches = parsePatch(patchContent);
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

async function main() {
  console.log('\n🔧 chrome-devtools-mcp-rebrowser: postinstall\n');

  const puppeteerCoreDir = pkgDir('puppeteer-core');
  const rebrowserPatchesDir = pkgDir('rebrowser-patches');
  const chromeDevtoolsMcpDir = pkgDir('chrome-devtools-mcp');
  const ownDir = resolve(
    dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  );

  // 1. Apply rebrowser-patches to puppeteer-core
  console.log('--- Applying rebrowser-patches to puppeteer-core ---');
  const rebrowserPatch = await readFile(
    join(rebrowserPatchesDir, 'patches', 'puppeteer-core', 'lib.patch'), 'utf8',
  );
  const r1 = await applyMultiPatch(puppeteerCoreDir, rebrowserPatch, {
    maxFuzz: 10,
    filter: ({ oldFileName }) => !oldFileName.startsWith('a/lib/es5-iife')
  });
  console.log(`  ✔ ${r1.applied} applied, ${r1.skipped} skipped`);
  if (r1.failed.length) throw new Error(`✘ Failed: ${r1.failed.join(', ')}`);

  // 2. Apply DevToolsConnectionAdapter patch to chrome-devtools-mcp
  console.log('--- Applying DevToolsConnectionAdapter patch ---');
  const adapterPatch = await readFile(
    join(ownDir, 'patches', 'chrome-devtools-mcp', 'DevToolsConnectionAdapter.js.patch'), 'utf8',
  );
  const r2 = await applyMultiPatch(chromeDevtoolsMcpDir, adapterPatch, { maxFuzz: 2 });
  console.log(`  ✔ ${r2.applied} applied, ${r2.skipped} skipped`);
  if (r2.failed.length) throw new Error(`✘ Failed: ${r2.failed.join(', ')}`);

  console.log('\n✅ All patches applied. Ready to use!\n');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
