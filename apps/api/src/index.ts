import { createApp, defaultDeps } from "./app";

/**
 * Botara API entrypoint (Bun runtime). All route logic lives in app.ts
 * (createApp with injectable deps, used by tests and the smoke check);
 * this file only wires the production defaults and serves.
 *
 * Routes (Fase 1):
 *   GET  /health, GET /doc (OpenAPI)
 *   GET+POST /webhooks/whatsapp, POST /webhooks/telegram
 *   GET  /conversations, GET /conversations/:id/messages, POST /conversations/:id/reply
 *   GET/POST /contacts, PATCH /contacts/:id, GET /segments
 *   GET/POST /templates, PATCH /templates/:id/category
 *   POST /broadcasts/estimate (pure, no DB), POST /broadcasts, GET /broadcasts/:id
 */

const app = createApp(defaultDeps());

const port = Number(process.env.PORT_API ?? process.env.PORT ?? 3000);
console.log(`[api] listening on http://localhost:${port} (health: /health, openapi: /doc)`);

export default { port, fetch: app.fetch };
export { app };
