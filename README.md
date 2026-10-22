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
- **Workspace context (Fase 1 stand-in):** DB-backed routes read the
  workspace from the `X-Workspace-Id` header. This is a documented
  placeholder until full auth lands in a later phase — it is NOT
  authentication.
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
