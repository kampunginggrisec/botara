# ADR-002: Bun + Hono, runtime-agnostic core

Status: Accepted (Fase 0)
Date: 2026-10-22

Bun is the runtime and package manager; Hono is the HTTP framework (multi-runtime, OpenAPI + type-safe RPC). Bun-specific APIs are allowed only in apps/* entrypoints; packages/* stay runtime-agnostic so any service can fall back to Node. Drizzle is used instead of Prisma; native deps (sharp, uWebSockets.js) are avoided in the core.
