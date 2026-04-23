// End-to-end smoke test for the MCP App demo.
// Connects to a debug-enabled Chrome on 9222, drives the chat, and asserts
// that the Teams composer widget renders inside a sandboxed iframe and that
// clicking Send inside that iframe triggers a successful `send_message`
// tool call proxied through the host to the MCP server.

import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('./artifacts/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(OUT, { recursive: true });

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERTION FAILED:', msg);
    process.exit(1);
  }
  console.log('  ✓', msg);
}

// Resolve the debug endpoint — our Chrome bound to IPv6 [::1] because another
// Chrome instance already owned 127.0.0.1:9222.
async function findDebugEndpoint() {
  for (const url of ['http://[::1]:9222', 'http://127.0.0.1:9222']) {
    try {
      const r = await fetch(`${url}/json/version`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
  }
  throw new Error('No debug-enabled Chrome found on 9222');
}
const browserWSEndpoint = await findDebugEndpoint();
console.log('Connecting to', browserWSEndpoint);
const browser = await puppeteer.connect({
  browserWSEndpoint,
  defaultViewport: { width: 1200, height: 820 },
  protocolTimeout: 60000,
});

// Find the tab that's on our host, or open a new one.
const pages = await browser.pages();
let page = pages.find((p) => p.url().startsWith('http://localhost:3000'));
if (!page) page = await browser.newPage();
await page.bringToFront();
await page.setViewport({ width: 1200, height: 820 });

page.on('console', (m) => console.log(`[page.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[page.error]', e.message));
page.on('requestfailed', (r) => console.log('[page.requestfailed]', r.url(), r.failure()?.errorText));
page.on('frameattached', (f) => {
  console.log('[frame attached]', f.url());
  // Log messages from iframes too.
});

await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });

console.log('\n[1] Loaded host chat page');
await page.screenshot({ path: `${OUT}01-chat-empty.png` });

// Wait for the greeting bubble.
await page.waitForSelector('.bubble.assistant');
const greeting = await page.$eval('.bubble.assistant', (el) => el.textContent);
assert(/demo host for MCP Apps/i.test(greeting), 'Greeting bubble is present');

// Type a message and submit via Enter (avoids form submit->navigation races).
console.log('\n[2] Typing "Send Babak a message in Teams" and submitting');
await page.focus('#composer-input');
await page.type('#composer-input', 'Send Babak a message in Teams');
await page.keyboard.press('Enter');

// Expect an iframe.
console.log('\n[3] Waiting for mcp-app iframe');
await page.waitForSelector('iframe.mcp-app-frame', { timeout: 6000 });
const iframeEl = await page.$('iframe.mcp-app-frame');
const frameInfo = await page.evaluate(() => {
  const f = document.querySelector('iframe.mcp-app-frame');
  return { src: f.src, sandbox: f.getAttribute('sandbox'), title: f.title };
});
console.log('  iframe:', frameInfo);
assert(
  frameInfo.src.startsWith('http://localhost:4100/widget'),
  'iframe src points at MCP server widget endpoint',
);
assert(
  /allow-scripts/.test(frameInfo.sandbox),
  'iframe has sandbox="allow-scripts"',
);
// NOTE: allow-same-origin is intentional. Because the iframe is served from
// a different origin (:4100 vs :3000), same-origin still isolates it from
// the host. We need it so postMessage targetOrigin matches the widget's
// actual origin (without it, the iframe's origin is "null" and strict
// targetOrigin checks on postMessage silently drop messages).
assert(
  /allow-same-origin/.test(frameInfo.sandbox),
  'iframe has sandbox="allow-same-origin" (cross-origin isolation still applies via different port)',
);

// Attach to the iframe as a frame.
let widgetFrame;
for (let i = 0; i < 20 && !widgetFrame; i++) {
  widgetFrame = page.frames().find((f) => f.url().includes('/widget'));
  if (!widgetFrame) await new Promise((r) => setTimeout(r, 100));
}
assert(widgetFrame, 'Widget iframe is attached as a Puppeteer frame');

// Wait for the ui/initialize handshake (driven by chat.js) to populate the
// recipient chip.
await widgetFrame.waitForSelector('.chip', { timeout: 5000 });
const chipText = await widgetFrame.$eval('.chip', (el) => el.textContent);
console.log('  chip:', chipText.trim());
assert(/Babak Shammas/i.test(chipText), 'To: chip shows resolved recipient');

// Put a body into the contenteditable. Using evaluate + a dispatched input
// event is faster and more reliable across browsers than puppeteer's
// keystroke simulation.
console.log('\n[4] Filling message body inside the iframe');
await widgetFrame.evaluate(() => {
  const body = document.getElementById('body');
  body.innerHTML =
    '<p>Hi Babak — this message was sent via an MCP app widget.</p>';
  body.dispatchEvent(new Event('input', { bubbles: true }));
});

await page.screenshot({ path: `${OUT}02-widget-composed.png` });

// Click Send inside the iframe.
console.log('\n[5] Clicking Send inside the widget');
await widgetFrame.click('#btn-send');

// Wait for the "Sent ✓" status inside the widget.
let status = '';
try {
  await widgetFrame.waitForSelector('.status.visible', { timeout: 10000 });
  status = await widgetFrame.$eval('.status', (el) => el.textContent);
} catch (e) {
  const dbg = await widgetFrame.evaluate(() => ({
    btnText: document.getElementById('btn-send')?.textContent,
    btnDisabled: document.getElementById('btn-send')?.disabled,
    statusText: document.getElementById('status')?.textContent,
    statusClass: document.getElementById('status')?.className,
  }));
  console.log('  [debug] widget state at failure:', dbg);
  throw e;
}
console.log('  widget status:', status);
assert(/Sent/.test(status), 'Widget shows Sent confirmation');

// Wait for the host to have appended the follow-up assistant bubble
// (driven by the widget's ui/message notification).
await page.waitForFunction(
  () => {
    const bubbles = Array.from(document.querySelectorAll('.bubble.assistant'));
    return bubbles.some((b) => /I sent the message to/i.test(b.textContent));
  },
  { timeout: 8000 },
);
const bubbles = await page.$$eval('.bubble.assistant', (els) =>
  els.map((e) => e.textContent.trim()),
);
console.log('  all assistant bubbles:', bubbles);
assert(
  bubbles.some((b) => /I sent the message to Babak Shammas\./.test(b)),
  'Host received ui/message and appended assistant bubble',
);

await page.screenshot({ path: `${OUT}03-after-send.png` });

console.log('\n✅ All end-to-end checks passed.');
await browser.disconnect();
