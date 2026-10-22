# Feature Parity — ChatbotX (public claims) vs Botara

**Method & clean-room note.** The ChatbotX column is derived ONLY from
ChatbotX's **public** GitHub README and its public documentation hub
(fetched 2026-10-22; sources listed at the bottom). Feature names and
behavior descriptions only — ChatbotX source code was never opened,
copied, or used. Botara is an independent clean-room implementation:
same problem space, its own architecture (see `docs/adr/`).

**Legend.** ChatbotX: *Community* = their free/open edition per their
README edition table; *Enterprise* = paid edition per the same table;
*Claimed* = stated in their README/docs without an edition tag;
*Roadmap* = listed as planned; *Not offered* = absent from public
material. Botara: *Implemented* = built and covered by tests in this
repo (runtime paths against live provider APIs remain mock-tested until
real credentials land — see the production readiness checklist in
`README.md`); *Partial* = a real subset works; *Planned* = intended,
not started; *Not planned* = deliberately out of scope.

## Channels

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| WhatsApp Business (Cloud API) | Community | **Implemented** | `packages/channels` WhatsApp adapter: per-delivered-message pricing model, template category routing to the Marketing Messages API, Embedded Signup v4 connect, coexistence numbers |
| Instagram (DMs, comments, publishing) | Community | **Implemented** | Dual login (Instagram Login + Facebook Login via Page), two-step publishing, comments, 24h window |
| Facebook Messenger | Community | **Implemented** | Send API, handover protocol, OAuth connect incl. multi-Page picker |
| Threads | Community | **Implemented** | Full adapter: publish, replies, mentions, insights, keyword search. Threads has **no DM/like API** — Botara encodes this in its capability matrix instead of promising it |
| Telegram bots | Community | **Implemented** | Bot API adapter + dashboard token connect (getMe-validated, vaulted, webhook auto-set) |
| Email | Community | **Implemented** | Resend send + inbound: domain routing, Receiving API fetch, attachments copied to R2, filed into the inbox |
| Website live-chat widget | Community | **Implemented** | Self-built embeddable widget (`docs/webchat.md`), `data-lang` EN/ID + `data-theme` light/dark/auto. (Meta's own Customer Chat Plugin retired 2024-05-09.) |

## Automation

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| Visual flow builder | Claimed ("no-code"; "Advanced Flow Builder" is Roadmap) | **Implemented** | `apps/web` Flows page on @xyflow/react: palette, edges, condition true/false branches, per-node config, save/activate, dry-run test panel |
| Conditional logic flows | Enterprise | **Implemented** | `packages/flow-engine` condition node (equals/contains/exists) — in Botara's open core |
| Keyword triggers | Claimed (event triggers) | **Implemented** | Flow trigger `{type:"keyword"}` matched case-insensitively (contains/equals) by the inbound webhook dispatcher |
| Postback / event triggers | Claimed | **Implemented** | Postback payload matching + `message.received` events; schedule/manual trigger kinds exist in the engine |
| Comment automation (comment → DM etc.) | Community (Instagram/Facebook) | **Partial** | `comment.received` events are parsed + keyword moderation exists; automated comment-triggered flows are planned |
| Sequences / drip campaigns | Claimed | **Implemented** | Sequences API + worker scheduler + full UI (step editor, enroll-by-tag) |
| Broadcasts | Community | **Implemented** | WhatsApp template broadcasts with versioned rate-card estimates + cost ledger; per-delivered-message pricing per Meta's current model |
| AI chatbot / AI agents | Community | **Implemented** | OpenAI-compatible provider behind one interface; `ai_reply` flow node grounded in the knowledge base (RAG), Inbox AI suggestions |
| AI voice agents | Enterprise | **Not planned** | Out of scope |
| MCP server (expose tools to AI agents) | Community | **Planned** | Not started; the flow webhook node covers basic outbound calls today |
| Third-party integrations (n8n, 400+ apps via MCP) | Community (via MCP) | **Planned** | Depends on the MCP work above; a generic webhook flow node exists now |
| E-commerce (Shopify / WooCommerce / Stripe) | Enterprise | **Planned** | Not started |
| Calendar booking | Not offered in README (docs-hub only) | **Not planned** | — |
| WhatsApp catalogs / native flows & forms | Not offered publicly | **Planned** | Adapter-level follow-up |

## Inbox, contacts, publishing, platform

| Feature | ChatbotX | Botara | Botara location / notes |
|---|---|---|---|
| Unified omnichannel inbox | Community | **Implemented** | Inbox page: all channels, 24h window enforcement (fail closed), template fallback path |
| Live chat & human handoff | Community | **Partial** | Messenger handover protocol implemented; conversation assignment field exists; a dedicated agent-assignment UI is planned |
| Contacts / CRM (tags, custom fields) | Community | **Implemented** | Contacts API + page; tags + custom fields; segment counts API |
| Audience segmentation | Community | **Partial** | Tag-based segments + counts + enroll-by-tag work; a visual segment builder is planned |
| Content publishing + scheduling | Community (as "Omnichannel Campaigns"; explicit scheduler not itemized publicly) | **Implemented** | Publish page + worker: IG/Threads/Messenger/Telegram, per-target partial status |
| Analytics / insights | Community | **Partial** | Dashboard stats (contacts, conversations, messages, broadcast + monthly cost, active flows) implemented; per-channel provider insights (IG/Threads) are adapter-level, no insights UI yet |
| Team access: roles & permissions | Community | **Implemented** | owner/admin/member/agent roles, members admin in Settings, audit log |
| Multi-workspace | Claimed (docs-hub: agency features) | **Implemented** | Workspace switcher, per-workspace data scoping everywhere |
| Dark / light UI modes | Community | **Implemented** | Class-based dark mode, OS-preference default, persisted toggle; widget themes too |
| Multilingual UI | Not specified publicly | **Implemented** | EN + ID dictionaries, **English default** (Meta App Review), EN \| ID switcher |
| Public API + webhooks | Community | **Partial** | REST API with OpenAPI document + provider webhooks in; outbound webhooks exist as a flow node; API-key management for third parties is planned |
| Self-hosting (Docker) | Community | **Implemented** | Production compose package (`docs/deploy/vps.md`); the trial deployment additionally proves a native (no-Docker) install |
| Data deletion / privacy compliance | Not itemized publicly | **Implemented** | Meta data-deletion callback + public status page, `/privacy` + `/terms` pages, AES-256-GCM token vault |
| Open-source license | MIT core + Enterprise parts (per their README) | **Implemented** | AGPL-3.0 for the whole Botara codebase (ADR-009) — no open-core split |

## ChatbotX Enterprise-only items — Botara position

| Feature (ChatbotX: Enterprise) | Botara |
|---|---|
| Omnichannel AI support agents | **Partial** — AI replies via `ai_reply` node + Inbox suggestions; autonomous multi-channel agents planned |
| AI message translation | **Not planned** |
| Sentiment analysis | **Not planned** |
| Lead scoring | **Not planned** |
| AI ads manager / AI website builder | **Not planned** |
| Event marketing & funnels | **Not planned** |
| WhatsApp catalog management | **Planned** |
| Shopify abandoned-cart recovery | **Planned** (with the e-commerce work) |
| Order / shipment notifications | **Partial** — any template can be sent via broadcast/flows today; dedicated order integrations planned |
| Ratings & reviews | **Not planned** |

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
- **Segments, insights, comment automations** are Partial as marked
  above — the table is the commitment: nothing here claims more than
  the code does.

## Sources (public, fetched 2026-10-22)

- ChatbotX GitHub repository README (incl. its Community vs Enterprise
  edition table and roadmap): https://github.com/ChatbotXIO/ChatbotX
- ChatbotX documentation hub: https://docs.chatbotx.io/
