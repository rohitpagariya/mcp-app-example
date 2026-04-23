# MCP App Example — "Send a message in Teams"

A runnable demo of the **MCP Apps** pattern: a Teams-styled chatbot renders a
rich interactive widget returned by an MCP tool as a `ui://` resource, and the
widget calls back through the MCP Apps postMessage bridge to invoke a second
tool that (mock-)sends the message via Microsoft Graph.

See `plan.md` for the full design notes.

## Quick start

```sh
# 1. Install both packages
cd server && npm install && cd ..
cd host   && npm install && cd ..

# 2. Start the MCP server (port 4100)
cd server && npm start

# 3. In a second terminal, start the host (port 3000)
cd host && npm start

# 4. Open http://localhost:3000 and type: "Send Babak a message in Teams"
```

## What to look for

- The assistant responds with a **"The message is ready for you to review."**
  bubble followed by the Teams-composer widget rendered **inside a sandboxed
  iframe**.
- The iframe origin is `http://localhost:4100` — a real cross-origin embed.
- Typing, toggling bold, and clicking **Send** stays entirely inside the
  widget; no host-side clicks.
- Clicking **Send** fires a `tools/call` over `postMessage`; the host proxies
  it to the MCP server's `send_message` tool, which logs the body through the
  in-memory Graph mock.
- After success the widget shows "Sent ✓" and pushes a `ui/message` that
  appears as a new assistant bubble.

## Layout

```
mcp-app-example/
├── plan.md
├── README.md
├── server/         # :4000  MCP JSON-RPC server + widget.html
└── host/           # :3000  Teams-styled chat UI + MCP client bridge
```

## Swapping the Graph mock for real Graph

`server/src/graphMock.js` implements a tiny `GraphClient` interface. Replace
it with a wrapper over `@microsoft/microsoft-graph-client` using an MSAL auth
provider that yields a token with the `ChatMessage.Send` scope. No other files
need to change.

## End-to-end smoke test (optional)

`e2e/run.mjs` drives the demo with Puppeteer and asserts the widget loads,
handshakes, sends, and the follow-up assistant bubble appears.

It connects to an **already-running** Chrome with remote debugging enabled —
it does not launch its own browser. Start Chrome yourself first:

```sh
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Then, with both `server` and `host` running:

```sh
cd e2e && npm install && node run.mjs
```

Screenshots land in `e2e/artifacts/`.
