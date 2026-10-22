import { describe, expect, test } from "bun:test";
import {
  decideInboxRefresh, parseInboxMessageEvent, realtimeUrl, type InboxMessageEvent,
} from "./realtime";

/**
 * SPA realtime client, pure parts: frame parsing (foreign/garbled
 * frames must never reach the Inbox), the refresh decision matrix, and
 * the same-origin URL scheme pick. Socket behavior itself is exercised
 * end-to-end against apps/realtime in the deployment smoke.
 */

const event = (overrides: Partial<InboxMessageEvent> = {}): InboxMessageEvent => ({
  type: "inbox.message",
  workspaceId: "ws-1",
  conversationId: "conv-1",
  direction: "in",
  messageId: "m-1",
  ...overrides,
});

describe("realtimeUrl", () => {
  test("https pages use wss, http pages use ws, same host", () => {
    expect(realtimeUrl({ protocol: "https:", host: "botara.my.id" })).toBe("wss://botara.my.id/ws");
    expect(realtimeUrl({ protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/ws");
  });
});

describe("parseInboxMessageEvent", () => {
  test("a well-formed bus event parses", () => {
    expect(parseInboxMessageEvent(JSON.stringify(event()))).toEqual(event());
  });

  test("ready/error frames, garbage, and half-shaped events are ignored", () => {
    expect(parseInboxMessageEvent(JSON.stringify({ type: "ready", workspaces: ["ws-1"] }))).toBeNull();
    expect(parseInboxMessageEvent("not json")).toBeNull();
    expect(parseInboxMessageEvent(JSON.stringify({ type: "inbox.message", workspaceId: "ws-1" }))).toBeNull();
    expect(parseInboxMessageEvent(JSON.stringify(event({ direction: "sideways" as never })))).toBeNull();
  });
});

describe("decideInboxRefresh", () => {
  test("an event for another workspace changes nothing", () => {
    expect(decideInboxRefresh(event({ workspaceId: "ws-2" }), { workspaceId: "ws-1", openConversationId: "conv-1" }))
      .toEqual({ refreshList: false, refreshMessages: false });
  });

  test("an event for the current workspace refreshes the list only when another conversation is open", () => {
    expect(decideInboxRefresh(event(), { workspaceId: "ws-1", openConversationId: "conv-9" }))
      .toEqual({ refreshList: true, refreshMessages: false });
    expect(decideInboxRefresh(event(), { workspaceId: "ws-1", openConversationId: null }))
      .toEqual({ refreshList: true, refreshMessages: false });
  });

  test("an event for the open conversation refreshes list and messages", () => {
    expect(decideInboxRefresh(event(), { workspaceId: "ws-1", openConversationId: "conv-1" }))
      .toEqual({ refreshList: true, refreshMessages: true });
  });
});
