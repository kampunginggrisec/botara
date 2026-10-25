import { getToken } from "./api";

/**
 * Dashboard realtime client: keeps one WebSocket to the realtime
 * service (same-origin /ws, proxied to apps/realtime) and surfaces
 * inbox events (inbox.message, inbox.update) so the Inbox refreshes
 * itself - no more manual page reloads to see a new message or an
 * assignment change.
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

/**
 * Conversation metadata changed without a new message (today:
 * assignment). Same ids-only contract; the Inbox refetches the list and
 * the open thread's header state.
 */
export interface InboxUpdateEvent {
  type: "inbox.update";
  workspaceId: string;
  conversationId: string;
}

export type InboxRealtimeEvent = InboxMessageEvent | InboxUpdateEvent;

/** Same-origin WS URL for the realtime service. */
export function realtimeUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
}

/** Parse one raw frame; returns the message event or null for anything else. */
export function parseInboxMessageEvent(raw: string): InboxMessageEvent | null {
  const doc = parseFrame(raw);
  if (!doc) return null;
  if (doc.type !== "inbox.message") return null;
  if (typeof doc.workspaceId !== "string" || typeof doc.conversationId !== "string") return null;
  if (doc.direction !== "in" && doc.direction !== "out") return null;
  return {
    type: "inbox.message",
    workspaceId: doc.workspaceId,
    conversationId: doc.conversationId,
    direction: doc.direction,
    ...(typeof doc.messageId === "string" ? { messageId: doc.messageId } : {}),
  };
}

function parseFrame(raw: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(raw);
    if (typeof doc !== "object" || doc === null) return null;
    return doc as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse one raw frame into either inbox event kind; null for anything else. */
export function parseInboxEvent(raw: string): InboxRealtimeEvent | null {
  const message = parseInboxMessageEvent(raw);
  if (message) return message;
  const doc = parseFrame(raw);
  if (!doc || doc.type !== "inbox.update") return null;
  if (typeof doc.workspaceId !== "string" || typeof doc.conversationId !== "string") return null;
  return { type: "inbox.update", workspaceId: doc.workspaceId, conversationId: doc.conversationId };
}

/**
 * Pure refresh decision for one event (unit-tested): an event for the
 * CURRENT workspace refreshes the conversation list; when it targets
 * the open conversation its messages refetch too. inbox.update events
 * (assignment) refresh the list AND the open thread's header state -
 * the Inbox keys its header refresh off the messages flag, and an
 * update carries no message, so both flags go up for the open thread.
 * Anything else (stale workspace after a switch, other workspaces) is
 * ignored.
 */
export function decideInboxRefresh(
  event: InboxRealtimeEvent,
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
  onInboxMessage: (event: InboxRealtimeEvent) => void;
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
      const event = parseInboxEvent(raw);
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
