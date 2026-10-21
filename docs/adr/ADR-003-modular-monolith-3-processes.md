# ADR-003: Modular monolith, three processes

Status: Accepted (Fase 0)
Date: 2026-10-22

One monorepo, three deployable processes: apps/api (REST + webhooks), apps/worker (queues), apps/realtime (WebSocket). No microservices until scale forces a split.
