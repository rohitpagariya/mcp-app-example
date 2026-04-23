// In-memory fake of Microsoft Graph. Swap for a thin wrapper around
// @microsoft/microsoft-graph-client in production — the surface below is the
// only thing the MCP server depends on.

const sentLog = [];

export const graphMock = {
  async sendChatMessage({ to, contentType, body }) {
    const entry = {
      id: `msg_${Date.now()}`,
      to,
      contentType,
      body,
      sentAt: new Date().toISOString(),
    };
    sentLog.push(entry);
    console.log(
      `[graph-mock] → ${to} (${contentType}): ${body.replace(/\s+/g, ' ').slice(0, 80)}`,
    );
    // Simulate network latency.
    await new Promise((r) => setTimeout(r, 350));
    return entry;
  },

  getSentLog() {
    return sentLog.slice();
  },
};
