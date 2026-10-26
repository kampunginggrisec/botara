import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Botara realtime hub: authenticated WebSocket fan-out for inbox updates.
 *
 * Protocol (JSON text frames):
 *   client -> server, FIRST message: { "type": "auth", "token": "<session JWT>" }
 *   server -> client: { "type": "ready", "workspaces": ["<id>", ...] }
 *     once the token verified AND the API confirmed the user's workspaces.
 *   client -> server: { "type": "subscribe", "workspaceId": "<id>" }
 *                     { "type": "unsubscribe", "workspaceId": "<id>" }
 *                     { "type": "ping" }  (presence heartbeat, #9)
 *   server -> client: { "type": "subscribed" | "unsubscribed", "workspaceId" }
 *                     { "type": "pong" }  (answer to a ping)
 *                     { "type": "error", "code", "message" }
 *                     inbox.message / inbox.update events from the
 *                     `botara:realtime` bus, forwarded verbatim, ONLY for
 *                     subscribed workspaces that are in the socket's
 *                     verified workspace set.
 *
 * Presence (#9): on auth and on every ping the hub touches the
 * injected presence sink for the user's full verified workspace set;
 * when the user's last socket closes the sink clears it. The members
 * list in the API reads those keys as "online".
 *
 * Security model: the JWT is verified locally (HS256, SESSION_SECRET -
 * the same scheme the API signs with, mirrored below), and workspace
 * membership is resolved ONCE per connection from the API's GET /auth/me
 * with the presented token. Events for any other workspace can never
 * reach the socket: subscriptions outside the verified set are refused.
 * A socket that never authenticates is closed after `authTimeoutMs`.
 */

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeDeps {
  /** SESSION_SECRET; when undefined every auth attempt fails closed. */
  sessionSecret: string | undefined;
  /** Resolve the workspace ids a session token grants access to (API /auth/me). */
  resolveWorkspaces: (token: string) => Promise<string[] | null>;
  /** Close unauthenticated sockets after this long (default 10s). */
  authTimeoutMs?: number;
  /**
   * Member presence sink (package #9): called on auth + every client
   * ping (touch) and when a user's LAST socket closes (clear). The
   * production sink writes Redis keys with the shared TTL; failures
   * inside the sink must never break the hub - implementations swallow.
   */
  presence?: PresenceSink;
}

/**
 * Presence writer port (see @botara/shared presence.ts for the key +
 * TTL contract). Both calls receive the socket's FULL verified
 * workspace set: presence is per membership, not per subscription.
 */
export interface PresenceSink {
  touch(userId: string, workspaceIds: string[]): void;
  clear(userId: string, workspaceIds: string[]): void;
}

export interface SessionClaims { userId: string; email: string }

/**
 * Verify a Botara session JWT - a deliberate mirror of
 * apps/api/src/auth.ts verifySessionToken (HS256, alg pin, timing-safe
 * compare, exp check) so the realtime service needs no API import.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  now = new Date(),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let headerJson: { alg?: string };
  try {
    headerJson = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
  } catch {
    return null;
  }
  if (headerJson.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: { sub?: string; email?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return null;
  }
  if (!claims.sub || typeof claims.exp !== "number") return null;
  if (claims.exp * 1000 <= now.getTime()) return null;
  return { userId: claims.sub, email: claims.email ?? "" };
}

interface ConnState {
  socket: RealtimeSocket;
  authed: boolean;
  userId: string | null;
  workspaces: Set<string>;
  subscriptions: Set<string>;
  authTimer: ReturnType<typeof setTimeout> | null;
}

export class RealtimeHub {
  private readonly conns = new Set<ConnState>();
  private readonly authTimeoutMs: number;

  constructor(private readonly deps: RealtimeDeps) {
    this.authTimeoutMs = deps.authTimeoutMs ?? 10_000;
  }

  handleOpen(socket: RealtimeSocket): ConnState {
    const state: ConnState = {
      socket,
      authed: false,
      userId: null,
      workspaces: new Set(),
      subscriptions: new Set(),
      authTimer: setTimeout(() => {
        if (!state.authed) socket.close(4408, "authentication timeout");
      }, this.authTimeoutMs),
    };
    this.conns.add(state);
    return state;
  }

  handleClose(state: ConnState): void {
    if (state.authTimer) clearTimeout(state.authTimer);
    this.conns.delete(state);
    // Presence: only the user's LAST open socket clears the keys - a
    // second tab closing must not mark them offline in the first.
    if (state.authed && state.userId && this.deps.presence) {
      const stillConnected = [...this.conns].some(
        (conn) => conn.authed && conn.userId === state.userId,
      );
      if (!stillConnected) {
        this.deps.presence.clear(state.userId, [...state.workspaces]);
      }
    }
  }

  /** Redis bus fan-in: forward inbox.message / inbox.update payloads to subscribers. */
  handleBusMessage(payload: string): void {
    let event: { type?: string; workspaceId?: string };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      return; // Not ours / not JSON - the bus is shared, stay silent.
    }
    if ((event.type !== "inbox.message" && event.type !== "inbox.update") || !event.workspaceId) return;
    for (const conn of this.conns) {
      if (conn.authed && conn.subscriptions.has(event.workspaceId)) {
        try { conn.socket.send(payload); } catch { /* a dying socket must not break fan-out */ }
      }
    }
  }

  async handleMessage(state: ConnState, raw: string): Promise<void> {
    let msg: { type?: string; token?: string; workspaceId?: string };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      this.sendError(state, "INVALID", "Messages must be JSON.");
      return;
    }
    switch (msg.type) {
      case "auth":
        await this.handleAuth(state, msg.token);
        return;
      case "subscribe":
        this.handleSubscribe(state, msg.workspaceId, true);
        return;
      case "unsubscribe":
        this.handleSubscribe(state, msg.workspaceId, false);
        return;
      case "ping":
        this.handlePing(state);
        return;
      default:
        this.sendError(state, "INVALID", `Unknown message type: ${String(msg.type)}`);
    }
  }

  /**
   * Presence heartbeat (package #9): the client pings every
   * PRESENCE_HEARTBEAT_MS; each ping re-stamps the user's presence
   * keys before their TTL lapses and earns a pong so the client can
   * tell a live socket from a zombie one.
   */
  private handlePing(state: ConnState): void {
    if (!state.authed || !state.userId) {
      this.sendError(state, "UNAUTHORIZED", "Authenticate before pinging.");
      return;
    }
    this.deps.presence?.touch(state.userId, [...state.workspaces]);
    try {
      state.socket.send(JSON.stringify({ type: "pong" }));
    } catch { /* dying socket - the close handler owns cleanup */ }
  }

  private async handleAuth(state: ConnState, token: string | undefined): Promise<void> {
    if (state.authed) {
      this.sendError(state, "INVALID", "This socket is already authenticated.");
      return;
    }
    if (!this.deps.sessionSecret) {
      this.sendError(state, "CONFIGURATION", "Realtime is not configured (SESSION_SECRET missing).");
      state.socket.close(4503, "realtime not configured");
      return;
    }
    const claims = token ? verifySessionToken(token, this.deps.sessionSecret) : null;
    if (!claims) {
      this.sendError(state, "UNAUTHORIZED", "Invalid or expired session token.");
      state.socket.close(4401, "unauthorized");
      return;
    }
    let workspaces: string[] | null;
    try {
      workspaces = await this.deps.resolveWorkspaces(token!);
    } catch {
      workspaces = null;
    }
    if (!workspaces) {
      this.sendError(state, "UNAUTHORIZED", "Session could not be verified with the API.");
      state.socket.close(4401, "unverifiable session");
      return;
    }
    state.authed = true;
    state.userId = claims.userId;
    state.workspaces = new Set(workspaces);
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    // Presence (#9): an authenticated socket makes the member online
    // in every workspace the API verified for them.
    this.deps.presence?.touch(claims.userId, workspaces);
    state.socket.send(JSON.stringify({ type: "ready", workspaces }));
  }

  private handleSubscribe(state: ConnState, workspaceId: string | undefined, subscribe: boolean): void {
    if (!state.authed) {
      this.sendError(state, "UNAUTHORIZED", "Authenticate before subscribing.");
      return;
    }
    if (!workspaceId) {
      this.sendError(state, "INVALID", "workspaceId is required.");
      return;
    }
    if (!state.workspaces.has(workspaceId)) {
      this.sendError(state, "FORBIDDEN", "You are not a member of that workspace.");
      return;
    }
    if (subscribe) state.subscriptions.add(workspaceId);
    else state.subscriptions.delete(workspaceId);
    state.socket.send(JSON.stringify({ type: subscribe ? "subscribed" : "unsubscribed", workspaceId }));
  }

  private sendError(state: ConnState, code: string, message: string): void {
    try {
      state.socket.send(JSON.stringify({ type: "error", code, message }));
    } catch { /* socket already gone */ }
  }
}

/**
 * Production resolveWorkspaces over the API's GET /auth/me. The API base
 * is the DIRECT api address (no /api proxy prefix): locally
 * http://localhost:3001 (trial/native) - set BOTARA_API_URL per
 * deployment (compose: http://api:3000).
 */
export function createApiWorkspaceResolver(apiBaseUrl: string): (token: string) => Promise<string[] | null> {
  const base = apiBaseUrl.replace(/\/$/, "");
  return async (token: string) => {
    const res = await fetch(`${base}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { workspaces?: Array<{ id?: string }> };
    if (!Array.isArray(body.workspaces)) return null;
    return body.workspaces.map((w) => w.id).filter((id): id is string => typeof id === "string");
  };
}
