#!/usr/bin/env node

/**
 * Pre-publish smoke test — packs the current source into a tarball and installs
 * it into a clean temp directory, exactly the way `npx @latest` would. This
 * catches issue-#4-class bugs (floating deps that break postinstall) before
 * users ever see them. Hooked via `prepublishOnly` in package.json.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const tmp = mkdtempSync(join(tmpdir(), 'cdmr-smoke-'));
try {
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim();
  const consumer = join(tmp, 'consumer');
  run('mkdir', ['-p', consumer]);
  run('npm', ['init', '-y'], consumer);
  // This triggers our postinstall.mjs against live-resolved deps.
  run('npm', ['install', '--no-audit', '--no-fund', join(tmp, tarball)], consumer);
  // --help exits 0 without a browser, proving the bin is wired up.
  run(join(consumer, 'node_modules', '.bin', 'chrome-devtools-mcp-rebrowser'), ['--help'], consumer);
  console.log('\n✅ smoke-test passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
