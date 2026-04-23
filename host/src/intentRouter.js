// Deterministic "LLM stand-in": maps user text to a tool call.
// Keeping this rule-based makes the demo reproducible and shows that the MCP
// Apps contract is independent of whichever model sits above it. Swap for an
// Anthropic/OpenAI tool-use call later without touching the host iframe logic.

const TEAMS_RE = /\b(?:send|message|dm|ping)\b.*?\bteams\b/i;
// Match "...send babak a message..." — grab the recipient token(s) between
// "send/message/dm/ping" and "a message/in teams/on teams".
const RECIPIENT_RE =
  /\b(?:send|message|dm|ping)\s+([a-zA-Z][a-zA-Z0-9._\- ]{1,40}?)\s+(?:a\s+message|in\s+teams|on\s+teams|via\s+teams|teams)/i;

export function routeIntent(userText) {
  const text = (userText || '').trim();
  if (!text) return null;

  if (TEAMS_RE.test(text)) {
    const m = RECIPIENT_RE.exec(text);
    const to = (m?.[1] || 'Babak Shammas').trim();
    return {
      type: 'toolCall',
      toolName: 'send_teams_message',
      arguments: { to },
    };
  }

  if (/^(hi|hello|hey|yo)\b/i.test(text)) {
    return {
      type: 'reply',
      text:
        'Hi! Try typing **"Send Babak a message in Teams"** and I\'ll open a composer widget for you.',
    };
  }

  if (/help|what can you do/i.test(text)) {
    return {
      type: 'reply',
      text:
        'I can open a Teams composer inline. Ask me to *"send &lt;name&gt; a message in Teams"*.',
    };
  }

  return {
    type: 'reply',
    text:
      'I only know one trick — ask me to *"send &lt;someone&gt; a message in Teams"*.',
  };
}
