// MCP server process.
//
// Exposes:
//   POST /mcp      — JSON-RPC 2.0 endpoint implementing a tiny subset of MCP:
//                    initialize, tools/list, tools/call, resources/list,
//                    resources/read.
//   GET  /widget   — the Teams composer widget HTML (the iframe src the host
//                    points at after a `send_teams_message` tool result).
//   GET  /health   — liveness check.

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildTools, RESOURCES, TEAMS_COMPOSER_URI } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4100);
const WIDGET_BASE_URL = process.env.WIDGET_BASE_URL || `http://localhost:${PORT}`;

const widgetHtml = readFileSync(path.resolve(__dirname, 'widget.html'), 'utf8');
const tools = buildTools({ widgetBaseUrl: WIDGET_BASE_URL, widgetHtml });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

// ─── MCP JSON-RPC ─────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};
  const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) =>
    res.json({ jsonrpc: '2.0', id, error: { code, message, data } });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: '2026-01-26',
          serverInfo: { name: 'mcp-app-example-server', version: '1.0.0' },
          capabilities: { tools: {}, resources: {}, apps: {} },
        });

      case 'tools/list':
        return reply({
          tools: Object.values(tools).map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            _meta: t._meta,
          })),
        });

      case 'tools/call': {
        const { name, arguments: args = {} } = params || {};
        const tool = tools[name];
        if (!tool) return fail(-32601, `Unknown tool: ${name}`);
        const out = await tool.handler(args);
        return reply(out);
      }

      case 'resources/list':
        return reply({ resources: Object.values(RESOURCES) });

      case 'resources/read': {
        const { uri } = params || {};
        if (uri !== TEAMS_COMPOSER_URI)
          return fail(-32602, `Unknown resource: ${uri}`);
        return reply({
          contents: [
            {
              uri,
              mimeType: 'text/html;profile=mcp-app',
              text: widgetHtml,
            },
          ],
        });
      }

      default:
        return fail(-32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    console.error('[mcp]', method, err);
    return fail(-32000, err.message || 'Server error');
  }
});

// ─── Widget HTML (the iframe src) ─────────────────────────────────────────
app.get('/widget', (req, res) => {
  // Tight CSP: the widget is self-contained (inline scripts/styles) and makes
  // no network requests of its own — all tool calls go out via postMessage to
  // the host, not fetch(). So we lock `connect-src` to 'self' (defense in
  // depth against a future accidental fetch) and scope `img-src` to the few
  // sources the widget actually needs. `frame-ancestors *` is deliberate: an
  // MCP App widget is meant to be iframed by arbitrary hosts (Claude Desktop,
  // VS Code Copilot, Goose, this demo) — restricting it to one host would
  // break the portability claim.
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://res.cdn.office.net",
      "connect-src 'self'",
      "frame-ancestors *",
    ].join('; '),
  );
  res.type('html').send(widgetHtml);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[mcp-server] listening on ${WIDGET_BASE_URL}`);
  console.log('[mcp-server] tools:', Object.keys(tools).join(', '));
});
