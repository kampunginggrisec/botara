# Feature Parity — ChatbotX (public claims) vs Botara

**Method & clean-room note.** The ChatbotX column is derived ONLY from
ChatbotX's **public** GitHub README, its public documentation hub, and
its public homepage/pricing pages (fetched 2026-10-22; sources at the
bottom). Feature names and behavior descriptions only — ChatbotX source
code was never opened, copied, or used. Botara is an independent
clean-room implementation: same problem space, its own architecture
(see `docs/adr/`).

**Legend.** ChatbotX: *All plans* = their pricing table marks it
included in every plan incl. Community; *Paid* = paid tiers only per
the same table; *Claimed* = stated in README/docs without an edition
tag; *Not mentioned* = absent from the public material fetched.
Botara: *Implemented* = built and covered by tests in this repo
(runtime paths against live provider APIs remain mock-tested until real
credentials land — see the production readiness checklist in
`README.md`); *Partial* = a real subset works; *Planned* = intended,
not started; *Not planned* = deliberately out of scope for now.

## Channels

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| WhatsApp Business (Cloud API) | All plans | **Implemented** | `packages/channels` WhatsApp adapter: per-delivered-message pricing model, template category routing to the Marketing Messages API, Embedded Signup v4 connect |
| WhatsApp coexistence (Business App + Cloud API on one number) | Not mentioned | **Implemented** | Embedded Signup detects coexistence numbers and stores `channel_accounts.is_coexistence` (badge on the Channels page); onboarding requests both syncs from Meta (`POST /{phone-number-id}/smb_app_data`, contacts first, then history; repeat-request error 135000 treated as done). Ingestion, all in the inbound dispatcher: `smb_message_echoes` persist as OUTBOUND inbox messages (deduped on the wamid, realtime-notified, never flow-triggering, never window-opening, never billed — they never enter a send path); `smb_app_state_sync` upserts contacts by phone number (`add`/`update` refresh the display name; a phone-side `remove` deliberately keeps the platform contact — history and consent live on it); `history` chunks backfill messages with their ORIGINAL timestamps, deduped on the wamid (media placeholders skipped), and a backfilled inbound moves the 24h-window anchor only forward to its own timestamp, so old replays neither fake an open window nor close one |
| Instagram (DMs, comments, publishing) | All plans | **Implemented** | Dual login (Instagram Login + Facebook Login via Page), two-step publishing, comments, 24h window |
| Facebook Messenger | All plans | **Implemented** | Send API, handover protocol, OAuth connect incl. multi-Page picker |
| Threads | Claimed (README list; comment automation stated, DM/like limits noted by ChatbotX itself; not a pricing-table row) | **Implemented** | Full adapter: publish, replies, mentions, insights, keyword search. Threads has **no DM/like API** — Botara encodes this in its capability matrix instead of promising it |
| Telegram bots | All plans | **Implemented** | Bot API adapter + dashboard token connect (getMe-validated, vaulted, webhook auto-set) |
| Email | All plans | **Implemented** | Resend send + inbound: domain routing, Receiving API fetch, attachments copied to R2, filed into the inbox |
| Website live-chat widget | All plans | **Implemented** | Self-built embeddable widget (`docs/webchat.md`), `data-lang` EN/ID + `data-theme` light/dark/auto. (Meta's own Customer Chat Plugin retired 2024-05-09.) |
| TikTok messaging + comment automation | All plans (pricing table) | **Not planned** | Not in Botara's blueprint channel set |
| Zalo OA | All plans (pricing table) | **Not planned** | — |
| API as a channel | All plans | **Partial** | Botara exposes a full REST API; treating the API itself as a routable channel is planned |
| WhatsApp Calling (history, recordings, AI summaries) | Claimed (docs API overview) | **Not planned** | — |
| Meta Conversions API (CAPI) | Claimed (docs API overview) | **Not planned** | — |

## Automation

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| Visual flow builder (drag-and-drop, 15+ node types) | All plans | **Implemented** | `apps/web` Flows page on @xyflow/react: palette, edges, condition true/false branches, per-node config, save/activate, dry-run test panel |
| Rich messaging blocks (media, buttons, quick replies, catalogs, carousels) | All plans | **Implemented** | Channel-agnostic block model (`packages/channels` rich.ts Zod schemas: buttons/list/carousel/product/catalog) consumed by flow `send_message` nodes + the inbox reply API; per-channel renderers (WhatsApp interactive buttons/list/CTA-URL/product messages, Messenger button + generic templates + quick replies, Instagram quick replies + generic template, Telegram inline keyboards/carousel-as-sequence); unsupported combos degrade to formatted text with a typed warning, never silently. Builder rich-block editor + inbox "Add buttons" composer. Sent blocks persist on the message row (`messages.payload`); the webchat widget renders buttons/lists NATIVELY as clickable buttons - a tap posts the payload back and flow postback triggers match it (keyword triggers match the button title), so webchat buttons round-trip into flows like native channel buttons. Worked example: `docs/rich-messages.md` |
| Keyword triggers & auto-replies | All plans | **Implemented** | Flow trigger `{type:"keyword"}` matched case-insensitively (contains/equals) by the inbound webhook dispatcher |
| Event triggers / postbacks | Claimed | **Implemented** | Postback payload matching + `message.received` events; schedule/manual trigger kinds exist in the engine |
| Comment automation (auto-reply, like, hide) | Claimed | **Implemented** | Flow trigger `comment_keyword` (contains/equals, case-insensitive) matched by the webhook dispatcher on standardized `comment.received` events (Instagram + Messenger — Messenger feed comments parsed since this package); a `comment-action` queue job performs public reply + auto-hide via adapter moderation. "Like" is not offered: neither platform exposes a comment-like API to apps |
| Comment-to-DM | Claimed | **Implemented** | Same pipeline: the private reply (IG private-reply API / Messenger comment_id recipient) is the trigger config's `privateText` or the flow's first message node, persisted into an inbox conversation with idempotency key `commentId+flowId` + a `processed_comments` table; the flow then continues in the DM |
| Webhooks & external HTTP in flows | All plans | **Implemented** | `webhook` flow node (GET/POST) via the worker's HTTP port |
| A/B testing of flows | Claimed | **Not planned** | — |
| Growth tools: conversation-starter links, ref links, QR codes | Claimed | **Implemented** | `growth_links` table + Growth page: public short link `/r/:slug` (click-counted 302 to wa.me / m.me?ref / t.me?start / ig.me), server-side QR SVG (`qrcode`), referral capture in the dispatcher (Messenger ref + postback referral, Telegram `/start <slug>`, WhatsApp ctwa under a documented single-link rule) → conversion counted once per contact, `growth:<slug>` tag, bound flow runs with priority over keyword matching |
| Flow export/import (JSON) | Claimed (homepage FAQ: Cloud → self-hosted) | **Partial** | Flow graphs are JSON via the API (GET/PATCH), so export exists de facto; an import/export UI is planned |
| Sequences / drip campaigns (+ auto-enrollment) | All plans | **Implemented** | Sequences API + worker scheduler + full UI (step editor, enroll-by-tag) |
| Broadcasts (targeted, recurring, audience preview) | All plans | **Implemented** | WhatsApp template broadcasts with versioned rate-card estimates + cost ledger; per-delivered-message pricing per Meta's current model |

## AI

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| AI agents (BYOK: OpenAI, Claude, Gemini, DeepSeek, OpenRouter, local LLMs, …) | All plans (unlimited agents, BYOK) | **Implemented** | OpenAI-compatible provider behind one interface — any compatible endpoint (incl. gateways for non-compatible providers) works by base-URL + key; `ai_reply` flow node + Inbox AI suggestions |
| Knowledge bases for agents (RAG) | Claimed (docs API overview) | **Implemented** | KB documents → chunks → embeddings; top-3 cosine retrieval grounds `ai_reply` and suggestions |
| Agentic inbox copilot (summaries, smart replies, intent scoring) | Claimed (homepage marketing) | **Partial** | AI reply suggestions implemented; conversation summaries / intent scoring not built |
| MCP server (tools for Claude/ChatGPT/Cursor/…) | All plans | **Implemented** | `apps/mcp` (`@botara/mcp`, official MCP SDK): Streamable HTTP (stateless, `PORT_MCP` 3003) + stdio; 11 safe tools over the REST API authenticated by a personal `bta_` token (Settings → API tokens); see `docs/mcp.md` |
| Agent frameworks (OpenClaw, Hermes, Claude agents) | Claimed | **Not planned** | — |

## Inbox, contacts, publishing, analytics

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| Unified omnichannel live-chat inbox (human takeover, assignment) | All plans | **Implemented** | Inbox with all channels, 24h window enforcement (fail closed), Messenger handover protocol; conversation assignment end-to-end: `PATCH /conversations/{id}/assign` (member-validated, inbox role set) + `GET /conversations?assignee=me|unassigned|<userId>` filter, assignee serialized with member name/email, an `inbox.update` realtime event on every change, and inbox UI (assignee chip per conversation, All / Assigned to me / Unassigned / per-member filters, thread-header assignee select). Conversation status management: `PATCH /conversations/{id}/status` moves a conversation between open / pending / resolved (any transition, incl. reopening; invalid values are a typed 400), `GET /conversations?status=open|pending|resolved` filters by status (composes with the assignee filter), an `inbox.update` event carries the new status, and the inbox UI has a thread-header status select, a colored status badge per conversation, and a status filter |
| Contacts CRM (tags, custom fields, segmentation) | Claimed (contacts unlimited in all plans) | **Implemented** | Contacts API + page; tags + custom fields; segment counts API |
| Contact import / export | Claimed (docs API overview) | **Implemented** | `POST /contacts/import` (CSV with a hand-written parser / JSON, per-row validation, (channel, externalId) dedupe, skip/update conflict modes, 5000-row cap) + `GET /contacts/export` (CSV/JSON download); Contacts page Import dialog + Export buttons |
| Coupons (batches, redemption tracking) | Claimed (docs API overview) | **Not planned** | — |
| Product catalogs / Meta Catalog sync | Claimed (docs API overview) | **Implemented** | WhatsApp catalog sync: `POST /channels/{id}/catalog/sync` discovers the account's catalogs (WABA resolved from the phone-number id via Graph, or an explicit `catalogId`), pages `/{catalog-id}/products` (Graph v26.0, capped at 1000 products / 20 pages per catalog) and mirrors them into `catalog_products` (stale rows deleted only after a fully-paged sync); the token resolves through the vault (no token → typed 503). Synced products power pickers in the FlowBuilder rich product/catalog editor and the inbox product composer — manual catalog/retailer ids still work. Mock-verified end-to-end; a live sync needs a real Meta token |
| E-commerce connectors (Shopify / WooCommerce named) | Not mentioned in fetched public material (e-commerce appears as catalogs/coupons + homepage marketing claims) | **Not planned** | Meta catalogs have landed (row above); store-platform connectors remain unplanned |
| Content publishing + scheduling | Not itemized separately in the README list (covered by campaigns) | **Implemented** | Publish page + worker: IG/Threads/Messenger/Telegram, per-target partial status |
| Analytics (performance, engagement, campaign results) | Claimed (thinly specified publicly) | **Partial** | Dashboard stats (contacts, conversations, messages 30d, broadcasts + monthly cost, active flows) implemented; per-channel provider insights are adapter-level, no insights UI yet |

## Developer platform & integrations

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| Public REST API (390+ endpoints, workspace API keys) | All plans | **Implemented** | REST API with OpenAPI document + session auth, PLUS personal API tokens (`api_tokens` table, SHA-256 hashed, `bta_` prefix, create/list/revoke in Settings; Bearer tokens resolve user + workspaces identically to JWT) — the same tokens authenticate the MCP server |
| CLI | All plans | **Not planned** | — |
| n8n integration (custom node) | Claimed (docs) | **Planned** | Via the future API-key/MCP work; a generic webhook node exists today |
| Make.com integration | Claimed (docs) | **Planned** | Same as n8n |
| Email/CRM integrations (Mailchimp, Klaviyo, SendGrid, …) | Claimed (README project structure list) | **Not planned** | — |

## Platform / admin / commercial

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| Team members | All plans (size varies by plan) | **Implemented** | Members admin in Settings (invite by email, roles, remove) |
| Role-based access control (RBAC) | **Paid** (Community = unlimited admins, no RBAC) | **Implemented** | owner/admin/member/agent roles enforced server-side — in Botara's open core |
| Audit logs | **Paid** | **Implemented** | `audit_log` table; auth + workspace + channel events — open core |
| Multi-workspace | Per plan (Community 1 → Enterprise unlimited) | **Implemented** | Workspace switcher; per-workspace data scoping everywhere |
| White label / branding removal | **Paid** (Whitelabel/Enterprise) | **Not planned** | Botara is self-hosted open source; no branding lock-in either way |
| Custom domain + SSL for an agency portal | **Paid** | **Partial** | Any self-hosted Botara runs on your own domain + HTTPS (Caddy); a multi-tenant agency portal is not a product surface |
| SaaS sub-accounts + Stripe billing | **Paid** (Whitelabel) | **Not planned** | Botara is not a hosted multi-tenant SaaS |
| Dark / light UI modes | Not mentioned in fetched public material | **Implemented** | Class-based dark mode, OS-preference default, persisted toggle; widget themes too |
| Multilingual UI | Not mentioned in fetched public material | **Implemented** | EN + ID dictionaries, **English default** (Meta App Review), EN \| ID switcher |
| Self-hosting (Docker) | Community + Enterprise plans (separate docker-compose repo, pre-built images) | **Implemented** | Production compose package (`docs/deploy/vps.md`); the trial deployment additionally proves a native (no-Docker) install |
| Data deletion / privacy compliance | Not itemized publicly | **Implemented** | Meta data-deletion callback + public status page, `/privacy` + `/terms`, AES-256-GCM token vault |
| Open-source license | MIT for Community Edition, Commercial for enterprise features (README License section; the split is not itemized beyond the pricing table) | **Implemented** | AGPL-3.0 for the whole Botara codebase (ADR-009) — no open-core split |

## Honest gaps in Botara today

- **Runtime proof vs live providers:** adapters and OAuth/connect flows
  are verified with mocked HTTP + factory tests; end-to-end runs against
  real Meta/Telegram accounts wait for the owner's credentials and Meta
  App Review (`README.md` checklist).
- **Telegram multi-bot attribution:** Telegram updates carry no bot id;
  the dispatcher attributes them when exactly one Telegram account is
  connected. Per-bot webhook URLs are the planned fix for multi-bot
  deployments.
- **Instagram via Facebook Login** resolves the IG business account
  through the Page list at connect time; accounts whose Page lacks a
  linked IG business account get an honest error redirect.
- **TikTok and Zalo** are ChatbotX channels Botara does not offer; the
  table marks them Not planned rather than pretending coverage.
- Items marked Partial above (analytics depth, flow export/import UI,
  API-as-channel) are real subsets — nothing in this table claims more
  than the code does.
- **WhatsApp growth attribution:** wa.me links cannot carry a ref, and
  ctwa referrals carry only the ad's `ctwa_clid` — the dispatcher
  attributes a WhatsApp referral to a growth link only when the account
  has exactly ONE active growth link; with several links it counts
  nothing rather than guessing.

## Sources (public, fetched 2026-10-22)

- ChatbotX GitHub repository README (feature list, plan table, license):
  https://github.com/ChatbotXIO/ChatbotX
- ChatbotX documentation hub + API/CLI/MCP/integration pages:
  https://chatbotx.io/docs (and /docs/quickstart,
  /docs/api-reference/api-overview, /docs/cli/introduction,
  /docs/mcp/introduction, /docs/integrations/n8n, /docs/integrations/make)
- ChatbotX homepage + pricing: https://chatbotx.io/ ,
  https://chatbotx.io/pricing
- ChatbotX self-hosting compose repo:
  https://github.com/ChatbotXIO/chatbotx-docker-compose

Caveat: deeper ChatbotX docs pages (per-channel setup guides) may state
additional detail not captured here; homepage agentic/copilot claims are
marketing copy and are marked as such in the table.
