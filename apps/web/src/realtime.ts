import { getToken } from "./api";

/**
 * Dashboard realtime client: keeps one WebSocket to the realtime
 * service (same-origin /ws, proxied to apps/realtime) and surfaces
 * inbox.message events so the Inbox refreshes itself - no more manual
 * page reloads to see a new message.
 *
 * Protocol (see apps/realtime/src/server.ts): after connect, send
 * { type: "auth", token } with the session JWT; on { type: "ready" },
 * subscribe to the current workspace; the server then forwards
 * inbox.message events for that workspace only.
 *
 * Resilience: reconnects with capped exponential backoff; after 3
 * consecutive failed attempts the module flags itself degraded
 * (isRealtimeDegraded) and the Inbox falls back to a 30s poll until a
 * connection succeeds again. Events carry ids only - the Inbox always
 * refetches content through the REST API.
 */

export interface InboxMessageEvent {
  type: "inbox.message";
  workspaceId: string;
  conversationId: string;
  direction: "in" | "out";
  messageId?: string;
}

/** Same-origin WS URL for the realtime service. */
export function realtimeUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
}

/** Parse one raw frame; returns the event or null for anything else. */
export function parseInboxMessageEvent(raw: string): InboxMessageEvent | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const e = doc as Record<string, unknown>;
  if (e.type !== "inbox.message") return null;
  if (typeof e.workspaceId !== "string" || typeof e.conversationId !== "string") return null;
  if (e.direction !== "in" && e.direction !== "out") return null;
  return {
    type: "inbox.message",
    workspaceId: e.workspaceId,
    conversationId: e.conversationId,
    direction: e.direction,
    ...(typeof e.messageId === "string" ? { messageId: e.messageId } : {}),
  };
}

/**
 * Pure refresh decision for one event (unit-tested): an event for the
 * CURRENT workspace refreshes the conversation list; when it targets
 * the open conversation its messages refetch too. Anything else (stale
 * workspace after a switch, other workspaces) is ignored.
 */
export function decideInboxRefresh(
  event: InboxMessageEvent,
  current: { workspaceId: string; openConversationId: string | null },
): { refreshList: boolean; refreshMessages: boolean } {
  if (event.workspaceId !== current.workspaceId) {
    return { refreshList: false, refreshMessages: false };
  }
  return {
    refreshList: true,
    refreshMessages: current.openConversationId === event.conversationId,
  };
}

export interface RealtimeHandle {
  /** Re-subscribe after a workspace switch (no reconnect needed). */
  setWorkspace(workspaceId: string): void;
  /** Tear down permanently (logout): no reconnect is scheduled. */
  close(): void;
}

let degraded = false;
/** True once reconnects keep failing; the Inbox polls while this holds. */
export function isRealtimeDegraded(): boolean {
  return degraded;
}

const MAX_BACKOFF_MS = 30_000;
const DEGRADED_AFTER_ATTEMPTS = 3;

export function connectRealtime(options: {
  workspaceId: string;
  onInboxMessage: (event: InboxMessageEvent) => void;
}): RealtimeHandle {
  let socket: WebSocket | null = null;
  let currentWorkspace = options.workspaceId;
  let subscribedWorkspace: string | null = null;
  let ready = false;
  let stopped = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const sendSubscribe = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return;
    if (subscribedWorkspace && subscribedWorkspace !== currentWorkspace) {
      socket.send(JSON.stringify({ type: "unsubscribe", workspaceId: subscribedWorkspace }));
    }
    socket.send(JSON.stringify({ type: "subscribe", workspaceId: currentWorkspace }));
    subscribedWorkspace = currentWorkspace;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    attempts += 1;
    if (attempts >= DEGRADED_AFTER_ATTEMPTS) degraded = true;
    const delay = Math.min(1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = () => {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(realtimeUrl(location));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ready = false;
    ws.onopen = () => {
      const session = getToken();
      ws.send(JSON.stringify({ type: "auth", token: session }));
    };
    ws.onmessage = (frame) => {
      const raw = typeof frame.data === "string" ? frame.data : "";
      const event = parseInboxMessageEvent(raw);
      if (event) {
        options.onInboxMessage(event);
        return;
      }
      try {
        const doc = JSON.parse(raw) as { type?: string };
        if (doc.type === "ready") {
          ready = true;
          attempts = 0;
          degraded = false;
          sendSubscribe();
        }
      } catch { /* non-JSON frame - ignore */ }
    };
    ws.onclose = () => {
      ready = false;
      subscribedWorkspace = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      // Browsers always follow with onclose, which owns the reconnect.
      try { ws.close(); } catch { /* already closing */ }
    };
  };

  open();

  return {
    setWorkspace(workspaceId: string) {
      if (workspaceId === currentWorkspace) return;
      currentWorkspace = workspaceId;
      sendSubscribe();
    },
    close() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try { socket?.close(); } catch { /* already closed */ }
      socket = null;
    },
  };
}
