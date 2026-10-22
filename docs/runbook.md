# Botara Runbook (Fase 3-4)

Operational handbook for running Botara in production. Deployment layout
and first-time setup live in `docs/deploy/vps.md`; this runbook covers
day-2 operations: start/stop, updates, rollback, key rotation, failure
playbooks, backups, and scaling notes.

## Processes

| Process | Entry | Port (trial layout) | Notes |
|---|---|---|---|
| API | `apps/api` (`bun run start`) | 3001 behind nginx :3000 | Hono; stateless except in-process rate limiter (below) |
| Worker | `apps/worker` | — | BullMQ queues: broadcast, sequence, publish, token-refresh, email, send-message, flow-run, kb |
| Realtime | `apps/realtime` | 3002 behind nginx `/ws` | Bun native WebSocket |
| Web | `apps/web` build output | served by nginx | Static SPA |
| Postgres | 18 (pgvector image in compose) | 5432 | System of record |
| Redis | 8 (compose) | 6379 | BullMQ queues + schedulers |

## Start / stop

Docker (production compose, `infra/docker/docker-compose.prod.yml`):

```bash
docker compose -f infra/docker/docker-compose.prod.yml up -d      # start all
docker compose -f infra/docker/docker-compose.prod.yml ps         # status
docker compose -f infra/docker/docker-compose.prod.yml logs -f api worker
docker compose -f infra/docker/docker-compose.prod.yml down       # stop (data volumes persist)
```

Native/systemd (trial server layout):

```bash
systemctl {start,stop,restart,status} botara-api botara-worker botara-realtime
journalctl -u botara-api -f   # structured JSON logs, one line per request
```

Health checks:

- `GET /api/health` — liveness only (process up).
- `GET /api/health/ready` — readiness: pings Postgres (`SELECT 1`) and
  Redis (`PING`); answers **503 with a per-dependency breakdown** when
  either is down. Point load-balancer/uptime checks here, not at /health.

## Deploy an update

1. `bun scripts/check-deprecations.ts` — know what Meta is about to remove.
2. `git pull` (or check out the target tag) on the server.
3. `bun install` at the repo root.
4. Apply pending Drizzle migrations (`bun run --cwd packages/db migrate`
   per the deploy doc) — schema changes are additive in Fase 3
   (new tables/columns only), so old and new code can overlap briefly.
5. Rebuild web: `bun run build`.
6. Restart api, worker, realtime (in that order); watch /health/ready
   until it returns 200, then check the structured logs for a minute.

## Rollback

1. Check out the previous known-good commit/tag.
2. `bun install`, rebuild web, restart the three services.
3. Database: Fase 3 migrations are additive, so older code runs fine
   against the newer schema — do NOT roll back the database for a code
   rollback. If a restore is truly required, use the newest backup
   (see Backups) and expect to lose data written after it.

## Key rotation

### TOKEN_VAULT_KEY (channel credential encryption)

The vault key encrypts every channel token at rest (AES-256-GCM).
Rotating it is a re-encryption, not a config flip:

1. Generate the new key: `openssl rand -base64 32`.
2. For each row in `token_vault`: decrypt with the OLD key
   (`TokenVault.get` / `unsealSecret`) and re-seal with the NEW key via
   `TokenVault.rotate` (this is exactly what the rotate port is for; it
   also writes an `audit_log` entry per record).
3. Only after every row is re-sealed: set `TOKEN_VAULT_KEY=<new>` in the
   server env and restart api + worker.
4. Verify by opening one channel account and sending a test message.
   A wrong key fails closed (CONFIGURATION / GCM auth errors), never
   silently — that is by design.

Losing the key = losing every stored channel credential (they must be
re-onboarded). Keep a copy in the owner's password manager / Secure Vault.

### SESSION_SECRET (session JWT signing)

1. Set `SESSION_SECRET=<new random 32+ chars>` and restart the API.
2. Effect: **all existing sessions are invalidated** (users log in again).
   There is no grace period — schedule it, or accept the logout wave.
   The httpOnly cookie and Bearer tokens share the same secret.

### Other secrets

`META_APP_SECRET`, Resend/R2/LLM keys: replace in env, restart the
affected processes. WhatsApp/Threads access tokens rotate through the
token-refresh worker + Embedded Signup re-connect; see the token_vault
notes above.

## Failure playbooks

### Postgres down

- Symptoms: /health/ready 503 with `dependencies.database.ok=false`;
  API DB-backed routes 503; worker jobs fail and retry.
- Actions: check the service (`docker compose ps` / `systemctl status
  postgresql`), disk space, and connection limits. Botara fails closed —
  no data is faked or queued in memory; once Postgres returns, worker
  retries drain the queues. If the DB is corrupt: stop writes, restore
  the newest backup into a fresh database, repoint `DATABASE_URL`.

### Redis down

- Symptoms: /health/ready 503 with `dependencies.redis.ok=false`;
  enqueues (broadcasts, publish, email inbound, kb ingest) answer 503 —
  **webhooks that cannot enqueue return 503 so senders (Resend) retry**;
  workers idle/fail job pickup.
- Actions: restart Redis; BullMQ schedulers re-register on worker start.
  Jobs already in Redis are durable (AOF per compose config); nothing is
  re-sent because job ids are idempotency-keyed.

### Worker stuck / queue backing up

- Check structured worker logs for repeated `event:"failed"` lines with
  the same `jobId` — the `error` field names the cause (usually an
  expired channel token → token-refresh alerts, or a provider outage).
- A poison job exhausts its attempts and stays visible in the failed set;
  fix the cause, then retry from BullMQ rather than deleting queues.

### Meta webhook failures

- Verify the public URL + verify tokens against
  `docs/app-review/submission-checklist.md`; check `X-Hub-Signature-256`
  rejections in the API log (they mean the app secret in env ≠ Meta's).

## Backups

`scripts/backup.sh` — `pg_dump` from `DATABASE_URL` into `./backups`
(gzipped, timestamped), keeping the newest 14 files.

```bash
DATABASE_URL=postgres://... ./scripts/backup.sh
# cron (daily 02:30):
30 2 * * * cd /opt/botara && DATABASE_URL=postgres://... ./scripts/backup.sh >> /var/log/botara-backup.log 2>&1
```

Test the restore quarterly: `gunzip -c backups/<file> | psql <scratch-url>`.

## Scaling notes

- **API**: stateless except the **in-process rate limiter** (`/auth/*`,
  `/public/*`) whose buckets live in one process's memory. Behind N
  replicas the effective limit is N× the configured value, and limits
  reset on restart. Before scaling the API beyond one instance, move the
  limiter to Redis (shared buckets) — the middleware is isolated in
  `apps/api/src/app.ts` for exactly that swap.
- **Worker**: scale by running more worker processes; BullMQ distributes
  jobs, and job ids are idempotency keys so duplicate pickup cannot
  double-send. The recurring scans (token-refresh daily; publish +
  sequence every minute) are scheduler-registered — additional workers
  just add consumers.
- **Realtime**: single instance today (in-memory subscriptions); scaling
  it needs a Redis pub/sub fan-out — noted, not built.
- **KB retrieval** ranks embeddings in code (jsonb vectors, no pgvector
  dependency). That is exact and fine to ~tens of thousands of chunks per
  workspace; beyond that, enable the guarded pgvector path documented on
  the `kb_chunks` table (add a `vector` column + HNSW index, keep jsonb
  as the portable source).
- **Postgres** is the first real bottleneck (cost-ledger writes per
  message); partition `cost_ledger` by month before it hurts.

## Deprecation guard

`bun scripts/check-deprecations.ts` reads the calendar in
`@botara/config` (`META_DEPRECATIONS`) and exits non-zero listing any
item past due or within 90 days. CI runs it as a **non-blocking warning**
on every push/PR. Current first hit: the Commerce Order Management API
removal (2026-10-27) — Botara never built on it; treat the warning as a
calendar reminder, and keep `META_GRAPH_VERSION` pinned to a supported
version ahead of the v21.0 removal (2027-01-21).
