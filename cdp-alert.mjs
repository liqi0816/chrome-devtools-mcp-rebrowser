#!/usr/bin/env node

/**
 * Minimal Chrome DevTools Protocol script that runs `alert()` on the current tab.
 *
 * Connects to the browser-level CDP WebSocket, discovers the first page target,
 * attaches to it via a flattened session, then calls Runtime.evaluate.
 *
 * Chrome 144+: remote debugging can be enabled via settings checkbox;
 *              the /json HTTP endpoints are deprecated/removed.
 *
 * Usage:  node cdp-alert.mjs
 */

const WS_URL = process.env.CDP_WS || 'ws://127.0.0.1:9222/devtools/browser';
const ws = new WebSocket(WS_URL);

let nextId = 1;
const pending = new Map(); // id → { resolve }

function send(method, params = {}, sessionId) {
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise(resolve => pending.set(id, { resolve }));
}

ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
    }
});

ws.addEventListener('error', err => {
    console.error('WebSocket error:', err);
    process.exit(1);
});

ws.addEventListener('open', async () => {
    // 1. Find the first page target
    const { result } = await send('Target.getTargets');
    const page = result.targetInfos.find(t => t.type === 'page');
    if (!page) {
        console.error('No page target found');
        process.exit(1);
    }
    console.log(`Target: ${page.title} — ${page.url}`);

    // 2. Attach to the page with a flattened session
    const attach = await send('Target.attachToTarget', {
        targetId: page.targetId,
        flatten: true,
    });
    const sessionId = attach.result.sessionId;
    console.log(`Session: ${sessionId}`);

    // 3. Evaluate CDP detection in the page context
    const evalResult = await send(
        'Runtime.evaluate',
        {
            expression: `
                var detected = false;
                var e = new Error();
                Object.defineProperty(e, 'stack', {
                  get() {
                      detected = true;
                  }
                });
                console.log(e);
                alert(detected);
                console.log(detected);
            `,
        },
        sessionId,
    );

    console.log('Result:', JSON.stringify(evalResult.result, null, 2));

    ws.close();
});
