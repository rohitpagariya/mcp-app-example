# MCP App Example — "Send a message in Teams" widget in a Teams‑style chatbot

## 1. Goal

Build an end‑to‑end, runnable demo that proves out the **MCP Apps** pattern (the
spec standardised from [mcp-ui.dev](https://mcpui.dev) and finalised on
2026‑01‑26 as [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)):

1. A **chatbot host web app** styled like Microsoft Teams (single conversation,
   back‑and‑forth, no chat switcher).
2. An **MCP client adapter** embedded in the host that speaks MCP to our server,
   renders tool‑returned UI resources in a sandboxed iframe, and proxies
   iframe‑initiated `tools/call` requests back to the MCP server.
3. An **MCP server** that exposes one tool — `send_teams_message` — which
   *returns a UI resource* instead of plain text. The UI is the "Send a message
   in Teams" composer widget shown in the reference screenshot (recipient chip,
   rich‑text body, **Open** / **Send** buttons).
4. The widget calls back into the server via the MCP Apps postMessage channel
   to actually send the message. The server's `send_message` implementation
   hits a **mocked Microsoft Graph** layer (drop‑in replaceable with a real
   Graph client when credentials are available).

The demo must be self‑contained (one `pnpm dev` / `npm run dev`), use only
mocked data for recipients and Graph responses, and match the protocol wire
format closely enough that the same server could plug into Claude, Claude
Desktop, VS Code Copilot, or Goose with no changes.

---

## 2. Reference material (consulted)

- MCP Apps overview — <https://modelcontextprotocol.io/extensions/apps/overview>
- Release blog — <https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/>
- MCP‑UI protocol details — <https://mcpui.dev/guide/protocol-details>
- `@mcp-ui/server` / `@mcp-ui/client` — <https://github.com/idosal/mcp-ui>
- `@modelcontextprotocol/ext-apps` (`App`, `AppBridge`) — <https://github.com/modelcontextprotocol/ext-apps>
- Starter examples — `ext-apps/examples/basic-server-vanillajs`, `basic-host`

Key facts pinned from that research:

| Concern | Value |
|---|---|
| UI resource MIME | `text/html;profile=mcp-app` |
| URI scheme | `ui://<component-name>/<instance-id>` |
| Tool → UI link | `_meta.ui.resourceUri` on the tool definition |
| Iframe transport | JSON‑RPC over `window.postMessage` |
| Handshake | `ui/initialize` (host → iframe), `ui/initialized` (iframe → host) |
| Iframe → host methods | `tools/call`, `ui/message`, `ui/open-link`, `ui/notifications/size-changed` |
| Host → iframe notifications | `ui/notifications/tool-input`, `tool-result`, `host-context-changed`, `size-changed`, `tool-cancelled` |
| Sandbox | `<iframe sandbox="allow-scripts">` plus `_meta.ui.csp` / `_meta.ui.permissions` |
| Content shapes | `rawHtml` (inline), `externalUrl`, `remoteDom` — we'll use `rawHtml` |
| Encoding | `text` or base64 `blob` — we'll use `text` |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js host app at http://localhost:3000)                 │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Teams-style chat UI (React)                                   │  │
│  │   ├─ <MessageList/>          bubbles for user & assistant      │  │
│  │   ├─ <Composer/>             input box at bottom               │  │
│  │   └─ <MCPAppBubble/>   ◄──── renders a <UIResourceRenderer/>   │  │
│  │                              when assistant returns a UI       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                   │ mcp-over-http (fetch /api/mcp)                   │
│                   ▼                                                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  MCP host runtime (lives in the same Next.js page)             │  │
│  │   ├─ MCP client  ──► JSON-RPC to our server                    │  │
│  │   └─ AppBridge   ──► postMessage to/from iframes               │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                   │ HTTP (Streamable HTTP transport)
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  MCP server (Node, Express) at http://localhost:4000/mcp             │
│   ├─ tool  send_teams_message  (returns ui:// resource)              │
│   ├─ tool  send_message        (called from iframe, hits Graph)      │
│   ├─ tool  search_recipients   (called from iframe, typeahead)       │
│   └─ resource  ui://teams-composer/v1  (inline HTML for widget)      │
└──────────────────────────────────────────────────────────────────────┘
                   │ (injected) GraphClient interface
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  graph-mock.ts   — in-memory fake of Graph /me/chats/{id}/messages   │
│                    (swap for real @microsoft/microsoft-graph-client) │
└──────────────────────────────────────────────────────────────────────┘
```

### Why split host and server processes?

Real MCP Apps run cross‑origin — the iframe is typically served *from the
server origin* while the host is an entirely different app. Running them on
different ports (3000 host, 4000 server) forces us to solve the real problems
(CORS, cross‑origin postMessage, iframe `src` pointing at the server) rather
than papering over them.

---

## 4. The conversation flow, step by step

1. User types *"Send Babak a message in Teams"* into the composer.
2. Host's fake LLM layer (a hard‑coded router, since we're not calling a real
   model) matches the intent and calls
   `client.callTool({ name: 'send_teams_message', arguments: { to: 'Babak Shammas' } })`.
3. Server looks up the tool definition. Because it declares
   `_meta.ui.resourceUri: 'ui://teams-composer/v1'`, the server:
   - returns a `content: [{ type: 'resource', resource: { uri: 'ui://teams-composer/v1', mimeType: 'text/html;profile=mcp-app', text: '<!doctype html>…' } }]`
   - also returns structured `content: [{ type: 'text', text: 'The message is ready for you to review.' }]` so non‑UI hosts still get something readable (the tiny grey line visible above the widget in the screenshot).
4. Host receives the tool result. `<MCPAppBubble/>` picks out the resource and
   renders `<UIResourceRenderer resource={…} onUIAction={…} />`. Under the
   hood this creates `<iframe sandbox="allow-scripts" srcdoc={html}/>` and
   wires `postMessage`.
5. Host sends `ui/initialize` into the iframe with:
   - `toolInput` (the `{ to: 'Babak Shammas' }` we called with),
   - `hostContext` (theme `light|dark`, Teams‑ish CSS vars, locale `en-US`, viewport size),
   - `capabilities` (which `ui/*` methods the host will honour).
6. Widget `<body>` boots, replies with `ui/initialized`, paints itself using
   the theme vars, pre‑fills **To:** with "Babak Shammas".
7. User edits the body (TipTap or ProseMirror‑lite rich text), hits **Send**.
   Widget calls
   `bridge.callTool({ name: 'send_message', arguments: { to: 'babak@contoso.com', html: '…' } })`.
8. Host's `AppBridge` receives the iframe's `tools/call`, proxies it to the
   MCP server over the normal client, gets the response, and returns it to
   the iframe via `postMessage` acknowledgement.
9. Widget renders a "Sent ✓" state and sends `ui/notifications/size-changed`
   so the host can shrink the bubble.
10. Widget optionally sends `ui/message` = *"I sent the message to Babak."* so
    the host adds an assistant bubble below it for continuity.

The **Open** button sends `ui/open-link` with the deep link
`https://teams.microsoft.com/l/chat/0/0?users=babak@contoso.com`, which the
host opens in a new tab after a user‑gesture confirmation dialog.

---

## 5. Repository layout

```
mcp-app-example/
├─ plan.md                                # this file
├─ package.json                           # pnpm workspace root
├─ pnpm-workspace.yaml
├─ README.md                              # run instructions
│
├─ packages/
│  ├─ host/                               # Next.js 15 (App Router), :3000
│  │  ├─ app/
│  │  │  ├─ layout.tsx
│  │  │  ├─ page.tsx                      # the full-screen chat
│  │  │  └─ api/mcp/route.ts              # optional proxy to hide CORS
│  │  ├─ components/
│  │  │  ├─ ChatShell.tsx                 # Teams-like frame
│  │  │  ├─ MessageList.tsx
│  │  │  ├─ MessageBubble.tsx
│  │  │  ├─ Composer.tsx
│  │  │  └─ MCPAppBubble.tsx              # wraps UIResourceRenderer
│  │  ├─ lib/
│  │  │  ├─ mcpClient.ts                  # @modelcontextprotocol/sdk client
│  │  │  ├─ intentRouter.ts               # hard-coded LLM stand-in
│  │  │  └─ theme.ts                      # Teams-ish tokens
│  │  └─ styles/globals.css
│  │
│  ├─ server/                             # MCP server, Express, :4000
│  │  ├─ src/
│  │  │  ├─ index.ts                      # wires Streamable HTTP transport
│  │  │  ├─ tools/
│  │  │  │  ├─ sendTeamsMessage.ts        # returns UI resource
│  │  │  │  ├─ sendMessage.ts             # called from iframe
│  │  │  │  └─ searchRecipients.ts        # typeahead for To: chip
│  │  │  ├─ resources/
│  │  │  │  └─ teamsComposer.ts           # builds ui://teams-composer/v1
│  │  │  ├─ graph/
│  │  │  │  ├─ GraphClient.ts             # interface
│  │  │  │  └─ graphMock.ts               # in-memory impl
│  │  │  └─ data/recipients.json          # ["Babak Shammas", …]
│  │  └─ tsconfig.json
│  │
│  └─ widget/                             # the iframe'd composer UI
│     ├─ index.html                       # built into a single-file bundle
│     ├─ src/
│     │  ├─ main.ts                       # AppBridge wiring
│     │  ├─ Composer.tsx                  # the visible UI (React or Preact)
│     │  ├─ RecipientChip.tsx
│     │  ├─ RichTextEditor.tsx            # TipTap StarterKit
│     │  ├─ SendButton.tsx
│     │  └─ theme.ts                      # consumes host-context-changed vars
│     ├─ vite.config.ts                   # uses vite-plugin-singlefile
│     └─ tsconfig.json
│
└─ scripts/
   └─ dev.mjs                             # spawns server + host + widget build watcher
```

Rationale for three packages:

- **widget** is a standalone build that produces a single `dist/widget.html`
  the server reads at startup and embeds in the `ui://` resource's `text`
  field. This is exactly the pattern the vanilla‑JS example uses
  (`vite + vite-plugin-singlefile`), keeps the resource payload self‑contained,
  and lets the widget be iterated on with HMR independently.
- **server** re‑exports that single file. No runtime dependency on the widget
  build system, only a build‑time file read.
- **host** never imports widget source. It only knows the protocol.

---

## 6. MCP server — tools and resource

### 6.1 Tool: `send_teams_message` (the UI‑returning one)

```ts
// packages/server/src/tools/sendTeamsMessage.ts
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const widgetHtml = readFileSync(
  path.resolve(__dirname, '../../../widget/dist/widget.html'),
  'utf8',
);

export const sendTeamsMessage = {
  name: 'send_teams_message',
  title: 'Send a message in Teams',
  description:
    'Opens a Teams-style composer so the user can review and send a chat message. ' +
    'Use when the user asks to message someone in Teams.',
  inputSchema: z.object({
    to: z.string().describe('Display name or email of the recipient'),
    draftBody: z.string().optional(),
  }),
  _meta: {
    ui: {
      resourceUri: 'ui://teams-composer/v1',
      permissions: { clipboardRead: false, clipboardWrite: true },
      preferredSize: { width: 360, height: 480 },
      csp: { resourceDomains: ['https://res.cdn.office.net'] }, // avatars
    },
  },
  async handler({ to, draftBody }) {
    return {
      content: [
        { type: 'text', text: 'The message is ready for you to review.' },
        {
          type: 'resource',
          resource: {
            uri: 'ui://teams-composer/v1',
            mimeType: 'text/html;profile=mcp-app',
            text: widgetHtml,
          },
        },
      ],
      structuredContent: { to, draftBody: draftBody ?? '' }, // streamed to widget as tool-input
    };
  },
};
```

### 6.2 Tool: `send_message` (iframe‑initiated, the actual side effect)

```ts
// packages/server/src/tools/sendMessage.ts
import { z } from 'zod';
import type { GraphClient } from '../graph/GraphClient';

export const sendMessage = (graph: GraphClient) => ({
  name: 'send_message',
  title: 'Send a Teams chat message',
  description: 'Internal — posts a message via Microsoft Graph.',
  inputSchema: z.object({
    to: z.string().email(),
    html: z.string(),
  }),
  _meta: { ui: { hidden: true } },          // not shown in LLM tool lists
  async handler({ to, html }) {
    const res = await graph.sendChatMessage({ to, contentType: 'html', body: html });
    return {
      content: [{ type: 'text', text: `Sent (id=${res.id})` }],
      structuredContent: res,
    };
  },
});
```

### 6.3 Tool: `search_recipients`

Returns `[{ displayName, email, avatarUrl }]` filtered from `recipients.json`.
Called by the widget whenever the user types in the **To:** chip.

### 6.4 Transport

Use the reference `@modelcontextprotocol/sdk` **Streamable HTTP** transport
(`/mcp` endpoint, POST for requests, SSE for server → client). Enable CORS
for `http://localhost:3000`. No auth — this is a local demo; flag a TODO
noting that production deploys need the standard MCP auth flow.

### 6.5 Graph mock

```ts
// packages/server/src/graph/graphMock.ts
export const graphMock: GraphClient = {
  async sendChatMessage({ to, body }) {
    console.log(`[graph-mock] → ${to}: ${body.slice(0, 60)}…`);
    await new Promise(r => setTimeout(r, 400));     // simulate network
    return { id: `msg_${Date.now()}`, to, sentAt: new Date().toISOString() };
  },
  async searchPeople(query) { /* filters recipients.json */ },
};
```

Swap point documented in `README.md`:

> Replace `graphMock` with a thin wrapper over
> `@microsoft/microsoft-graph-client` using an `AuthenticationProvider` that
> yields an MSAL token with the `ChatMessage.Send` scope. No other file
> changes required.

---

## 7. The widget (the "Send a message in Teams" UI)

### 7.1 Visual spec (matches the screenshot)

- 360×~480px card, rounded 8px, 1px border `#E1E1E1`, subtle shadow.
- Header row: speech‑bubble icon + title **"Send a message in Teams"**.
- Right side of header: **Open** (ghost) and **Send** (primary purple `#5B5FC7`) buttons.
- **To:** label + recipient chip with avatar circle + display name + × remove.
  Clicking the chip area again opens a typeahead (calls `search_recipients`).
- Rich text toolbar: **B**, *I*, <u>U</u>, ~~S~~, bulleted list, numbered list,
  (truncated more menu).
- Body area: TipTap with StarterKit (bold/italic/underline/strike/lists).
  Pre‑filled with the lorem ipsum placeholder from the screenshot only when
  `draftBody` is empty, and only as a placeholder — not real text.
- Emoji picker button bottom‑right of the body.

### 7.2 Bridge wiring

```ts
// packages/widget/src/main.ts
import { App } from '@modelcontextprotocol/ext-apps';

const app = new App();

app.onInitialize(({ toolInput, hostContext, capabilities }) => {
  applyTheme(hostContext.theme, hostContext.styleVariables);
  ui.setRecipient(toolInput.to);
  ui.setBody(toolInput.draftBody);
});

app.onHostContextChanged(ctx => applyTheme(ctx.theme, ctx.styleVariables));

ui.on('send', async ({ to, html }) => {
  const result = await app.callTool({
    name: 'send_message',
    arguments: { to, html },
  });
  if (result.isError) ui.showError(result.content[0].text);
  else {
    ui.showSent();
    app.sendMessage({ text: `I sent the message to ${to}.` });
    app.requestTeardown();                        // collapse bubble
  }
});

ui.on('open', () => {
  app.openLink({ url: `https://teams.microsoft.com/l/chat/0/0?users=${recipient.email}` });
});

ui.on('resize', size => app.notifySizeChanged(size));

await app.initialize();                            // completes the handshake
```

### 7.3 Build

- Vite + React + `vite-plugin-singlefile` → one `widget.html` (HTML + inlined
  CSS + inlined JS).
- No external network requests at boot, so the resource works under the
  strictest CSP the host picks.
- Dev mode: `pnpm --filter widget dev` serves at `:5173` and the server, when
  `NODE_ENV=development`, reads from that URL via `externalUrl` instead of
  the built file, so HMR works end‑to‑end.

---

## 8. The host (chatbot) — rendering the MCP app

### 8.1 Dependencies

- `next@15` (App Router, RSC off for the chat page — pure client)
- `@modelcontextprotocol/sdk` (MCP client, Streamable HTTP transport)
- `@mcp-ui/client` **or** `@modelcontextprotocol/ext-apps/app-bridge`
  → start with `@mcp-ui/client`'s `<UIResourceRenderer/>`; it already handles
  sandboxing, postMessage routing, and `onUIAction`. Document the decision
  tree for switching to `AppBridge` directly if we need finer control.
- `tailwindcss` for styling (Teams‑like tokens).
- `lucide-react` for icons.

### 8.2 MCPAppBubble.tsx

```tsx
import { UIResourceRenderer } from '@mcp-ui/client';
import { mcpClient } from '@/lib/mcpClient';

export function MCPAppBubble({ resource, toolName, toolInput, toolResult }: Props) {
  return (
    <div className="rounded-lg border bg-white shadow-sm my-2 max-w-sm">
      <UIResourceRenderer
        resource={resource}
        toolName={toolName}
        toolInput={toolInput}
        toolResult={toolResult}
        sandbox="allow-scripts allow-forms"
        onUIAction={async (action) => {
          switch (action.type) {
            case 'tool':
              return mcpClient.callTool(action.payload);        // proxy tools/call
            case 'link':
              if (confirm(`Open ${action.payload.url}?`)) window.open(action.payload.url);
              return { ok: true };
            case 'prompt':                                      // ui/message
              appendAssistantMessage(action.payload.text);
              return { ok: true };
            case 'size-change':
              return { ok: true };                              // CSS grid handles it
            default:
              return { ok: false, error: 'unsupported' };
          }
        }}
      />
    </div>
  );
}
```

### 8.3 Intent router (LLM stand‑in)

No real model in v1. A 20‑line regex router maps user messages to tool calls:

| User says | Tool call |
|---|---|
| `/^(send|message)\s+(.+?)\s+(in|on|via)\s+teams/i` | `send_teams_message { to: "$2" }` |
| `/hi|hello|hey/i` | plain reply "Hi! Try 'send Babak a message in Teams.'" |

This is intentional — the user asked for hard‑coded data. A `TODO: LLM` block
notes where the real model call would go (e.g. `@anthropic-ai/sdk` with tool
use). Keeping it deterministic makes the demo reliable for screen recordings.

### 8.4 Teams‑like styling

- Header bar: `#F5F5F5` background, "Chat" title, recipient avatar placeholder.
- User bubbles: right‑aligned, `#E8EBFA`, 14px, rounded.
- Assistant bubbles: left‑aligned, `#F5F5F5`, 14px, rounded.
- Composer: bottom‑pinned, rounded input, send arrow on the right.
- Font stack: `"Segoe UI", system-ui, sans-serif`.

---

## 9. Host ↔ widget protocol in practice

### 9.1 Handshake (host initiates)

```jsonc
// host → iframe
{
  "jsonrpc": "2.0", "id": 1, "method": "ui/initialize",
  "params": {
    "protocolVersion": "2026-01-26",
    "toolName": "send_teams_message",
    "toolInput": { "to": "Babak Shammas" },
    "toolResult": null,
    "hostContext": {
      "theme": "light",
      "locale": "en-US",
      "styleVariables": { "--mcp-accent": "#5B5FC7", "--mcp-surface": "#FFFFFF" },
      "capabilities": {
        "tools": true, "openLink": true, "message": true, "downloadFile": false
      }
    }
  }
}
```

```jsonc
// iframe → host
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2026-01-26" } }
{ "jsonrpc": "2.0", "method": "ui/initialized", "params": {} }
```

### 9.2 Iframe invokes a tool

```jsonc
// iframe → host
{
  "jsonrpc": "2.0", "id": 42, "method": "tools/call",
  "params": {
    "name": "send_message",
    "arguments": { "to": "babak@contoso.com", "html": "<p>Hi Babak…</p>" }
  }
}
```

Host proxies to MCP server over the already‑open session, then:

```jsonc
// host → iframe
{
  "jsonrpc": "2.0", "id": 42,
  "result": {
    "content": [{ "type": "text", "text": "Sent (id=msg_1713)" }],
    "structuredContent": { "id": "msg_1713", "sentAt": "..." }
  }
}
```

### 9.3 Size change

```jsonc
{ "jsonrpc": "2.0", "method": "ui/notifications/size-changed",
  "params": { "width": 360, "height": 120 } }
```

Host clamps to `max-width: 420px` and animates the height change.

---

## 10. Implementation milestones

Each milestone ends with a runnable, demo‑able state. Estimates assume one
engineer familiar with Next.js + MCP SDKs; ~3–4 days end‑to‑end.

**M1 — Walking skeleton (½ day)**
- Workspace scaffolded, three packages boot, README dev instructions work.
- Host renders an empty Teams‑shaped chat with a hard‑coded "Hello" bubble.
- Server exposes a trivial `echo` tool and passes `npx @modelcontextprotocol/inspector`.

**M2 — Chat loop with plain‑text tool call (½ day)**
- Intent router wired.
- `send_teams_message` tool returns a *text‑only* stub ("would open composer").
- Round‑trip works: user sends message → assistant bubble with stub text.

**M3 — UI resource & iframe rendering (1 day)**
- Widget package boots with a static "hello from widget" HTML.
- Server returns UI resource pointing at the built `widget.html`.
- Host renders it via `<UIResourceRenderer/>`.
- `ui/initialize` handshake completes, widget reads `toolInput.to` and displays it.

**M4 — Real composer UI (1 day)**
- TipTap editor, recipient chip, Open/Send buttons, theme vars from host.
- `search_recipients` typeahead wired.
- Visual parity with the reference screenshot (spot‑check against image).

**M5 — Side effect via iframe tool call (½ day)**
- Widget calls `send_message`, host proxies to server, Graph mock logs the send.
- Sent state + `ui/message` follow‑up assistant bubble + `ui/request-teardown`.

**M6 — Polish (½ day)**
- `ui/open-link` confirm dialog.
- Error paths (Graph 500, invalid recipient, widget load failure).
- Dark mode toggle in host drives `host-context-changed` notifications.
- README with GIF.

---

## 11. Testing strategy

| Layer | How |
|---|---|
| MCP server tools | `vitest` + MCP SDK's in‑memory transport; assert tool schemas, resource MIME, `_meta.ui.resourceUri`. |
| Widget logic | `vitest` + jsdom; mock `window.parent.postMessage`, assert correct JSON‑RPC frames sent on Send click. |
| Host ↔ server integration | Spin both processes in a `playwright` test; mount the widget and assert a message landed in the Graph mock's in‑memory log. |
| Spec conformance | Run `npx @modelcontextprotocol/inspector` against the server — it includes an MCP Apps tab that dry‑runs the handshake. |

---

## 12. Security considerations (called out explicitly because iframes)

1. **Sandbox attributes**: `allow-scripts` is always set. `allow-same-origin`
   is added **only when the widget is served cross‑origin from the host**
   (our case: host at `:3000`, widget at `:4100`). The reasoning:
   - Without `allow-same-origin`, a sandboxed iframe is assigned a unique
     *opaque* origin (`"null"`). Messages from it arrive with
     `event.origin === "null"`, and `postMessage(frame, targetOrigin)` calls
     from the host will silently drop unless targeted at `"*"`. That forces
     the host into `targetOrigin: "*"`, which is the exact thing we're trying
     to avoid — it would let any frame that happens to be on the page receive
     the message.
   - With `allow-same-origin` *plus a genuinely different server origin*
     (`http://localhost:4100` vs. `http://localhost:3000`), the iframe keeps
     its real origin, so the host can use strict `targetOrigin:
     "http://localhost:4100"` on every send, and browsers' same‑origin policy
     still prevents the iframe from reading the host's cookies or DOM.
   - `allow-same-origin` is **forbidden** when the widget is served from the
     *same* origin as the host (e.g. `srcdoc` or a `/widget` path on the host
     server). In that case it really would grant the widget read access to
     the host's cookies/DOM, and we must fall back to `targetOrigin: "*"`
     combined with strict `event.source` identity checks and structural
     validation of the frame body.
   Current code (`host/public/chat.js`) always sets `allow-same-origin`
   because this demo always serves the widget cross‑origin.
   Additional flags used: `allow-forms` (Enter‑to‑submit inside the
   composer), `allow-popups` + `allow-popups-to-escape-sandbox`
   (`ui/open-link` opens the Teams deep link in an unsandboxed tab).
2. **Origin check**: The `postMessage` listener validates `event.origin`
   against the expected iframe origin (server origin in prod, blob URL in
   srcdoc mode). `@mcp-ui/client` handles this; document the check in code
   comments so it isn't removed.
3. **Tool allowlist**: The host only proxies `tools/call` for tools the server
   actually advertised *and* whose `_meta.ui.hidden` is not true — except we
   do allow `send_message` despite `hidden: true` because the widget belongs
   to the same server. Tighter rule: a widget from `ui://teams-composer/v1`
   can only call tools from that *same server*. Cross‑server tool calls from
   an iframe are rejected.
4. **Open‑link prompts**: Any `ui/open-link` shows a one‑click confirm modal
   the first time per domain per session. Prevents a malicious widget from
   silently navigating the user away.
5. **CSP**: The widget's HTML ships with `Content-Security-Policy: default-src 'self' 'unsafe-inline'; img-src * data: https://res.cdn.office.net` —
   inline is unavoidable because the resource *is* the HTML; external sources
   restricted to what we declared in `_meta.ui.csp.resourceDomains`.
6. **Graph credentials (future)**: when the mock is swapped out, tokens live
   on the server only. The widget never sees them — it calls the `send_message`
   tool by name and the server attaches the token server‑side.

---

## 13. Open questions / decisions deferred

1. **`@mcp-ui/client` vs. raw `AppBridge`.** Start with `@mcp-ui/client` for
   ergonomics. Revisit if we need `sandbox-proxy-ready` / custom teardown
   semantics the wrapper doesn't expose.
2. **Real LLM.** The intent router is a stub. Plugging in `@anthropic-ai/sdk`
   with tool‑use is a follow‑up; it does not change the MCP surface.
3. **Persistence.** Demo is in‑memory. If we need chat history across reloads,
   add `localStorage` on the host and an in‑memory store on the Graph mock.
4. **Multi‑turn widget state.** The current design tears the widget down on
   Send. If product wants "keep the composer open to send another," switch
   to persisted mode and remove the `requestTeardown()` call.
5. **Accessibility.** TipTap + buttons get keyboard navigation for free; need
   to verify focus trap inside the iframe and visible focus rings against the
   Teams accent colour.

---

## 14. Definition of done

- `pnpm install && pnpm dev` in `mcp-app-example/` brings up host, server,
  and widget watcher.
- Opening `http://localhost:3000`, typing "send Babak a message in Teams",
  pressing Enter renders the composer widget inline in the chat, pixel‑close
  to the reference screenshot.
- Clicking **Send** in the widget logs the message body in the server console
  (Graph mock), shows a "Sent ✓" state, and appends an assistant bubble below
  saying "I sent the message to Babak."
- `npx @modelcontextprotocol/inspector` against `http://localhost:4000/mcp`
  lists both tools and can render the widget in its MCP Apps pane.
- README documents: how to run, the file map, how to swap the Graph mock.
