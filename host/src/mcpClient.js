// Tiny MCP JSON-RPC client that talks to the MCP server over HTTP.
// Real hosts would use @modelcontextprotocol/sdk with the Streamable-HTTP
// transport; we roll our own so the demo has zero runtime dependencies and
// the wire format is visible.

let seq = 1;

export class McpClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.initialized = false;
  }

  async #rpc(method, params) {
    const id = seq++;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const frame = await res.json();
    if (frame.error) {
      const err = new Error(frame.error.message || 'MCP error');
      err.code = frame.error.code;
      err.data = frame.error.data;
      throw err;
    }
    return frame.result;
  }

  async initialize() {
    const r = await this.#rpc('initialize', { protocolVersion: '2026-01-26' });
    this.initialized = true;
    return r;
  }

  listTools() { return this.#rpc('tools/list', {}); }
  callTool(name, args) { return this.#rpc('tools/call', { name, arguments: args }); }
  readResource(uri) { return this.#rpc('resources/read', { uri }); }
}
