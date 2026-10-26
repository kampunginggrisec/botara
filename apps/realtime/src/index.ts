import IORedis from "ioredis";
import { PRESENCE_TTL_SECONDS, presenceKey } from "@botara/shared";
import {
  RealtimeHub, createApiWorkspaceResolver, type PresenceSink, type RealtimeSocket,
} from "./server";

/**
 * Botara realtime - WebSocket fan-out for live inbox updates.
 *
 *   GET /health -> { status: "ok", service: "realtime" }
 *   GET /ws     -> WebSocket upgrade. Protocol (see server.ts): the
 *                  client authenticates with { type: "auth", token } as
 *                  its FIRST message, receives { type: "ready" }, then
 *                  subscribes to its workspaces; inbox.message events
 *                  from the Redis bus (`botara:realtime`, published by
 *                  apps/api - the channel name is the shared contract,
 *                  pinned by tests on both sides) are forwarded to
 *                  subscribed sockets only.
 *
 * Env: PORT_REALTIME (3002), SESSION_SECRET (required for auth),
 * REDIS_URL (redis://localhost:6379), BOTARA_API_URL - the DIRECT API
 * address used for GET /auth/me workspace resolution, no /api prefix
 * (default http://localhost:3001, the native/trial API port; in the
 * production compose the realtime service sets http://api:3000).
 * All hub logic lives in server.ts over injectable ports; this file is
 * only Bun.serve + ioredis wiring.
 */

/** Redis pub/sub channel shared with apps/api's realtime publisher. */
const REALTIME_CHANNEL = "botara:realtime";

const port = Number(process.env.PORT_REALTIME ?? 3002);
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const apiBaseUrl = process.env.BOTARA_API_URL ?? "http://localhost:3001";

if (!process.env.SESSION_SECRET) {
  console.error("[realtime] SESSION_SECRET is not set - every socket auth will fail closed until it is configured.");
}

/**
 * Presence writer (#9): a DEDICATED command connection (the subscriber
 * connection above cannot issue commands). Stamps
 * `presence:{workspaceId}:{userId}` = "1" with the shared TTL on auth +
 * every client ping; deletes the keys when the user's last socket
 * closes. All operations are fire-and-forget - presence is a hint for
 * the members list and must never disturb the socket path.
 */
const presenceRedis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
presenceRedis.on("error", (err) => {
  console.error(`[realtime] redis presence error: ${err.message || String(err)}`);
});
const presence: PresenceSink = {
  touch(userId, workspaceIds) {
    if (workspaceIds.length === 0) return;
    const pipeline = presenceRedis.pipeline();
    for (const workspaceId of workspaceIds) {
      pipeline.set(presenceKey(workspaceId, userId), "1", "EX", PRESENCE_TTL_SECONDS);
    }
    pipeline.exec().catch(() => undefined);
  },
  clear(userId, workspaceIds) {
    if (workspaceIds.length === 0) return;
    presenceRedis.del(...workspaceIds.map((workspaceId) => presenceKey(workspaceId, userId))).catch(() => undefined);
  },
};

const hub = new RealtimeHub({
  sessionSecret: process.env.SESSION_SECRET,
  resolveWorkspaces: createApiWorkspaceResolver(apiBaseUrl),
  presence,
});

// Dedicated subscriber connection (a Redis connection in subscribe mode
// cannot issue other commands). Reconnects are automatic; ioredis
// re-subscribes on reconnect, and we also (re)subscribe on "ready".
const subscriber = new IORedis(redisUrl, {
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
subscriber.on("error", (err) => {
  console.error(`[realtime] redis subscriber error: ${err.message || String(err)}`);
});
subscriber.on("ready", () => {
  subscriber.subscribe(REALTIME_CHANNEL).catch((err: Error) => {
    console.error(`[realtime] subscribe failed: ${err.message}`);
  });
});
subscriber.on("message", (_channel: string, payload: string) => {
  hub.handleBusMessage(payload);
});

interface WsData { state: ReturnType<RealtimeHub["handleOpen"]> | null }

const server = Bun.serve<WsData>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "realtime" });
    }
    if (url.pathname === "/ws") {
      const ok = srv.upgrade(req, { data: { state: null } });
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const socket: RealtimeSocket = {
        send: (data) => { ws.send(data); },
        close: (code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } },
      };
      ws.data.state = hub.handleOpen(socket);
    },
    message(ws, message) {
      if (!ws.data.state) return;
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      void hub.handleMessage(ws.data.state, raw);
    },
    close(ws) {
      if (ws.data.state) hub.handleClose(ws.data.state);
    },
  },
});

console.log(`[realtime] listening on http://localhost:${server.port} (health: /health, ws: /ws, api: ${apiBaseUrl})`);

process.on("SIGTERM", () => {
  subscriber.disconnect();
  presenceRedis.disconnect();
  server.stop(true);
  process.exit(0);
});
