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

## Notes

- **PostgreSQL version:** the Docker setup pins the `pgvector/pgvector:pg18`
  image (PostgreSQL 18, the latest GA/stable release). PostgreSQL 19 is still
  a release candidate and is intentionally not used.
- **License:** not decided yet (Apache-2.0 vs AGPL is an open question), so this
  repository deliberately has no LICENSE file yet.
- Runtime rule: Bun-specific APIs live only in `apps/*` entrypoints; everything
  in `packages/*` stays runtime-agnostic so services can fall back to Node.
