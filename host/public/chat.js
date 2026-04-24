// Browser-side host logic.
//
// Renders chat bubbles and, for assistant responses that include an MCP App
// UI resource, renders a sandboxed cross-origin iframe and wires up the
// MCP Apps postMessage bridge:
//
//   host → iframe   ui/initialize
//   iframe → host   ui/initialized
//   iframe → host   tools/call              (proxied to /api/tool)
//   iframe → host   ui/open-link            (confirmed, then window.open)
//   iframe → host   ui/message              (appended as assistant bubble)
//   iframe → host   ui/notifications/size-changed
//
// Security posture:
//   - Iframe uses sandbox="allow-scripts" (no allow-same-origin). The widget
//     cannot read host cookies or DOM.
//   - On every incoming postMessage we verify `event.source` matches the
//     specific iframe we spawned AND that `event.origin` is the server
//     origin we expect.
//   - Iframes may only call tools on the allowlist the host enforces
//     server-side (see /api/tool).

const WIDGET_ORIGIN = 'http://localhost:4100';

// Log-coloring helpers so the protocol trace is easy to read in DevTools.
const L = {
  host: 'color:#5B5FC7;font-weight:600',
  in: 'color:#107C10',
  out: 'color:#C4314B',
  muted: 'color:#8A8886',
};
console.log('%c[host]%c chat page booted', L.host, L.muted);

const messageList = document.getElementById('message-list');
const form = document.getElementById('composer');
const input = document.getElementById('composer-input');
const debugTimeline = document.getElementById('debug-timeline');
const debugCount = document.getElementById('debug-count');
const debugClearButton = document.getElementById('debug-clear');

const MAX_DEBUG_EVENTS = 80;
let debugEventCount = 0;

connectDebugStream();

debugClearButton.addEventListener('click', () => {
  debugTimeline.innerHTML = '';
  debugEventCount = 0;
  updateDebugCount();
});

updateDebugCount();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addTextBubble('user', text);
  console.log('%c[host]%c user sent: %o', L.host, L.muted, text);
  addDebugEvent({
    direction: 'local',
    channel: 'host',
    label: 'chat/input',
    preview: text,
    detail: { message: text },
  });

  try {
    console.log('%c[host → /api/chat]%c POST', L.out, L.muted, { message: text });
    addDebugEvent({
      direction: 'outgoing',
      channel: 'host api',
      label: 'chat/request',
      preview: text,
      detail: { message: text },
    });
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const { bubbles } = await res.json();
    console.log(
      '%c[host ← /api/chat]%c %d bubble(s): %o',
      L.in,
      L.muted,
      bubbles.length,
      bubbles.map((b) => b.type),
    );
    addDebugEvent({
      direction: 'incoming',
      channel: 'host api',
      label: 'chat/response',
      preview: summarizeBubbles(bubbles),
      detail: { bubbles },
    });
    for (const b of bubbles) {
      if (b.type === 'text') addTextBubble('assistant', b.text);
      else if (b.type === 'mcp-app') addMcpAppBubble(b);
    }
    scrollToBottom();
  } catch (err) {
    addDebugEvent({
      direction: 'incoming',
      channel: 'host api',
      label: 'chat/error',
      preview: err.message,
      detail: { error: err.message },
    });
    addTextBubble('assistant', `(error: ${err.message})`);
  }
});

// ─── Chat bubbles ─────────────────────────────────────────────────────
function addTextBubble(role, text) {
  const row = document.createElement('div');
  row.className = `bubble-row ${role}`;
  row.innerHTML = `
    <span class="avatar-sm" style="background:${role === 'user' ? '#8764B8' : '#5B5FC7'}">${role === 'user' ? 'U' : 'C'}</span>
    <div class="bubble ${role}">${renderInline(text)}</div>
  `;
  messageList.appendChild(row);
  scrollToBottom();
}

// Minimal markdown-ish rendering for assistant text — **bold**, *italic*, `code`.
function renderInline(text) {
  return String(text)
    // Preserve entity references the server already emitted (e.g. &lt;name&gt;).
    .replace(/&(?!#?\w+;)/g, '&amp;')
    .replace(/(?<![a-z0-9])\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![a-z0-9*])\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

// ─── MCP App rendering ────────────────────────────────────────────────
function addMcpAppBubble(b) {
  const row = document.createElement('div');
  row.className = 'bubble-row assistant mcp-app';
  // sandbox notes:
  //   allow-scripts       — the widget is a JS app
  //   allow-same-origin   — widget is served cross-origin from :4100, so the
  //                         same-origin rule still isolates it from the host
  //                         at :3000. We need this so the iframe's document
  //                         origin is the actual :4100 (not "null"), which
  //                         lets the host use a strict `targetOrigin` on
  //                         postMessage (which in turn prevents leaking
  //                         messages if the iframe ever navigates).
  //   allow-forms         — Enter-to-submit inside the composer
  //   allow-popups        — ui/open-link can open a new tab
  //   allow-popups-to-escape-sandbox — the Teams deep link opens unsandboxed
  row.innerHTML = `
    <span class="avatar-sm" style="background:#5B5FC7">C</span>
    <div>
      <iframe
        class="mcp-app-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        title="MCP App: ${escapeAttr(b.toolName)}"
      ></iframe>
      <div class="mcp-app-meta">mcp-app · ${escapeAttr(b.resource.uri)}</div>
    </div>
  `;
  const frame = row.querySelector('iframe');
  messageList.appendChild(row);
  mountMcpApp(frame, b);
  scrollToBottom();
}

function mountMcpApp(iframe, bubble) {
  console.log(
    '%c[host]%c mounting MCP App %o → iframe src=%s',
    L.host,
    L.muted,
    { uri: bubble.resource.uri, toolName: bubble.toolName },
    bubble.resource.externalUrl,
  );
  addDebugEvent({
    direction: 'local',
    channel: 'host',
    label: 'mcp-app/render',
    preview: `${bubble.resource.uri} (${bubble.toolName})`,
    detail: bubble,
  });
  // Per-iframe RPC server state.
  const bridge = {
    iframe,
    expectedOrigin: WIDGET_ORIGIN,
    bubble,
    handleMessage: null,
  };

  bridge.handleMessage = (ev) => {
    // Guardrails: only trust messages from our own iframe's window and the
    // expected origin.
    if (ev.source !== iframe.contentWindow) return;
    if (ev.origin !== bridge.expectedOrigin) return;
    const frame = ev.data;
    if (!frame || frame.jsonrpc !== '2.0') return;
    dispatchFromIframe(bridge, frame);
  };
  window.addEventListener('message', bridge.handleMessage);

  // Navigate the iframe to the widget URL. We do this after attaching the
  // listener so we can catch an extremely fast ui/initialized if the widget
  // runs synchronously on load.
  iframe.addEventListener('load', () => sendInitialize(bridge), { once: true });
  iframe.src = bubble.resource.externalUrl;
}

function sendInitialize(bridge) {
  const params = {
    protocolVersion: '2026-01-26',
    toolName: bridge.bubble.toolName,
    // toolInput is what the tool was called with, plus the structured output
    // (so the widget gets the resolved recipient record without another call).
    toolInput: { ...bridge.bubble.toolInput, ...(bridge.bubble.structuredContent || {}) },
    toolResult: bridge.bubble.toolResult,
    hostContext: {
      theme: 'light',
      locale: 'en-US',
      styleVariables: {
        '--mcp-accent': '#5B5FC7',
        '--mcp-surface': '#FFFFFF',
      },
      capabilities: {
        tools: true,
        openLink: true,
        message: true,
        downloadFile: false,
      },
    },
  };
  console.log(
    '%c[host → iframe]%c ui/initialize %o',
    L.out,
    L.muted,
    params,
  );
  postToIframe(bridge, {
    jsonrpc: '2.0',
    id: 'init-' + Date.now(),
    method: 'ui/initialize',
    params,
  });
}

function postToIframe(bridge, frame) {
  addDebugEvent({
    direction: 'outgoing',
    channel: 'mcp app',
    label: describeJsonRpc(frame),
    preview: summarizeFrame(frame),
    detail: frame,
  });
  bridge.iframe.contentWindow?.postMessage(frame, bridge.expectedOrigin);
}

function connectDebugStream() {
  const stream = new EventSource('/api/debug/stream');

  stream.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleDebugStreamEvent(payload);
    } catch (err) {
      console.warn('[host] could not parse debug stream payload', err);
    }
  });

  stream.addEventListener('error', () => {
    addDebugEvent({
      direction: 'incoming',
      channel: 'mcp server',
      label: 'debug/stream-error',
      preview: 'Lost connection to host debug stream',
      detail: null,
    });
  });
}

function handleDebugStreamEvent(event) {
  if (event.type !== 'mcp-rpc') return;

  if (event.phase === 'request') {
    addDebugEvent({
      direction: 'outgoing',
      channel: 'mcp server',
      label: event.frame?.method || 'rpc/request',
      preview: summarizeData(event.frame?.params),
      detail: event,
      timestamp: event.timestamp,
    });
    return;
  }

  addDebugEvent({
    direction: 'incoming',
    channel: 'mcp server',
    label: event.frame?.error ? 'rpc/error' : event.frame?.result ? 'rpc/result' : 'rpc/response',
    preview: summarizeData(event.frame?.error || event.frame?.result),
    detail: event,
    timestamp: event.timestamp,
  });
}

async function dispatchFromIframe(bridge, frame) {
  addDebugEvent({
    direction: 'incoming',
    channel: 'mcp app',
    label: describeJsonRpc(frame),
    preview: summarizeFrame(frame),
    detail: frame,
  });

  // Response to a host-initiated call: we only use this for ui/initialize ack.
  if (frame.id != null && (frame.result !== undefined || frame.error)) {
    console.log(
      '%c[host ← iframe]%c reply id=%o %o',
      L.in,
      L.muted,
      frame.id,
      frame.result ?? frame.error,
    );
    return;
  }

  console.log(
    '%c[host ← iframe]%c %s id=%o %o',
    L.in,
    L.muted,
    frame.method,
    frame.id ?? '(notification)',
    frame.params,
  );

  switch (frame.method) {
    case 'ui/initialized':
      // Widget has finished its handshake.
      return;

    case 'tools/call': {
      const { name, arguments: args } = frame.params || {};
      try {
        console.log(
          '%c[host → /api/tool]%c %s %o',
          L.out,
          L.muted,
          name,
          args,
        );
        addDebugEvent({
          direction: 'outgoing',
          channel: 'host proxy',
          label: 'tools/call',
          preview: summarizeData(args),
          detail: { name, arguments: args, via: '/api/tool' },
        });
        const res = await fetch('/api/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, arguments: args }),
        });
        const body = await res.json();
        console.log(
          '%c[host ← /api/tool]%c %s → %o',
          L.in,
          L.muted,
          name,
          body.error ? { error: body.error } : body.result?.structuredContent ?? body.result,
        );
        addDebugEvent({
          direction: 'incoming',
          channel: 'host proxy',
          label: body.error ? 'tools/error' : 'tools/result',
          preview: summarizeData(body.error ? body.error : body.result?.structuredContent ?? body.result),
          detail: { via: '/api/tool', ...body },
        });
        if (!res.ok || body.error) {
          postToIframe(bridge, {
            jsonrpc: '2.0',
            id: frame.id,
            error: body.error || { code: -32000, message: `HTTP ${res.status}` },
          });
        } else {
          postToIframe(bridge, {
            jsonrpc: '2.0',
            id: frame.id,
            result: body.result,
          });
        }
      } catch (err) {
        addDebugEvent({
          direction: 'incoming',
          channel: 'host proxy',
          label: 'tools/error',
          preview: err.message,
          detail: { name, error: err.message, via: '/api/tool' },
        });
        postToIframe(bridge, {
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32000, message: err.message },
        });
      }
      return;
    }

    case 'ui/open-link': {
      const url = frame.params?.url;
      if (!url) return;
      console.log('%c[host]%c ui/open-link → confirming %s', L.host, L.muted, url);
      const allow = await confirmOpenLink(url);
      console.log('%c[host]%c open-link confirmed=%o', L.host, L.muted, allow);
      if (allow) window.open(url, '_blank', 'noopener');
      if (frame.id != null) {
        postToIframe(bridge, {
          jsonrpc: '2.0',
          id: frame.id,
          result: { opened: allow },
        });
      }
      return;
    }

    case 'ui/message': {
      const text = frame.params?.text;
      if (text) {
        console.log(
          '%c[host]%c iframe pushed ui/message → appending assistant bubble',
          L.host,
          L.muted,
        );
        addTextBubble('assistant', text);
      }
      return;
    }

    case 'ui/notifications/size-changed': {
      const h = Math.max(120, Math.min(700, Number(frame.params?.height || 0)));
      if (h) bridge.iframe.style.height = `${h}px`;
      scrollToBottom();
      return;
    }

    default:
      console.warn('%c[host]%c unknown iframe method %s', L.host, L.muted, frame.method);
      if (frame.id != null) {
        postToIframe(bridge, {
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32601, message: `Unknown method: ${frame.method}` },
        });
      }
  }
}

// ─── Open-link confirm dialog ─────────────────────────────────────────
function confirmOpenLink(url) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'dialog-backdrop';
    bd.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>Open link?</h3>
        <div class="url">${escapeAttr(url)}</div>
        <div class="actions">
          <button data-act="cancel">Cancel</button>
          <button class="primary" data-act="open">Open</button>
        </div>
      </div>
    `;
    document.body.appendChild(bd);
    bd.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      bd.remove();
      resolve(act === 'open');
    });
  });
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ─── Greeting ─────────────────────────────────────────────────────────
addTextBubble(
  'assistant',
  "Hi! I'm a demo host for MCP Apps. Try: *Send Babak a message in Teams*",
);

function addDebugEvent({ direction = 'local', channel, label, preview, detail, timestamp }) {
  const item = document.createElement('li');
  item.className = `debug-entry ${direction}`;

  const previewText = summarizeData(preview);
  const detailText = formatDetail(detail);
  const flowText = describeFlow(channel, direction, label);
  const protocolText = `${channel} · ${label}`;
  const eventTime = timestamp ? new Date(timestamp) : new Date();
  item.innerHTML = `
    <div class="debug-entry-head">
      <div class="debug-entry-main">
        <div class="debug-entry-meta">
          <span class="debug-icon ${direction}" aria-hidden="true">${directionIcon(direction)}</span>
          <span class="debug-label">${escapeAttr(flowText)}</span>
          <span class="debug-protocol">${escapeAttr(protocolText)}</span>
        </div>
        <div class="debug-preview-row">
          <div class="debug-preview">${escapeAttr(previewText)}</div>
          ${detailText ? `
            <details class="debug-detail-toggle">
              <summary>Details</summary>
              <div class="debug-detail">${escapeAttr(detailText)}</div>
            </details>
          ` : ''}
        </div>
      </div>
      <div class="debug-time">${escapeAttr(formatTimestamp(eventTime))}</div>
    </div>
  `;

  debugTimeline.appendChild(item);
  debugEventCount += 1;
  while (debugTimeline.children.length > MAX_DEBUG_EVENTS) {
    debugTimeline.removeChild(debugTimeline.firstElementChild);
  }
  updateDebugCount();
  debugTimeline.scrollTop = debugTimeline.scrollHeight;
}

function updateDebugCount() {
  const visible = debugTimeline.children.length;
  debugCount.textContent = `${visible} event${visible === 1 ? '' : 's'}`;
}

function directionIcon(direction) {
  if (direction === 'outgoing') return '&rarr;';
  if (direction === 'incoming') return '&larr;';
  return '&bull;';
}

function describeFlow(channel, direction, label) {
  if (channel === 'mcp server') {
    if (direction === 'outgoing') return 'Host sends to MCP server';
    if (direction === 'incoming') return 'MCP server returns to host';
  }

  if (channel === 'mcp app') {
    if (direction === 'outgoing') return 'Host sends to MCP app';
    if (direction === 'incoming') return 'MCP app sends to host';
    return 'Host mounts MCP app';
  }

  if (channel === 'host proxy') {
    if (direction === 'outgoing') return 'Host proxies to MCP server';
    if (direction === 'incoming') return 'MCP server returns to host';
  }

  if (channel === 'host api') {
    if (direction === 'outgoing') return 'Host sends chat request';
    if (direction === 'incoming') return 'Host receives chat response';
  }

  if (channel === 'host') {
    if (label === 'mcp-app/render') return 'Host renders MCP app iframe';
    return 'Host event';
  }

  return direction === 'incoming' ? 'Incoming event' : direction === 'outgoing' ? 'Outgoing event' : 'Local event';
}

function formatTimestamp(date) {
  const base = date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function describeJsonRpc(frame) {
  if (frame.method) return frame.method;
  if (frame.error) return 'rpc/error';
  return 'rpc/result';
}

function summarizeFrame(frame) {
  if (frame.method) return summarizeData(frame.params);
  if (frame.error) return summarizeData(frame.error);
  return summarizeData(frame.result);
}

function summarizeBubbles(bubbles) {
  if (!Array.isArray(bubbles) || !bubbles.length) return 'No bubbles returned';
  return bubbles
    .map((bubble) => {
      if (bubble.type === 'text') return `text: ${summarizeData(bubble.text)}`;
      if (bubble.type === 'mcp-app') return `mcp-app: ${bubble.toolName}`;
      return bubble.type || 'unknown';
    })
    .join(' | ');
}

function summarizeData(value) {
  if (value == null) return 'No payload';
  if (typeof value === 'string') return collapseWhitespace(value);
  try {
    return collapseWhitespace(JSON.stringify(value));
  } catch {
    return collapseWhitespace(String(value));
  }
}

function collapseWhitespace(value) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function formatDetail(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
