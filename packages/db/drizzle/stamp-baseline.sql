-- Botara migrations baseline stamp (ONE-TIME, for pre-migration databases).
--
-- Databases created before the Drizzle migrations baseline existed (i.e.
-- schema applied with `drizzle-kit push` or hand-written surgical DDL, like
-- the trial/staging database) ALREADY have the exact schema that
-- `drizzle/0000_baseline.sql` creates. Running the baseline against them
-- would fail (tables already exist), so instead we "stamp" the database:
-- record the baseline as already-applied in Drizzle's own tracking table,
-- after which `bun run db:migrate` (drizzle-kit migrate) is a no-op and all
-- FUTURE migrations apply normally.
--
-- Values below are NOT invented; they are exactly what drizzle-kit 0.30.x
-- itself records when it applies the baseline (verified against the bundled
-- migrator source in drizzle-kit 0.30.6 / drizzle-orm 0.38):
--   * tracking table : "drizzle"."__drizzle_migrations"
--                      (id SERIAL PRIMARY KEY, hash text NOT NULL,
--                       created_at bigint)
--   * hash           : sha256 hex of the raw contents of
--                      packages/db/drizzle/0000_baseline.sql
--                      = fcf4dc1fefb34206bd8f0799b9c429869a956072fa9b88df8434c49d43a9b20f
--   * created_at     : the `when` of the baseline entry in
--                      packages/db/drizzle/meta/_journal.json
--                      = 1792974850083
-- drizzle-kit skips any migration whose journal `when` is <= the greatest
-- created_at recorded, so with this row present the baseline never re-runs.
--
-- Usage (from the repo root, against the EXISTING database):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/drizzle/stamp-baseline.sql
-- Then verify `bun run --cwd packages/db db:migrate` reports nothing to do.
--
-- Idempotent: re-running this file inserts no duplicate row.
-- NEVER run this against a fresh/empty database — a fresh database must run
-- the real baseline via `db:migrate`, not be stamped.

CREATE SCHEMA IF NOT EXISTS drizzle;

CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'fcf4dc1fefb34206bd8f0799b9c429869a956072fa9b88df8434c49d43a9b20f', 1792974850083
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations
  WHERE hash = 'fcf4dc1fefb34206bd8f0799b9c429869a956072fa9b88df8434c49d43a9b20f'
);
