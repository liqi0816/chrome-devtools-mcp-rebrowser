#!/usr/bin/env node

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Step 1: Import the patched puppeteer-core
// ---------------------------------------------------------------------------
// This is puppeteer-core (pinned in package.json — currently 25.18.1) with
// rebrowser-patches applied in-place by postinstall.mjs.
// The patches disable Runtime.Enable (the primary CDP detection vector),
// change sourceURL from pptr:... to app.js, and rename the utility world.
import puppeteerCore from 'puppeteer-core';

// ---------------------------------------------------------------------------
// Step 2: Import the bundled puppeteer from chrome-devtools-mcp
// ---------------------------------------------------------------------------
// ESM modules are cached by resolved URL, so this gives us a reference to the
// SAME puppeteer object that browser.js will use when it calls connect()/launch().
import { puppeteer as bundledPuppeteer } from 'chrome-devtools-mcp/out/Default/gen/src/third_party/browser.js';

bundledPuppeteer.connect = function connect() {
    process.stderr.write('[rebrowser-patch] Redirecting puppeteer.connect() through patched puppeteer-core\n');
    return puppeteerCore.connect.apply(puppeteerCore, arguments);
};

bundledPuppeteer.launch = function launch() {
    process.stderr.write('[rebrowser-patch] Redirecting puppeteer.launch() through patched puppeteer-core\n');
    return puppeteerCore.launch.apply(puppeteerCore, arguments);
};

// ---------------------------------------------------------------------------
// Step 3: Hand off to chrome-devtools-mcp
// ---------------------------------------------------------------------------
// This imports and runs chrome-devtools-mcp's main entry point. When it
// eventually calls puppeteer.connect() or puppeteer.launch() via
// BrowserManager.js → loadBrowser() → third_party/browser.js, it will hit our patched methods above.
await import('chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js');
