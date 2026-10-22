# Botara Webchat Widget

Botara's website chat is **self-built**: Meta's Customer Chat Plugin retired
on 2024-05-09 with no replacement, so Botara ships its own widget, its own
visitor-session model, and its own storage. Nothing about webchat depends on
a Meta product.

## Embed on a website

Paste this snippet before `</body>` on any page (replace `DOMAIN` and the
workspace id):

```html
<script src="https://DOMAIN/widget.js"
        data-workspace-id="YOUR_WORKSPACE_ID"
        data-api-url="https://DOMAIN/api"
        data-title="Chat dengan kami"
        async></script>
```

- `data-workspace-id` — the Botara workspace that receives the chats
  (required).
- `data-api-url` — base URL of the Botara API the widget talks to (required).
- `data-title` — optional header text inside the chat panel.

The widget renders a floating bubble. On first open it creates a visitor
session, and it polls for agent replies every 3 seconds while open.

## How it works

| Piece | Where |
|---|---|
| Widget bundle | `apps/web/src/widget.ts` → built to `dist/widget.js` (standalone IIFE, no framework) |
| Public API | `POST /public/webchat/:workspaceId/session`, `POST /public/webchat/:workspaceId/messages`, `GET /public/webchat/:workspaceId/messages` |
| Session model | `webchat_sessions` table: secret token → contact + conversation |
| Agent side | The normal Botara inbox; webchat is a first-class channel (`channel = "webchat"`) |

### Session and identity model

1. `POST .../session` creates (on first use) the workspace's webchat channel
   account, a contact whose `externalId` is `webchat-session:{sessionId}`,
   a conversation, and a session row holding a random 256-bit token.
2. The widget stores the token in `localStorage` and sends it as the
   `x-webchat-session` header on every send/poll. The token is the visitor's
   only credential — it never appears in conversation lists or URLs (the
   session *id* does, via the contact externalId).
3. Visitor messages are validated (1–2000 chars) and rate-limited per
   session (30 messages/minute), appended as inbound messages, and update
   the conversation's `last_user_message_at`.
4. Agent replies from the inbox go through the channel adapter contract:
   the API wires a DB-backed `WebchatStore` so a reply is appended to the
   session's conversation as an outbound message, which the widget renders
   on its next poll.

Webchat has no messaging window (it is not a Meta channel), so agents can
reply at any time.

## Operational notes

- The widget polls; there is no push in Fase 2. The realtime WebSocket
  server can carry webchat events in a later phase.
- Sessions do not expire in Fase 2. If a token stops working (session row
  deleted), the widget clears it and creates a fresh session on next open.
- Rate limiting is per-process in-memory in the API — sufficient for a
  single-instance deployment; move it to Redis when the API scales out.
