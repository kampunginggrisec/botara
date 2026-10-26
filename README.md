# Botara

Clean-room, from-scratch omnichannel chatbot platform (a more complete ManyChat
alternative). Built from an original architecture blueprint — no code is copied
from ChatbotX or any other project (see docs/adr/ADR-001).

## Stack

- Runtime: **Bun** + TypeScript (strict) — Bun workspaces monorepo, one lockfile
- API: **Hono** (+ OpenAPI) · Worker: **BullMQ** on Redis · Realtime: Bun native WebSocket
- Web: **React + Vite** SPA + Tailwind CSS
- Database: **PostgreSQL + pgvector** via **Drizzle ORM**
- Storage: **Cloudflare R2** (S3-compatible) · Email: **Resend** (send + inbound)

## Repository layout

- `apps/api` — Hono REST API + webhooks (`GET /health`, OpenAPI at `/doc`)
- `apps/worker` — BullMQ workers (broadcast, sequence, publish, token-refresh, email)
- `apps/realtime` — WebSocket server for the live inbox
- `apps/web` — React + Vite dashboard
- `packages/db` — Drizzle schema + connection factory
- `packages/channels` — channel adapter contract + capability matrix (core contract)
- `packages/flow-engine` — flow node schemas + deterministic interpreter
- `packages/billing` — per-message cost ledger / estimators
- `packages/ai` — LLM provider interface
- `packages/media` — R2 media helpers
- `packages/shared` — error taxonomy, utils, shared schemas
- `packages/config` — env schema + Meta deprecation calendar

## Run locally

```bash
bun install
docker compose -f infra/docker/docker-compose.yml up -d
bun run dev        # API on http://localhost:3000 (GET /health)
# Web dev server: VITE_API_URL=http://localhost:3000 bun run --cwd apps/web dev
# (production builds need no variable: the SPA calls same-origin /api)
bun test
bun run typecheck
bun run build      # builds apps/web
```

## Fase 1 status

Implemented (code-complete against the real APIs, verified with mocked-HTTP
tests; live credentials arrive with the VPS/domain):

- **Channels:** real WhatsApp adapter (Graph API pinned to v26.0; template
  sends routed by the template's *latest* category — marketing →
  `/{phone-number-id}/marketing_messages`, utility/authentication →
  `/messages`; typed errors incl. 131063 category-refresh, 131049, rate
  limits, token errors with `fbtrace_id`; webhook parsing incl.
  `template.category_changed` and coexistence echoes; HMAC-SHA256 signature
  verification) and a real Telegram adapter (Bot API send/parse/setWebhook).
  Other channels remain honest placeholders. Credentials resolve through an
  injected credential provider keyed by `token_vault_ref` (env-backed in
  Fase 1); raw tokens are never logged or persisted.
- **API routes:** `GET /conversations`, `GET /conversations/:id/messages`,
  `POST /conversations/:id/reply` (24h window enforced, fail closed —
  free-form outside the window is rejected with `MESSAGING_WINDOW_CLOSED`,
  template replies stay allowed), `GET/POST /contacts`,
  `PATCH /contacts/:id`, `GET /segments`, `GET/POST /templates`,
  `PATCH /templates/:id/category`, `POST /broadcasts/estimate` (pure, works
  without a database), `POST /broadcasts`, `GET /broadcasts/:id` (status +
  cost report from `cost_ledger`), `GET/POST /webhooks/whatsapp`,
  `POST /webhooks/telegram`. DB-backed routes return HTTP 503 with a
  `CONFIGURATION` error when `DATABASE_URL` is unset.
- **Workspace context (Fase 1 stand-in, SUPERSEDED in Fase 3):** DB-backed
  routes read the workspace from the `X-Workspace-Id` header. This was a
  documented placeholder — Fase 3 replaced it with real session auth;
  the header now only SELECTS a workspace for an authenticated,
  membership-verified user (and survives as a tokenless dev fallback
  behind `BOTARA_ALLOW_HEADER_WORKSPACE=1`, default off).
- **Worker processors:** `send-message` (adapter send + cost ledger +
  status), `broadcast` (fan-out with stable idempotency key
  `broadcastId:contactId`), `flow-run` (flow-engine execution core with
  injected ports; keyword triggers, contact-field conditions, delay
  pause/resume).
- **Billing:** versioned WhatsApp rates table (`sample-2026-q4`, effective
  2026-10-01, sample values pending the live Meta rate card) with the 1,000
  free monthly service allowance per phone number applied in estimates.
- **Web:** Inbox (thread + reply box with window-closed state), Contacts
  (tag filter), and Broadcast (estimate + create) screens wired to the API.

## Fase 2 status

Channel completion + publishing suite + sequences + basic AI, again
code-complete against the real APIs with mocked-HTTP tests:

- **Instagram (dual mode, one adapter):** `instagram-login` talks to
  graph.instagram.com with the `instagram_business_*` scopes; `facebook-login`
  talks to graph.facebook.com (pinned v26.0) with the `instagram_*` scopes via
  a linked Page. The authorize-URL builder ALWAYS sends the full scope list
  (with Instagram Login a partial `scope` parameter replaces the defaults).
  DMs, public comment replies, private replies (1 per comment), hide/delete,
  two-step media publish, and insights using the Views metric family only.
- **Messenger:** Send API with a Page token, handover protocol
  (pass/take thread control), Get Started + persistent-menu helpers, Page
  feed publishing, comment moderation; webhooks normalize messages,
  postbacks, and referrals.
- **Threads (the differentiator):** graph.threads.net container→publish
  flow, `auto_publish_text` one-step text posts, replies, quotes, reply
  hide/unhide, own-post delete, keyword search, Views insights — and the
  full token lifecycle: short (1h) → long-lived (60d) exchange, refresh
  only inside the 24h–60d window (a pure decision function, unit-tested).
  Threads still has **no DM and no like API**; the adapter refuses DMs
  honestly. Note: private profiles' permissions expire after 90 days.
- **Webchat (self-built):** Meta's Customer Chat Plugin retired 2024-05-09,
  so the website widget is Botara's own — an embeddable `widget.js`, public
  session/send/poll endpoints, and inbox replies persisted through a
  store-port adapter. See [docs/webchat.md](docs/webchat.md).
- **Email via Resend:** sends always carry an `Idempotency-Key`; the
  `email.received` webhook is metadata-only, full content is fetched via
  the Receiving + Attachments APIs and attachments are copied into R2 by
  the worker. Svix signature verification included.
- **WhatsApp onboarding:** `POST /channels/whatsapp/embedded-signup/exchange`
  performs the Embedded Signup v4 server exchange (code → debug_token →
  phone numbers), stores the token ONLY in the vault port, persists channel
  accounts with their coexistence flag, and returns a summary with no token
  material. Template category-change webhooks now actually PATCH
  `templates.latest_category` and persist the messaging account (WABA) id.
- **Publishing suite:** `scheduled_posts` with per-channel targets and
  per-target results; CRUD + publish-now API; a worker publish processor
  with partial-failure semantics (one target failing never fails others).
  The Publish screen (composer + channel checkboxes + schedule + per-target
  status) is wired to it.
- **Sequences:** drip campaigns as ordered delay+message steps; enroll by
  tag; a worker processor advances due enrollments through the send-message
  queue with stable per-step idempotency keys.
- **Token-refresh worker:** daily scan enqueues per-account refresh jobs
  (jobId per account+day), adapters decide by the refresh window, failures
  mark the account `refresh_failed` and emit a structured alert.
- **AI basics:** an OpenAI-compatible provider (any endpoint speaking the
  OpenAI wire format; base URL/key/model from env), `POST
  /conversations/:id/ai-suggest` (503 when unconfigured — suggestions are
  never faked), and a keyword moderation helper behind
  `POST /moderation/check`.

## Fase 3-4 status

Production hardening + go-live readiness (code-complete; live verification
needs the external items in the checklist below):

- **Real auth:** email+password registration/login (argon2id via
  `Bun.password`), HS256 session JWT (env `SESSION_SECRET`) as httpOnly
  cookie + Bearer token, workspace membership with roles
  (owner/admin/member/agent; mutating routes guarded), invite-by-email
  members, `/auth/*` + `/workspaces*` endpoints, and a web login/register
  flow with workspace switcher, route guard, and logout. `audit_log`
  records register/login, vault put/rotate, and member add/remove.
- **Token vault (real):** `token_vault` table + AES-256-GCM
  (`TOKEN_VAULT_KEY`, base64 32 bytes, fails closed when missing);
  WhatsApp onboarding now stores into the DB vault by default, and a
  vault-backed CredentialProvider decrypts `token_vault_ref` at
  send-time. InMemory vault remains for tests only.
- **Email inbound producer:** `workspace_domains` maps recipient domains
  to workspaces; the Resend webhook routes `email.received` into the
  `email` queue (503 when Redis is down — never faked) for the existing
  worker ingestion. Admin endpoints register/list/delete domains.
- **WhatsApp allowance tracking:** sends consult the month-to-date
  delivered-service count aggregated from `cost_ledger`; the first 1,000
  service messages per number/month rate 0, beyond that utility.
- **Instagram video publish:** the publish worker creates the media
  container, polls its status with a bounded budget (injectable delay)
  until FINISHED, then calls media_publish; images keep the one-shot path.
- **Observability:** structured JSON request logs (request id, method,
  path, status, ms — never bodies/tokens), `GET /health/ready` pinging DB
  + Redis with a per-dependency 503 breakdown, structured worker job logs.
- **Security:** in-process rate limiter on `/auth/*` + `/public/*`
  (typed 429; single-instance assumption documented in the runbook),
  security headers (+HSTS behind https), CORS allowlist from
  `CORS_ORIGINS` (default deny; the embeddable webchat endpoints stay
  permissive), and a production startup guard that refuses to boot when
  `DATABASE_URL` / `SESSION_SECRET` / `TOKEN_VAULT_KEY` are missing.
- **Knowledge base + AI:** `kb_documents`/`kb_chunks` (embeddings as jsonb
  arrays — no pgvector dependency; guarded optional pgvector path noted
  on the table), `POST /kb/documents` → worker chunking (~800/overlap 100)
  + embeddings (503 at the API when AI is unconfigured), cosine retrieval
  in code, a new flow node **`ai_reply`** (top-3 chunks + conversation →
  AI → send, with a configured fallback message), and KB-grounded
  `/conversations/:id/ai-suggest`.
- **Meta data deletion:** `POST /webhooks/meta/data-deletion` verifies
  the `signed_request` HMAC and returns `{url, confirmation_code}`;
  `GET /data-deletion/status/:code` is the public status page.
- **Ops:** `scripts/backup.sh` (pg_dump + 14-file rotation),
  `docs/runbook.md`, GitHub CI (typecheck + tests + web build), and
  `scripts/check-deprecations.ts` (fails on past-due/≤90-day Meta
  deprecations; CI warning step).
- **App Review package:** `docs/app-review/` — paste-ready permission
  justifications, shot-by-shot screencast scripts, and a submission
  checklist marking exactly which steps are the account owner's.
- **Meta setup:** `docs/meta-setup.md` — the operator's end-to-end Meta
  app configuration guide (Indonesian): architecture table, credentials
  via the admin panel, per-product webhook/OAuth steps, Embedded
  Signup, the WhatsApp test number, troubleshooting, final checklist.
- **Web:** login/register, token-based API client, workspace switcher,
  Knowledge Base page (typed documents or file upload — PDF/DOCX/TXT/MD
  with server-side text extraction; originals are never stored and there
  is no OCR), and public `/privacy` + `/terms` template pages.

## Completion package status (post Fase 4)

The placeholder screens the owner found on the trial deployment are gone —
**every screen is functional now**:

- **i18n EN + ID, default English** (Meta App Review readiness): a typed
  dictionary pair with identical key sets (type-enforced + parity test),
  an EN | ID switcher in the shell header, on the sign-in page, and on the
  legal pages; choice persists per browser (`botara.lang`). Privacy/Terms
  bodies follow the selected language (marked templates in both).
- **Dark / light theme:** class-based dark mode (Tailwind v4 custom
  variant), defaulting to the OS `prefers-color-scheme`, persisted
  (`botara.theme`), with a pre-paint script (no flash) and a sun/moon
  toggle next to the language switcher. The webchat widget accepts
  `data-theme="light|dark|auto"` and `data-lang="en|id"`.
- **Flows:** a `flows` table + CRUD API, graph validation against the
  flow-engine node schemas, a **visual builder** (@xyflow/react: palette,
  condition true/false branches, per-node config panel, save, activate,
  dry-run test panel), and **inbound trigger wiring** — WhatsApp/Telegram
  (plus IG/Messenger/Threads) webhooks persist messages and enqueue
  flow-runs for keyword/postback matches; the worker resolves id-based
  jobs from repositories.
- **Sequences UI:** list with step + enrollment counts, step editor
  (delay hours, text/template), enroll-by-tag, delete.
- **Channels page with real connect paths:** Telegram bot-token connect
  (getMe-validated, vaulted, webhook auto-registration), WhatsApp
  Embedded Signup launcher (rendered only when the Meta app + config id
  are configured — otherwise an honest "not configured" card), and OAuth
  for Instagram (both login modes), Threads, and Messenger (including
  the multi-Page picker). Webchat embed snippet with copy button.
- **Dashboard stats:** `GET /stats/overview` (contacts, conversations,
  messages 30d, broadcasts, monthly cost by currency, pending posts,
  active flows) rendered as cards + recent conversations.
- **Settings:** profile + workspace rename, change password (audited),
  member list/invite/role/remove.
- **Feature parity:** `docs/feature-parity.md` maps ChatbotX's public
  feature list against Botara, item by item, honestly.
- **Rich messages:** `docs/rich-messages.md` is the worked guide to
  tappable buttons/lists - title vs payload vs URL, per-channel
  rendering, and the click round-trip into flow triggers.

## Adopted-features package status

Five feature groups adopted from the public parity gap list (implemented
independently, clean-room — concepts only, no third-party code):

- **Rich message blocks:** a channel-agnostic block model (buttons /
  list / carousel / product / catalog) as Zod schemas in
  `packages/channels`, usable from flow `send_message` nodes and the
  inbox reply API. Each adapter renders natively where the platform
  supports it (WhatsApp interactive messages, Messenger templates +
  quick replies, Instagram quick replies + generic template, Telegram
  inline keyboards) and degrades to formatted text with a typed warning
  otherwise. Builder rich-block editor + inbox "Add buttons" composer.
- **Comment-to-DM + comment automation:** flow trigger `comment_keyword`
  for Instagram/Messenger comments — public reply, auto-hide, and a
  private reply (config text or the flow's first message node) executed
  by a worker `comment-action` job with `processed_comments`
  idempotency; the flow then continues inside the DM conversation.
- **Contact import/export:** CSV (hand-written parser) / JSON import
  with per-row validation, (channel, externalId) dedupe, skip/update
  conflict modes and a 5000-row cap; CSV/JSON export downloads;
  Contacts page dialog + buttons.
- **MCP server + API tokens:** personal API tokens (`bta_...`, SHA-256
  hashed, managed in Settings) authenticate the REST API like a session;
  `apps/mcp` exposes 11 safe tools (reads, dry-run, estimate, enroll,
  inbox reply) over Streamable HTTP (`PORT_MCP`, default 3003) or stdio
  using the official MCP SDK — see `docs/mcp.md`.
- **Growth tools:** trackable short links per channel account
  (`/r/:slug` redirect counting clicks → wa.me / m.me / t.me / ig.me),
  server-side QR codes, referral capture (Messenger ref, Telegram
  `/start`, WhatsApp ctwa) that counts a conversion once per contact,
  tags the contact `growth:<slug>`, and runs a bound flow with priority
  over keyword matching. Growth page in the dashboard.
- **Message & system variables (combined adoption #1):**
  `{{contact.*}}` / `{{workspace.*}}` / `{{channel.*}}` / `{{vars.*}}` /
  `{{system.*}}` interpolation from one shared engine
  (`packages/shared`), rendered per recipient at send time on flow
  messages, sequence steps, broadcast template parameters, and inbox
  replies — plus a variable-insert picker in every builder. Unknown
  variables render empty with a warning, never raw. See
  `docs/variables.md`.

All new web strings exist in both EN and ID dictionaries; the parity
table in `docs/feature-parity.md` reflects the new status per item.

## Production readiness checklist

Done in code (Fase 0-4 + completion + adopted-features packages):
everything above, plus the Fase 1-2 feature set, the production
deployment package, and the trial deployment.

Still external — required before real go-live:

- [ ] **Credentials via Secure Vault / server env:** Meta app id+secret,
      WhatsApp Embedded Signup config id, Threads app credentials, R2
      keys, Resend API key, an LLM provider key, and freshly generated
      `SESSION_SECRET` + `TOKEN_VAULT_KEY` (the vault key must also be
      backed up by the owner — losing it loses all channel credentials).
- [ ] **Meta App Review submitted BY THE ACCOUNT OWNER:** business
      verification, app creation, webhook/config ids, test users,
      screencasts — see `docs/app-review/submission-checklist.md`
      ([OWNER] vs [PREPARED] steps). Approval gates production Meta
      access; dev-mode tokens are limited until then.
- [ ] **Legal pages finalized by the owner:** `/privacy` and `/terms`
      ship as marked templates.
- [ ] **Live WhatsApp rate card:** replace the `sample-2026-q4` table in
      `@botara/billing` with Meta's live per-country card and bump the
      version (estimates/ledger math already stamps the version).
- [ ] **Production VPS + domain + DNS:** point the real domain at the
      production deployment (compose + Caddy in `docs/deploy/vps.md`),
      set `CORS_ORIGINS`, `APP_PUBLIC_URL`, `PUBLIC_WEBHOOK_BASE_URL`
      (OAuth redirect URIs + Telegram webhook derive from it), and
      webhook URLs at Meta.
- [ ] **First decisions still open:** first LLM provider + first data
      region (drives the R2 bucket jurisdiction — fixed at creation).
- [ ] **Optional:** enable pgvector for very large knowledge bases
      (guarded path documented on `kb_chunks`); move the rate limiter to
      Redis before running multiple API replicas (see runbook).

## Deployment

Production package is prepared (VPS/domain menyusul): root `Dockerfile`
(multi-target), `infra/docker/docker-compose.prod.yml` (Postgres 18, Redis,
API, worker, realtime, web, Caddy with automatic HTTPS via a `${DOMAIN}`
placeholder), `infra/deploy/Caddyfile`, `.env.production.example`, and a
step-by-step Indonesian guide at [docs/deploy/vps.md](docs/deploy/vps.md).

## License

Botara is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0) — see [LICENSE](LICENSE) and the decision record
[docs/adr/ADR-009-license-agpl.md](docs/adr/ADR-009-license-agpl.md).

## Notes

- **PostgreSQL version:** the Docker setup pins the `pgvector/pgvector:pg18`
  image (PostgreSQL 18, the latest GA/stable release). PostgreSQL 19 is still
  a release candidate and is intentionally not used.
- Runtime rule: Bun-specific APIs live only in `apps/*` entrypoints; everything
  in `packages/*` stays runtime-agnostic so services can fall back to Node.
