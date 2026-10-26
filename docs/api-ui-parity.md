# API ↔ UI Parity

Every HTTP route Botara exposes is accounted for in exactly one of three
classes:

- **UI** — called by the web client (`apps/web/src/api.ts`), the webchat
  widget (`apps/web/src/widget.ts`), or the SPA (`apps/web/src/App.tsx`,
  `flows/FlowBuilder.tsx`). The "UI location" column names the surface.
- **WEBHOOK** — called by an external provider, or a browser navigation a
  provider initiates (webhook handshakes + events, OAuth callbacks,
  public redirect/status URLs the API mints for the outside world).
- **API-ONLY** — deliberately operator/tooling surface with no SPA caller
  (probes, the OpenAPI document, single-fetch by-id endpoints for API
  consumers).

This table is the human-readable mirror of the machine-readable
classification in `apps/api/src/route-parity.ts`, which only carries the
non-UI rows. The **parity guard test** (`apps/api/src/route-parity.test.ts`)
enumerates the app's real routes and fails when a route is neither
referenced by the web sources nor classified — and also when a
classification entry goes stale (route deleted, or a UI caller appeared).

## How to keep this current

1. Adding a route with a UI caller: nothing to do here beyond using it —
   the guard sees the reference. Update the table in the same change.
2. Adding a route **without** a UI caller: add it to
   `apps/api/src/route-parity.ts` with class + reason in the same change,
   or the guard fails CI. Mirror the row here.
3. Removing a route or adding a UI caller for a classified route: remove
   its classification entry (the guard's stale-entry checks fail until
   you do).

## Parity table (post-fix state, 2026-10-26; #9 rows added 2026-10-27)

141 routes: 113 UI · 18 WEBHOOK · 10 API-ONLY.

### Auth & session

| Route | Class | UI location / reason |
|---|---|---|
| POST /auth/register | UI | Auth page |
| POST /auth/login | UI | Auth page |
| POST /auth/logout | UI | Sidebar |
| GET /auth/me | UI | Session bootstrap (AuthedApp) |
| PATCH /auth/me | UI | Settings → Profile |
| POST /auth/change-password | UI | Settings → Profile |
| GET /auth/tokens | UI | Settings → API tokens |
| POST /auth/tokens | UI | Settings → API tokens |
| DELETE /auth/tokens/{} | UI | Settings → API tokens |

> Adoption #5 (scoped API tokens): the token routes themselves are
> unchanged, but POST /auth/tokens now also accepts `workspaceId`,
> `scopes`, and `expiresAt`, and GET /auth/tokens returns those fields
> in its metadata. The Settings form drives all of them. Semantics:
> [api-tokens.md](api-tokens.md).

### Workspaces & members

| Route | Class | UI location / reason |
|---|---|---|
| GET /workspaces | UI | Workspace switcher |
| POST /workspaces | UI | Workspace switcher → "+ New workspace" (F7) |
| PATCH /workspaces/{} | UI | Settings → Workspace (rename + default currency, package #6) |
| GET /workspaces/{}/members | UI | Settings → Members (rows carry `online` presence, #9); Inbox assignee picker |
| POST /workspaces/{}/members | UI | Settings → Members (invite) |
| PATCH /workspaces/{}/members/{} | UI | Settings → Members (role) |
| DELETE /workspaces/{}/members/{} | UI | Settings → Members (remove) |
| POST /workspaces/{}/invites | UI | Settings → Members → Invite link (create; raw token returned once) |
| GET /workspaces/{}/invites | UI | Settings → Members → Invite link (list; fragments only) |
| DELETE /workspaces/{}/invites/{} | UI | Settings → Members → Invite link (revoke) |
| POST /workspaces/{}/transfer-ownership | UI | Settings → Members (owner-only row action) |
| GET /invites/{} | UI | SPA `/invite/:token` landing (public preview, no member data) |
| POST /invites/{}/accept | UI | SPA `/invite/:token` landing (explicit Accept click) |

> Adoption #9 (invite-by-link + presence + ownership transfer): the
> invite routes are ordinary workspace routes for scoped tokens
> (`settings:read|write` via the `/workspaces/{}` prefix rule); the two
> public `/invites/{}` routes are session/public surface (`none` in
> route-scopes — restricted API tokens can never preview or accept).
> Semantics: [workspace-members.md](workspace-members.md).

### Conversations, contacts, moderation

| Route | Class | UI location / reason |
|---|---|---|
| GET /conversations | UI | Inbox list |
| GET /conversations/{}/messages | UI | Inbox thread |
| POST /conversations/{}/reply | UI | Inbox composer |
| PATCH /conversations/{}/assign | UI | Inbox header assignee select |
| PATCH /conversations/{}/status | UI | Inbox header status select |
| POST /conversations/{}/ai-suggest | UI | Inbox composer "AI suggest" (F4) — fills the draft, never auto-sends; honest 503 toast when no AI provider is configured |
| POST /conversations/{}/ai-analyze | UI | Inbox AI strip "Analyze"/"Refresh" (package #7) — persists summary + intent on the conversation; 503 toast when unconfigured, 502 toast on malformed model output (nothing saved) |
| POST /conversations/{}/ai-pause | UI | Inbox AI strip "Pause AI" (package #7) — pauses AUTOMATIC AI sends (flow ai_reply) on the thread; agent tools stay available |
| POST /conversations/{}/ai-resume | UI | Inbox AI strip "Resume AI" (package #7) — clears the takeover pause |
| POST /conversations/{}/notes | UI | Inbox composer Note mode (package #2) — internal timeline notes, never sent |
| GET /saved-replies | UI | Inbox composer saved-replies picker (package #2) |
| POST /saved-replies | UI | Saved-replies picker → New form |
| PATCH /saved-replies/{} | UI | Saved-replies picker → Edit form |
| DELETE /saved-replies/{} | UI | Saved-replies picker → per-item Delete |
| POST /moderation/check | UI | Inbox composer "Check" (F9). Behind session auth + the utility rate limit since the parity fix (B2) — it was a public, unmetered endpoint before |
| GET /contacts | UI | Contacts table |
| POST /contacts | UI | Contacts → "Add contact" (F3) |
| GET /contacts/{} | UI | Contact editor data load (F1; 404 cross-workspace) |
| PATCH /contacts/{} | UI | Shared ContactEditModal (Contacts row Edit + Inbox header Edit, F1). Custom fields merge key-wise server-side — removing a field row in the editor does **not** delete that key; there is no field-delete in the API |
| GET /contacts/export | UI | Contacts → Export CSV/JSON |
| POST /contacts/import | UI | Contacts → Import |
| GET /segments | UI | Contacts segment chips with per-tag counts (F8) |

The conversation payload also carries `contactId` and `contactTags`
(B4): the Inbox header renders the contact's tags as chips and edits the
same contact the Contacts page edits.

### Channels & email domains

| Route | Class | UI location / reason |
|---|---|---|
| GET /channels/accounts | UI | Channels cards; Publish/Broadcast account pickers |
| DELETE /channels/accounts/{} | UI | Channels card Disconnect / Delete permanently. Without data references the account is hard-deleted; with history it soft-disconnects (status `disconnected`, data kept, vault entry revoked); `?purge=true` permanently deletes a disconnected account. See the retention note below |
| GET /channels/accounts/{}/avatar | UI | Channels card avatar (Telegram proxy — token-bearing URLs never reach the browser) |
| POST /channels/telegram/connect | UI | Channels connect modal → Telegram card |
| POST /channels/whatsapp/embedded-signup/exchange | UI | Channels connect modal → WhatsApp card |
| GET /channels/messenger/pending-pages | UI | Channels connect modal (Page picker) |
| POST /channels/messenger/select-page | UI | Channels connect modal (Page picker) |
| GET /channels/messenger/oauth/start | UI | Channels connect modal (browser navigation link) |
| GET /channels/instagram/oauth/start | UI | Channels connect modal (browser navigation link) |
| GET /channels/threads/oauth/start | UI | Channels connect modal (browser navigation link) |
| GET /channels/tiktok/oauth/start | UI | Channels connect modal (browser navigation link) |
| GET /channels/messenger/oauth/callback | WEBHOOK | Meta redirects the browser here after consent |
| GET /channels/instagram/oauth/callback | WEBHOOK | Meta redirects the browser here after consent |
| GET /channels/threads/oauth/callback | WEBHOOK | Meta redirects the browser here after consent |
| GET /channels/tiktok/oauth/callback | WEBHOOK | TikTok redirects the browser here after consent |
| GET /channels/email/domains | UI | Channels connect modal → Email domains card (F2) |
| POST /channels/email/domains | UI | Email domains card → Add domain |
| DELETE /channels/email/domains/{} | UI | Email domains card → Delete |
| GET /channels/{}/catalog | UI | Channels → WhatsApp catalog summary |
| POST /channels/{}/catalog/sync | UI | Channels → Sync catalog |
| GET /catalog-products | UI | Inbox product picker; Flows rich blocks |

Email domains (F2): the API exposes domain registration only — a domain
row (domain, optional email channel account, optional Resend domain id,
status `pending`/`verified`). There is no separate "email account"
provisioning endpoint; email accounts come into being via Resend
inbound routing / channel configuration, so the card manages exactly
the domain resource the routes define. DNS records are managed in
Resend; the status shown is the stored verification state.

### Broadcasts & templates

| Route | Class | UI location / reason |
|---|---|---|
| POST /broadcasts/estimate | UI | Broadcast → Estimate cost. The one documented auth-middleware bypass: a pure calculator over the request body, no workspace data |
| POST /broadcasts | UI | Broadcast → Create broadcast |
| GET /broadcasts | UI | Broadcast history list (F5) — added by the parity fix; rows carry delivery counts + realized cost |
| GET /broadcasts/{} | UI | Broadcast history → expandable detail (F5) |
| GET /broadcasts/{}/recipients | UI | Broadcast detail → per-recipient delivery records with status filter + per-status counts (package #4) |
| POST /broadcasts/{}/resend-failed | UI | Broadcast detail → "Resend to failed" re-queues only the failed recipients (package #4) |
| GET /templates | UI | Broadcast form + template manager (F6); Inbox template replies |
| POST /templates | UI | Broadcast → Template manager register form (F6). Fields match the API schema exactly: channelAccountId, name, language?, category?, externalId? |
| PATCH /templates/{}/category | UI | Template manager → per-template category correction (F6) |

### Deals & pipelines (package #6)

| Route | Class | UI location / reason |
|---|---|---|
| GET /pipelines | UI | Deals → pipeline switcher (stages embedded) |
| POST /pipelines | UI | Deals → "New pipeline" (default-stages option) |
| PATCH /pipelines/{} | UI | Deals → rename / "Make default" |
| DELETE /pipelines/{} | UI | Deals → "Delete pipeline" (409 with deals; `?force=true` after confirm) |
| GET /pipelines/{}/summary | UI | Deals → board header totals + column counts |
| POST /pipelines/{}/stages | UI | Deals → stage manager "Add stage" |
| PATCH /pipelines/{}/stages/{} | UI | Deals → stage manager rename |
| DELETE /pipelines/{}/stages/{} | UI | Deals → stage manager delete (409 while deals sit in it) |
| POST /pipelines/{}/stages/reorder | UI | Deals → stage manager move up/down |
| GET /deals | UI | Deals → board (filtered by pipelineId) |
| POST /deals | UI | Deals → "New deal" form |
| GET /deals/{} | API-ONLY | Single-deal fetch for API consumers; the SPA reads deals board-wide via GET /deals and mutates by id |
| PATCH /deals/{} | UI | Deals → card stage picker, drag-and-drop, status actions, edit form |
| DELETE /deals/{} | UI | Deals → card delete |

### Publish (scheduled posts)

| Route | Class | UI location / reason |
|---|---|---|
| GET /posts | UI | Publish list |
| POST /posts | UI | Publish composer |
| GET /posts/{} | API-ONLY | Single-post fetch for API consumers; the SPA lists posts and mutates via PATCH / publish-now on the same path |
| PATCH /posts/{} | UI | Publish → Edit (F10, prefilled form; targets are editable too) |
| DELETE /posts/{} | UI | Publish → Delete |
| POST /posts/{}/publish-now | UI | Publish → Publish now |

**Telegram publish semantics (item H):** Telegram accounts are *bots*,
and a bot cannot post to itself — so a post target for a telegram
account must name the destination channel chat as `targetExternalId`
(chat ID or @username; the API rejects telegram targets without one,
400). The Publish page shows a required destination input per selected
telegram account, with the hint that the bot must be an **admin of that
channel**. At publish time the worker passes the destination to the
adapter separately from the account identity: credentials keep resolving
from the real account (id / token vault ref), only the send destination
is the channel chat.

### Flows, sequences, knowledge base, growth links

| Route | Class | UI location / reason |
|---|---|---|
| GET /flows | UI | Flows list |
| POST /flows | UI | Flow builder (create) |
| GET /flows/{} | API-ONLY | Single-flow fetch for API consumers; the SPA lists + mutates |
| PATCH /flows/{} | UI | Flow builder (save) |
| DELETE /flows/{} | UI | Flows list → Delete |
| POST /flows/{}/activate | UI | Flows list → Activate |
| POST /flows/{}/deactivate | UI | Flows list → Deactivate |
| POST /flows/{}/test-run | UI | Flow builder → Test run |
| GET /sequences | UI | Sequences list |
| POST /sequences | UI | Sequences → Create |
| GET /sequences/{} | API-ONLY | Single-sequence fetch for API consumers; the SPA lists + mutates |
| PATCH /sequences/{} | UI | Sequences → Edit |
| DELETE /sequences/{} | UI | Sequences → Delete |
| POST /sequences/{}/enroll | UI | Sequences → Enroll by tag |
| GET /kb/documents | UI | Knowledge Base list |
| POST /kb/documents | UI | Knowledge Base → Add document |
| POST /kb/documents/upload | UI | Knowledge Base → Upload a file (PDF/DOCX/TXT/MD, text extracted server-side) |
| GET /kb/documents/{} | API-ONLY | Single-document fetch for API consumers; the SPA lists + deletes |
| DELETE /kb/documents/{} | UI | Knowledge Base → Delete |
| GET /growth-links | UI | Growth Links list |
| POST /growth-links | UI | Growth Links → Create |
| GET /growth-links/{} | API-ONLY | Single-link fetch for API consumers; the SPA lists links |
| DELETE /growth-links/{} | UI | Growth Links → Delete |
| GET /growth-links/{}/qr.svg | UI | Growth Links → QR code |
| GET /r/{} | WEBHOOK | Public short-link redirect. The API mints the URL (`shortUrl` in the link payload) and it is shared externally; the SPA displays it but never calls it |

### Webchat (public widget surface)

| Route | Class | UI location / reason |
|---|---|---|
| POST /public/webchat/{}/session | UI | Widget (`widget.ts`) — visitor session |
| POST /public/webchat/{}/messages | UI | Widget — visitor send + button clicks |
| GET /public/webchat/{}/messages | UI | Widget — poll/load thread |

These are public (visitor) endpoints by design, rate-limited under the
`/public/*` limiter; they are part of the shipped UI surface via the
widget, not the operator SPA.

### Stats & config

| Route | Class | UI location / reason |
|---|---|---|
| GET /stats/overview | UI | Dashboard |
| GET /stats/insights | UI | Analytics |
| GET /config/public | UI | Channels connect gating (configured app ids) |

### Platform admin

| Route | Class | UI location / reason |
|---|---|---|
| GET /admin/overview | UI | Admin → Overview |
| GET /admin/users | UI | Admin → Users |
| POST /admin/users/{}/platform-admin | UI | Admin → Users (grant/revoke) |
| GET /admin/workspaces | UI | Admin → Workspaces |
| GET /admin/billing | UI | Admin → Billing |
| GET /admin/settings | UI | Admin → Settings |
| PUT /admin/settings | UI | Admin → Settings (save). Panel values override the server's `.env` and apply automatically (~60 s propagation, no restart) |
| GET /admin/audit | UI | Admin → Audit |
| GET /admin/connection-info | UI | Admin → Settings → Connection reference card (F11): every webhook callback + OAuth redirect URL computed from the public base, with the verify-token **key name** per webhook (never values), plus per-group descriptions (R7) |

### Webhooks (provider-called)

| Route | Class | Reason |
|---|---|---|
| GET /webhooks/whatsapp | WEBHOOK | Meta verification handshake (hub.challenge) |
| POST /webhooks/whatsapp | WEBHOOK | WhatsApp inbound events |
| GET /webhooks/messenger | WEBHOOK | Meta verification handshake |
| POST /webhooks/messenger | WEBHOOK | Messenger inbound events |
| GET /webhooks/instagram | WEBHOOK | Meta verification handshake |
| POST /webhooks/instagram | WEBHOOK | Instagram inbound events |
| GET /webhooks/threads | WEBHOOK | Threads verification handshake |
| POST /webhooks/threads | WEBHOOK | Threads inbound events |
| POST /webhooks/tiktok | WEBHOOK | TikTok inbound events (no GET handshake route exists) |
| POST /webhooks/telegram | WEBHOOK | Telegram bot updates; registered via setWebhook at connect time |
| POST /webhooks/resend | WEBHOOK | Resend (Svix) inbound email events |
| POST /webhooks/meta/data-deletion | WEBHOOK | Meta data-deletion callback (App Review requirement) |
| GET /data-deletion/status/{} | WEBHOOK | Public status page; the URL is issued by the data-deletion callback response and opened by end users, not the SPA |

### Ops & spec

| Route | Class | Reason |
|---|---|---|
| GET / | API-ONLY | Service identity root for ops checks. The stale `phase: "Fase 3"` field was dropped in the parity fix (B1) — no consumer existed |
| GET /doc | API-ONLY | OpenAPI document for API tooling |
| GET /health | API-ONLY | Liveness probe |
| GET /health/ready | API-ONLY | Readiness probe |

## Known deferred recommendations

Not built in the parity fix (deliberately out of scope; recorded here so
they are not lost):

- **R5 — Segment-chip targeting for broadcasts/sequences.** The Contacts
  segment chips (F8) filter the contact list only. Letting a broadcast
  or a sequence enrollment target a segment chip directly changes
  delivery semantics and needs its own feature work.
- **R6 — Template manager inside the WhatsApp connect card.** The
  template manager lives on the Broadcast page (F6); duplicating it in
  the Channels WhatsApp card was judged redundant.
- **R8 — Payload-shape alignment beyond F1.** The conversation payload
  gained `contactId`/`contactTags`; a broader audit of serializer shapes
  (e.g. exposing full contact objects) remains open.

## Retention note (disconnected channel accounts, item G)

A soft disconnect keeps the account's history, but not forever:

- Disconnecting stamps `channel_accounts.disconnected_at`; reconnecting
  (any connect upsert) clears it back to NULL.
- The retention window is **30 days**: `DISCONNECT_RETENTION_DAYS` in
  `packages/shared/src/retention.ts` (with the `disconnectPurgeAt` /
  `disconnectRetentionCutoff` helpers).
- A worker sweeper — the `retention` job on the token-refresh queue,
  scheduled daily at 03:30 via a BullMQ job scheduler — permanently
  purges accounts past the cutoff, reusing the manual purge's FK-safe
  semantics (children deleted; cost ledger and workspace domains
  unlinked, never deleted) and writing a `channel.purged` audit entry
  with `details.reason = "retention_expired"` (manual purges record
  `reason = "manual"`).
- The accounts serializer exposes `disconnectedAt` and `purgeAt`
  (stamp + 30 days); a disconnected account's Channels card shows the
  muted note "Permanently deleted on {date} unless reconnected." The
  manual Delete permanently button is unchanged.
