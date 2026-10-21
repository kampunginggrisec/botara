import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

/**
 * Botara API - Fase 0 entrypoint (Bun runtime; Bun-specific serving is
 * allowed here in apps/*, packages stay runtime-agnostic).
 *
 * Routes:
 *   GET /health  -> { status: "ok", service: "api" }
 *   GET /doc     -> OpenAPI JSON
 *   GET /        -> service banner
 */

const HealthResponse = z
  .object({ status: z.literal("ok"), service: z.literal("api") })
  .openapi("HealthResponse");

const app = new OpenAPIHono();

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: {
      description: "Service health",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

app.openapi(healthRoute, (c) => c.json({ status: "ok" as const, service: "api" as const }));

app.get("/", (c) => c.json({ name: "botara-api", phase: "Fase 0 scaffold" }));

app.doc("/doc", {
  openapi: "3.0.0",
  info: { title: "Botara API", version: "0.0.0", description: "Omnichannel chatbot platform API (Fase 0)" },
});

const port = Number(process.env.PORT_API ?? process.env.PORT ?? 3000);
console.log(`[api] listening on http://localhost:${port} (health: /health, openapi: /doc)`);

export default { port, fetch: app.fetch };
export { app };
