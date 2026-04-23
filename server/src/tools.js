// Tool definitions exposed by the MCP server.
//
// `send_teams_message` is the MCP App entrypoint: its response includes a
// resource with mimeType `text/html;profile=mcp-app`, and its description
// carries `_meta.ui.resourceUri` so a host can preload the UI.
//
// `send_message` is the side-effect tool invoked from inside the iframe via
// the MCP Apps postMessage bridge. It is marked `_meta.ui.hidden` so agentic
// LLMs don't call it directly.
//
// `search_recipients` is a lightweight lookup used by the widget's typeahead.

import { graphMock } from './graphMock.js';
import { searchRecipients, resolveRecipient } from './recipients.js';

const TEAMS_COMPOSER_URI = 'ui://teams-composer/v1';

export function buildTools({ widgetBaseUrl, widgetHtml }) {
  return {
    send_teams_message: {
      name: 'send_teams_message',
      title: 'Send a message in Teams',
      description:
        'Opens a Teams-style composer so the user can review and send a chat message. ' +
        'Use when the user asks to message someone in Teams.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Display name or email of the recipient',
          },
          draftBody: {
            type: 'string',
            description: 'Optional initial body for the message',
          },
        },
        required: ['to'],
      },
      _meta: {
        ui: {
          resourceUri: TEAMS_COMPOSER_URI,
          preferredSize: { width: 360, height: 480 },
          permissions: { clipboardWrite: true },
        },
      },
      handler: async ({ to, draftBody }) => {
        const recipient = resolveRecipient(to) || {
          displayName: to,
          email: `${String(to).toLowerCase().replace(/\s+/g, '.')}@contoso.com`,
          initials: String(to).slice(0, 2).toUpperCase(),
          color: '#5B5FC7',
        };
        return {
          // Text content is what a non-UI client (or screen reader) sees — it
          // mirrors the small grey line visible above the card in the Teams
          // reference screenshot.
          content: [
            {
              type: 'text',
              text: 'The message is ready for you to review.',
            },
            {
              type: 'resource',
              resource: {
                uri: TEAMS_COMPOSER_URI,
                mimeType: 'text/html;profile=mcp-app',
                // The host can either inline this text into a sandboxed iframe
                // via `srcdoc`, or (because we also expose the widget at a
                // real URL) set `iframe.src = <externalUrl>` for a cleaner
                // cross-origin sandbox — we return both. Hosts that only
                // support inline `text` content (e.g. Claude, Goose) render
                // directly from here; ones that honor `_meta.ui.externalUrl`
                // (our host) prefer the cross-origin URL so postMessage origin
                // checks have a real server origin to validate.
                text: widgetHtml,
                _meta: {
                  ui: {
                    externalUrl: `${widgetBaseUrl}/widget`,
                  },
                },
              },
            },
          ],
          // Streamed into the iframe as `ui/notifications/tool-input` so the
          // widget can prefill the To: chip without waiting on a user action.
          structuredContent: {
            to: recipient.displayName,
            email: recipient.email,
            initials: recipient.initials,
            color: recipient.color,
            draftBody: draftBody ?? '',
          },
        };
      },
    },

    send_message: {
      name: 'send_message',
      title: 'Send a Teams chat message',
      description:
        '(Internal) Posts a chat message via Microsoft Graph. Invoked from the Teams composer widget.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email' },
          html: { type: 'string', description: 'Message body as HTML' },
        },
        required: ['to', 'html'],
      },
      _meta: { ui: { hidden: true } },
      handler: async ({ to, html }) => {
        const res = await graphMock.sendChatMessage({
          to,
          contentType: 'html',
          body: html,
        });
        return {
          content: [{ type: 'text', text: `Sent (id=${res.id})` }],
          structuredContent: res,
        };
      },
    },

    search_recipients: {
      name: 'search_recipients',
      title: 'Search Teams recipients',
      description: '(Internal) Typeahead over the user\'s Teams contacts.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
      _meta: { ui: { hidden: true } },
      handler: async ({ query }) => {
        const results = searchRecipients(query);
        return {
          content: [{ type: 'text', text: `${results.length} match(es)` }],
          structuredContent: { results },
        };
      },
    },
  };
}

export const RESOURCES = {
  [TEAMS_COMPOSER_URI]: {
    uri: TEAMS_COMPOSER_URI,
    name: 'Teams composer widget',
    mimeType: 'text/html;profile=mcp-app',
  },
};

export { TEAMS_COMPOSER_URI };
