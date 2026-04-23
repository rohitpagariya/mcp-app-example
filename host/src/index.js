// Host process.
//
// Serves the Teams-styled chat page at /, plus two JSON endpoints the browser
// calls:
//   POST /api/chat        — user sent a chat message; run intent router; if
//                           it resolved to a tool, call the MCP server and
//                           return the tool result to the browser.
//   POST /api/tool        — iframe-initiated `tools/call` proxied through the
//                           browser. The host enforces an allowlist here.
//
// NOTE: The MCP session and tool proxy all happen server-side so that a
// real deployment could hide its MCP server behind an auth boundary. The
// iframe never talks to the MCP server directly; it postMessages the host
// page, which POSTs to /api/tool, which hits the MCP server.

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { McpClient } from './mcpClient.js';
import { routeIntent } from './intentRouter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:4100/mcp';

const mcp = new McpClient(MCP_URL);

// Which tools may be invoked from an iframe?  An MCP App widget should only
// be able to call tools exposed by the same server that returned it, and
// (usually) only tools that list `_meta.ui.hidden === true` or are
// explicitly whitelisted for that UI. We keep a simple allowlist here.
const IFRAME_TOOL_ALLOWLIST = new Set(['send_message', 'search_recipients']);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(__dirname, '../public')));

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};
  const intent = routeIntent(message);
  if (!intent) return res.json({ bubbles: [] });

  if (intent.type === 'reply') {
    return res.json({ bubbles: [{ type: 'text', text: intent.text }] });
  }

  if (intent.type === 'toolCall') {
    try {
      const result = await mcp.callTool(intent.toolName, intent.arguments);
      return res.json({
        bubbles: toBubbles(result, intent),
      });
    } catch (err) {
      console.error('[host] tools/call failed', err);
      return res.json({
        bubbles: [
          { type: 'text', text: `Sorry, the tool failed: ${err.message}` },
        ],
      });
    }
  }

  res.json({ bubbles: [] });
});

app.post('/api/tool', async (req, res) => {
  const { name, arguments: args } = req.body || {};
  if (!IFRAME_TOOL_ALLOWLIST.has(name)) {
    console.warn('[host] iframe tried to call disallowed tool:', name);
    return res
      .status(403)
      .json({ error: { code: -32001, message: `Tool not allowed from UI: ${name}` } });
  }
  try {
    const result = await mcp.callTool(name, args || {});
    res.json({ result });
  } catch (err) {
    console.error('[host] iframe tool call failed', err);
    res.status(500).json({
      error: { code: err.code || -32000, message: err.message || 'error' },
    });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, mcp: mcp.initialized }));

// Initialize the MCP session before binding the HTTP port so /api/chat can't
// race a handshake-in-flight. We still boot the listener if MCP is down — the
// host page should load and show a clear error rather than hanging — but in
// the happy path every request sees an initialized client.
try {
  await mcp.initialize();
  const tl = await mcp.listTools();
  console.log(
    '[host] MCP server offers tools:',
    tl.tools.map((t) => t.name).join(', '),
  );
} catch (err) {
  console.error(
    `[host] Could not connect to MCP server at ${MCP_URL} — make sure it is running.`,
    err.message,
  );
}

app.listen(PORT, () => {
  console.log(`[host] listening on http://localhost:${PORT}`);
});

// Turn an MCP `tools/call` result into a list of UI bubbles the browser can
// render. Text content → text bubble. resource content with mime
// `text/html;profile=mcp-app` → iframe bubble carrying the externalUrl plus
// the `structuredContent` from the tool (used as `toolInput` in ui/initialize).
function toBubbles(result, intent) {
  const bubbles = [];
  for (const c of result?.content ?? []) {
    if (c.type === 'text' && c.text) {
      bubbles.push({ type: 'text', text: c.text });
    } else if (
      c.type === 'resource' &&
      c.resource?.mimeType === 'text/html;profile=mcp-app'
    ) {
      const ext = c.resource?._meta?.ui?.externalUrl;
      bubbles.push({
        type: 'mcp-app',
        toolName: intent.toolName,
        toolInput: intent.arguments,
        toolResult: { structuredContent: result.structuredContent },
        structuredContent: result.structuredContent,
        resource: {
          uri: c.resource.uri,
          mimeType: c.resource.mimeType,
          externalUrl: ext,
          // Include the text too so a client could srcdoc-render if preferred.
          text: c.resource.text,
        },
      });
    }
  }
  return bubbles;
}
