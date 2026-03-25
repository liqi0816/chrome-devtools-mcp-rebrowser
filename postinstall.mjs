#!/usr/bin/env node

/**
 * Postinstall script — auto-applies rebrowser-patches and the
 * DevToolsConnectionAdapter patch so that `npx chrome-devtools-mcp-rebrowser`
 * works out of the box with zero manual setup.
 *
 * Runs after `npm install` (via package.json "postinstall" script).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readFile, writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the directory of an installed package by its main/package.json */
function pkgDir(packageName) {
  const entry = require.resolve(`${packageName}/package.json`);
  return dirname(entry);
}

/** Find `patch` executable — on Windows try Git's bundled copy too */
async function findPatch() {
  for (const base of [
    '',
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files (x86)\\Git\\usr\\bin',
  ]) {
    const cmd = join(base, 'patch');
    try {
      await execFile(cmd, ['--version']);
      return cmd;
    } catch {
      // not found, try next
    }
  }
  console.error(
    '✘ Could not find the `patch` command.\n' +
      '  On Linux/macOS it is usually pre-installed.\n' +
      '  On Windows, install Git for Windows — it bundles patch.exe in\n' +
      '  C:\\Program Files\\Git\\usr\\bin\\patch.exe\n' +
      '  and make sure it is on your PATH.',
  );
  throw new Error('Could not find `patch` executable');
}

/**
 * Strip hunks that target paths matching `filterRe` from a unified diff.
 * Returns the filtered patch as a string.
 */
function stripHunksFromPatch(patchContent, filterRe) {
  const lines = patchContent.split('\n');
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    // Each file section starts with "--- a/..."
    if (line.startsWith('--- a/')) {
      const path = line.slice('--- a/'.length).trim();
      skipping = filterRe.test(path);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n');
}

async function insertBeforeMarker(filePath, marker, snippet) {
  const content = await readFile(filePath, 'utf8');

  if (content.includes(snippet.trim())) {
    return;
  }

  const index = content.indexOf(marker);
  if (index === -1) {
    throw new Error(`Could not find patch marker in ${filePath}`);
  }

  const updated = content.slice(0, index) + snippet + content.slice(index);
  await writeFile(filePath, updated);
}

async function applyBrowserConnectionPatch(puppeteerCoreDir) {
  const jsSnippet =
    "    // rebrowser-patches: expose browser CDP session\n" +
    "    _connection() {\n" +
    "        return this.#connection;\n" +
    "    }\n";

  const targets = [
    {
      filePath: join(puppeteerCoreDir, 'lib', 'cjs', 'puppeteer', 'cdp', 'Browser.d.ts'),
      marker: '    _createPageInContext(',
      snippet: '    _connection(): Connection;\n',
    },
    {
      filePath: join(puppeteerCoreDir, 'lib', 'cjs', 'puppeteer', 'cdp', 'Browser.js'),
      marker: '    async _createPageInContext(',
      snippet: jsSnippet,
    },
    {
      filePath: join(puppeteerCoreDir, 'lib', 'esm', 'puppeteer', 'cdp', 'Browser.d.ts'),
      marker: '    _createPageInContext(',
      snippet: '    _connection(): Connection;\n',
    },
    {
      filePath: join(puppeteerCoreDir, 'lib', 'esm', 'puppeteer', 'cdp', 'Browser.js'),
      marker: '    async _createPageInContext(',
      snippet: jsSnippet,
    },
  ];

  for (const target of targets) {
    await insertBeforeMarker(target.filePath, target.marker, target.snippet);
  }

  console.log('✔ Applied Browser._connection() compatibility patch');
}

/**
 * Apply a patch file to a target directory.
 *
 * Captures stdout/stderr so we can distinguish "already applied" from real
 * failures.  With `--forward`, GNU patch exits 1 both when every hunk was
 * previously applied *and* when some hunks genuinely fail.  We tell the two
 * apart by checking the output for FAILED hunks.
 */
async function applyPatch(patchBin, targetDir, patchFile, { fuzz } = {}) {
  const args = [
    '--batch',
    '-p1',
    `--input=${patchFile}`,
    '--verbose',
    '--no-backup-if-mismatch',
    '--reject-file=-',
    '--forward',
  ];
  if (fuzz != null) args.push(`--fuzz=${fuzz}`);

  try {
    const { stdout, stderr } = await execFile(patchBin, args, { cwd: targetDir });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    console.log(`✔ Patch applied successfully in ${targetDir}`);
  } catch (err) {
    // execFile rejects for any non-zero exit code.
    process.stdout.write(err.stdout);
    process.stderr.write(err.stderr);

    // Check whether every hunk was "Reversed (or previously applied)".
    // If so (and there are zero FAILED hunks), this is a genuine
    // "already applied" situation.
    const hasFailedHunks = /FAILED/i.test(err.stdout);
    const hasReversed = /Reversed \(or previously applied\) patch detected/i.test(err.stdout);
    const hasIgnored = /Ignoring previously applied \(or reversed\) patch/i.test(err.stdout);

    if ((hasReversed || hasIgnored) && !hasFailedHunks) {
      console.log(`✔ Patch already applied in ${targetDir} (skipped)`);
      return;
    }

    // Any other non-zero exit is a real error.
    throw new Error(
      `✘ Patch failed in ${targetDir} (exit code ${err.code ?? err.status ?? '?'})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🔧 chrome-devtools-mcp-rebrowser: postinstall\n');

  // 1. Locate patch executable
  const patchBin = await findPatch();
  console.log(`Using patch: ${patchBin}\n`);

  // 2. Resolve package directories
  const puppeteerCoreDir = pkgDir('puppeteer-core');
  const rebrowserPatchesDir = pkgDir('rebrowser-patches');
  const chromeDevtoolsMcpDir = pkgDir('chrome-devtools-mcp');
  const ownDir = resolve(
    dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  );

  console.log(`puppeteer-core:      ${puppeteerCoreDir}`);
  console.log(`rebrowser-patches:   ${rebrowserPatchesDir}`);
  console.log(`chrome-devtools-mcp: ${chromeDevtoolsMcpDir}`);
  console.log(`own package:         ${ownDir}\n`);

  // 3. Apply rebrowser-patches to puppeteer-core (with fuzz for version tolerance)
  //    The upstream patch includes hunks for lib/es5-iife/ which is a bundled
  //    build that doesn't exist in every puppeteer-core release and doesn't
  //    affect Node-side behaviour. The Browser.* hunks are also stripped and
  //    applied separately because their surrounding context changes across
  //    patch-compatible Puppeteer releases.
  const rebrowserPatchFile = join(
    rebrowserPatchesDir,
    'patches',
    'puppeteer-core',
    'lib.patch',
  );

  const rawPatch = await readFile(rebrowserPatchFile, 'utf8');
  const filteredPatch = stripHunksFromPatch(
    rawPatch,
    /^lib\/es5-iife\/|^lib\/(?:cjs|esm)\/puppeteer\/cdp\/Browser\.(?:d\.ts|js)$/,
  );

  // Write the filtered patch to a temp file
  const tmpDir = await mkdtemp(join(tmpdir(), 'rebrowser-'));
  const filteredPatchFile = join(tmpDir, 'lib-no-es5-iife.patch');
  await writeFile(filteredPatchFile, filteredPatch);

  try {
    console.log('--- Applying rebrowser-patches to puppeteer-core (es5-iife stripped) ---');
    await applyPatch(patchBin, puppeteerCoreDir, filteredPatchFile, { fuzz: 10 });
    await applyBrowserConnectionPatch(puppeteerCoreDir);
  } finally {
    // Clean up temp file
    await unlink(filteredPatchFile).catch(() => {});
  }

  // 4. Apply DevToolsConnectionAdapter patch to chrome-devtools-mcp
  const adapterPatchFile = join(
    ownDir,
    'patches',
    'chrome-devtools-mcp',
    'DevToolsConnectionAdapter.js.patch',
  );
  console.log('\n--- Applying DevToolsConnectionAdapter patch to chrome-devtools-mcp ---');
  await applyPatch(patchBin, chromeDevtoolsMcpDir, adapterPatchFile);

  console.log('\n✅ All patches applied. Ready to use!\n');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
