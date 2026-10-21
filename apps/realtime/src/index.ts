/**
 * Botara realtime - Fase 0 entrypoint.
 * Bun native WebSocket server (Bun.serve is intentionally used here:
 * Bun-specific APIs are allowed in apps/* entrypoints).
 *
 *   GET /health -> { status: "ok", service: "realtime" }
 *   GET /ws     -> WebSocket upgrade; on connect the client receives
 *                  { type: "welcome", service: "realtime" } and messages are echoed.
 */

const port = Number(process.env.PORT_REALTIME ?? 3002);

interface WsData { connectedAt: number }

const server = Bun.serve<WsData>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "realtime" });
    }
    if (url.pathname === "/ws") {
      const ok = srv.upgrade(req, { data: { connectedAt: Date.now() } });
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "welcome", service: "realtime" }));
    },
    message(ws, message) {
      // Fase 0: echo. Fase 1+: subscribe to workspace conversation topics.
      ws.send(JSON.stringify({ type: "echo", data: typeof message === "string" ? message : "<binary>" }));
    },
    close() {},
  },
});

console.log(`[realtime] listening on http://localhost:${server.port} (health: /health, ws: /ws)`);

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
