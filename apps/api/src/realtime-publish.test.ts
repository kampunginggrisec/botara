import { describe, expect, test } from "bun:test";
import {
  InMemoryDispatchStore, createFlowDispatcher,
} from "./flows-dispatch";
import {
  REALTIME_CHANNEL, createRealtimePublisher, noopRealtimePublisher,
  type RealtimePublisher,
} from "./realtime-publish";
import type { InboundEvent } from "@botara/channels";

/**
 * Realtime publishing: the publisher serializes inbox.message events onto
 * the botara:realtime channel and NEVER rejects (fire-and-forget), and
 * the inbound dispatcher emits exactly one event per newly persisted
 * message - webhook redeliveries publish nothing.
 */

describe("createRealtimePublisher", () => {
  test("publishes a serialized inbox.message event on the realtime channel", async () => {
    const calls: Array<{ channel: string; payload: string }> = [];
    const publisher = createRealtimePublisher(async (channel, payload) => {
      calls.push({ channel, payload });
    });
    await publisher.publishInboxMessage({
      workspaceId: "ws-1", conversationId: "conv-1", direction: "in", messageId: "m-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe(REALTIME_CHANNEL);
    expect(JSON.parse(calls[0]!.payload)).toEqual({
      type: "inbox.message", workspaceId: "ws-1", conversationId: "conv-1",
      direction: "in", messageId: "m-1",
    });
  });

  test("never rejects when the transport fails", async () => {
    const publisher = createRealtimePublisher(async () => {
      throw new Error("redis is down");
    });
    await expect(
      publisher.publishInboxMessage({ workspaceId: "ws-1", conversationId: "c-1", direction: "out" }),
    ).resolves.toBeUndefined();
    await expect(
      noopRealtimePublisher.publishInboxMessage({ workspaceId: "w", conversationId: "c", direction: "in" }),
    ).resolves.toBeUndefined();
  });

  test("publishes a serialized inbox.update event for metadata changes (assignment)", async () => {
    const calls: Array<{ channel: string; payload: string }> = [];
    const publisher = createRealtimePublisher(async (channel, payload) => {
      calls.push({ channel, payload });
    });
    await publisher.publishInboxUpdate({ workspaceId: "ws-1", conversationId: "conv-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe(REALTIME_CHANNEL);
    expect(JSON.parse(calls[0]!.payload)).toEqual({
      type: "inbox.update", workspaceId: "ws-1", conversationId: "conv-1",
    });
    // The noop publisher covers both methods too.
    await expect(
      noopRealtimePublisher.publishInboxUpdate({ workspaceId: "w", conversationId: "c" }),
    ).resolves.toBeUndefined();
  });
});

describe("dispatcher realtime wiring", () => {
  function setup() {
    const store = new InMemoryDispatchStore();
    store.accounts.push({
      id: "acc-tg", workspaceId: "ws-1", channel: "telegram", externalId: "555", status: "connected",
    });
    const events: Array<Parameters<RealtimePublisher["publishInboxMessage"]>[0]> = [];
    const publisher: RealtimePublisher = {
      async publishInboxMessage(event) { events.push(event); },
      async publishInboxUpdate() {},
    };
    const dispatcher = createFlowDispatcher({
      store,
      flowEnqueuer: { async enqueueFlowRun() {} },
      publisher,
    });
    return { store, dispatcher, events };
  }

  const tgMessage = (externalId: string, text = "hello"): InboundEvent => ({
    type: "message.received", channel: "telegram", accountExternalId: "555",
    contactExternalId: "u-1", messageExternalId: externalId,
    text, receivedAt: new Date().toISOString(),
  });

  test("one event per newly persisted inbound message", async () => {
    const { dispatcher, events } = setup();
    await dispatcher.dispatch([tgMessage("m-1")]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId: "ws-1", direction: "in" });
    expect(typeof events[0]!.conversationId).toBe("string");
    expect(typeof events[0]!.messageId).toBe("string");
  });

  test("a redelivered webhook (same provider message id) publishes nothing new", async () => {
    const { store, dispatcher, events } = setup();
    await dispatcher.dispatch([tgMessage("m-1")]);
    await dispatcher.dispatch([tgMessage("m-1")]);
    expect(store.messages).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("a dispatcher without a publisher still persists (publisher is optional)", async () => {
    const store = new InMemoryDispatchStore();
    store.accounts.push({
      id: "acc-tg", workspaceId: "ws-1", channel: "telegram", externalId: "555", status: "connected",
    });
    const dispatcher = createFlowDispatcher({
      store,
      flowEnqueuer: { async enqueueFlowRun() {} },
    });
    await dispatcher.dispatch([tgMessage("m-9")]);
    expect(store.messages).toHaveLength(1);
  });
});
