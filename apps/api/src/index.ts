import { createApp, defaultDeps } from "./app";

/**
 * Botara API entrypoint (Bun runtime). All route logic lives in app.ts
 * (createApp with injectable deps, used by tests and the smoke check);
 * this file only wires the production defaults and serves.
 *
 * Routes (Fase 1 + Fase 2):
 *   GET  /health, GET /doc (OpenAPI)
 *   GET+POST /webhooks/whatsapp (template category changes are applied),
 *   POST /webhooks/telegram, GET+POST /webhooks/instagram|messenger|threads,
 *   POST /webhooks/resend (Svix-verified)
 *   GET  /conversations, GET /conversations/:id/messages, POST /conversations/:id/reply
 *   POST /conversations/:id/ai-suggest, POST /moderation/check
 *   GET/POST /contacts, PATCH /contacts/:id, GET /segments
 *   GET/POST /templates, PATCH /templates/:id/category
 *   POST /broadcasts/estimate (pure, no DB), POST /broadcasts, GET /broadcasts/:id
 *   GET  /channels/accounts, POST /channels/whatsapp/embedded-signup/exchange
 *   POST /public/webchat/:workspaceId/session, GET+POST /public/webchat/:workspaceId/messages
 *   CRUD /posts + POST /posts/:id/publish-now
 *   CRUD /sequences + POST /sequences/:id/enroll
 */

const app = createApp(defaultDeps());

const port = Number(process.env.PORT_API ?? process.env.PORT ?? 3000);
console.log(`[api] listening on http://localhost:${port} (health: /health, openapi: /doc)`);

export default { port, fetch: app.fetch };
export { app };
