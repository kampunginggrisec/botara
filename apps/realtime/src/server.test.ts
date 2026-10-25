import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  RealtimeHub, verifySessionToken, type RealtimeSocket,
} from "./server";

/**
 * Realtime hub over fake sockets + a fake workspace resolver: the JWT
 * gate (good / forged / expired), workspace-scoped subscriptions
 * (foreign workspaces refused), bus fan-out only to subscribed sockets,
 * and the unauthenticated-socket timeout.
 */

const SECRET = "test-realtime-secret";

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function validToken(userId = "user-1"): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: userId, email: "a@example.com", iat: now, exp: now + 3600 });
}

class FakeSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closedWith = { code, reason }; }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function setup(overrides: { authTimeoutMs?: number } = {}) {
  const hub = new RealtimeHub({
    sessionSecret: SECRET,
    // user-1 belongs to ws-1 + ws-2; anything else fails verification.
    resolveWorkspaces: async (token) => {
      const claims = verifySessionToken(token, SECRET);
      return claims ? ["ws-1", "ws-2"] : null;
    },
    authTimeoutMs: overrides.authTimeoutMs ?? 10_000,
  });
  return hub;
}

async function authedSocket(hub: RealtimeHub): Promise<{ socket: FakeSocket; state: ReturnType<RealtimeHub["handleOpen"]> }> {
  const socket = new FakeSocket();
  const state = hub.handleOpen(socket);
  await hub.handleMessage(state, JSON.stringify({ type: "auth", token: validToken() }));
  return { socket, state };
}

const busEvent = (workspaceId: string, conversationId = "conv-1") => JSON.stringify({
  type: "inbox.message", workspaceId, conversationId, direction: "in", messageId: "m-1",
});

describe("auth gate", () => {
  test("a valid token gets ready with the verified workspace set", async () => {
    const hub = setup();
    const { socket } = await authedSocket(hub);
    expect(socket.frames()).toEqual([{ type: "ready", workspaces: ["ws-1", "ws-2"] }]);
    expect(socket.closedWith).toBeNull();
  });

  test("a forged signature is rejected and the socket closed", async () => {
    const hub = setup();
    const socket = new FakeSocket();
    const state = hub.handleOpen(socket);
    const now = Math.floor(Date.now() / 1000);
    await hub.handleMessage(state, JSON.stringify({
      type: "auth", token: sign({ sub: "user-1", email: "a@example.com", iat: now, exp: now + 3600 }, "wrong-secret"),
    }));
    expect(socket.frames()[0]).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(socket.closedWith?.code).toBe(4401);
  });

  test("an expired token is rejected", async () => {
    const hub = setup();
    const socket = new FakeSocket();
    const state = hub.handleOpen(socket);
    const now = Math.floor(Date.now() / 1000);
    await hub.handleMessage(state, JSON.stringify({
      type: "auth", token: sign({ sub: "user-1", email: "a@example.com", iat: now - 7200, exp: now - 3600 }),
    }));
    expect(socket.frames()[0]).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(socket.closedWith?.code).toBe(4401);
  });

  test("a socket that never authenticates is closed after the timeout and receives nothing", async () => {
    const hub = setup({ authTimeoutMs: 25 });
    const socket = new FakeSocket();
    const state = hub.handleOpen(socket);
    await hub.handleMessage(state, JSON.stringify({ type: "subscribe", workspaceId: "ws-1" }));
    expect(socket.frames()[0]).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    hub.handleBusMessage(busEvent("ws-1"));
    expect(socket.frames().filter((f) => f.type === "inbox.message")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.closedWith?.code).toBe(4408);
    hub.handleClose(state);
  });
});

describe("workspace-scoped fan-out", () => {
  test("events reach only sockets subscribed to that workspace", async () => {
    const hub = setup();
    const a = await authedSocket(hub);
    const b = await authedSocket(hub);
    await hub.handleMessage(a.state, JSON.stringify({ type: "subscribe", workspaceId: "ws-1" }));
    await hub.handleMessage(b.state, JSON.stringify({ type: "subscribe", workspaceId: "ws-2" }));
    expect(a.socket.frames().at(-1)).toEqual({ type: "subscribed", workspaceId: "ws-1" });

    hub.handleBusMessage(busEvent("ws-1"));
    expect(a.socket.frames().filter((f) => f.type === "inbox.message")).toHaveLength(1);
    expect(b.socket.frames().filter((f) => f.type === "inbox.message")).toHaveLength(0);

    hub.handleBusMessage(busEvent("ws-2"));
    expect(b.socket.frames().filter((f) => f.type === "inbox.message")).toHaveLength(1);
  });

  test("inbox.update events (assignment changes) fan out to subscribers too", async () => {
    const hub = setup();
    const a = await authedSocket(hub);
    const b = await authedSocket(hub);
    await hub.handleMessage(a.state, JSON.stringify({ type: "subscribe", workspaceId: "ws-1" }));
    await hub.handleMessage(b.state, JSON.stringify({ type: "subscribe", workspaceId: "ws-2" }));
    hub.handleBusMessage(JSON.stringify({
      type: "inbox.update", workspaceId: "ws-1", conversationId: "conv-1",
    }));
    const updates = a.socket.frames().filter((f) => f.type === "inbox.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ type: "inbox.update", workspaceId: "ws-1", conversationId: "conv-1" });
    expect(b.socket.frames().filter((f) => f.type === "inbox.update")).toHaveLength(0);
  });

  test("subscribing to a workspace outside the verified set is refused", async () => {
    const hub = setup();
    const { socket, state } = await authedSocket(hub);
    await hub.handleMessage(state, JSON.stringify({ type: "subscribe", workspaceId: "ws-other" }));
    expect(socket.frames().at(-1)).toMatchObject({ type: "error", code: "FORBIDDEN" });
    hub.handleBusMessage(busEvent("ws-other"));
    expect(socket.frames().filter((f) => f.type === "inbox.message")).toHaveLength(0);
  });

  test("unsubscribe stops delivery; malformed frames and bus noise are survived", async () => {
    const hub = setup();
    const { socket, state } = await authedSocket(hub);
    await hub.handleMessage(state, JSON.stringify({ type: "subscribe", workspaceId: "ws-1" }));
    await hub.handleMessage(state, JSON.stringify({ type: "unsubscribe", workspaceId: "ws-1" }));
    hub.handleBusMessage(busEvent("ws-1"));
    expect(socket.frames().filter((f) => f.type === "inbox.message")).toHaveLength(0);

    await hub.handleMessage(state, "not json at all");
    expect(socket.frames().at(-1)).toMatchObject({ type: "error", code: "INVALID" });
    hub.handleBusMessage("not json either");
    hub.handleBusMessage(JSON.stringify({ type: "something.else", workspaceId: "ws-1" }));
    expect(socket.closedWith).toBeNull();
  });
});
