import { describe, expect, test } from "bun:test";
import { createOutboundWebhookEmitter } from "./outbound-webhooks";
import {
  InMemoryDispatchStore, createFlowDispatcher,
  type FlowRunJobPayload, type OutboundWebhookEmitter,
} from "./flows-dispatch";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import type { InboundEvent } from "@botara/channels";

/**
 * Outbound webhooks (package #10) - emission side:
 * - the production emitter fans out only to enabled endpoints of the
 *   SAME workspace subscribed to the event, stores the exact envelope,
 *   and never throws (a dead queue must not break message processing);
 * - the dispatcher emits conversation.created only for genuine
 *   creations (not the #0 race-fallback reuse), message.received only
 *   for newly persisted messages, and message.status only when a
 *   mirror actually advanced a row.
 */

// ------------------------------------------------------------- emitter

function seedEndpoint(fake: FakeDatabase, over: Record<string, unknown> = {}): string {
  const row = fake.seed("webhookEndpoints", {
    workspaceId: "ws-1",
    name: "Hook",
    url: "https://93.184.216.34/hook",
    secretSealed: "sealed",
    events: ["message.received"],
    enabled: true,
    consecutiveFailures: 0,
    disabledAt: null,
    disabledBySystem: null,
    updatedAt: new Date(),
    ...over,
  });
  return row.id as string;
}

describe("outbound webhook emitter", () => {
  test("fans out to subscribed enabled endpoints of the workspace only, storing the envelope", async () => {
    const fake = createFakeDatabase();
    const mine = seedEndpoint(fake);
    seedEndpoint(fake, { events: ["message.status"] }); // not subscribed to this event
    seedEndpoint(fake, { enabled: false }); // disabled
    seedEndpoint(fake, { workspaceId: "ws-2" }); // foreign workspace
    const enqueued: string[] = [];
    const emitter = createOutboundWebhookEmitter({
      getDatabase: () => fake.db,
      enqueuer: { async enqueueWebhookDelivery(id) { enqueued.push(id); } },
      log: () => undefined,
    });
    await emitter.emit({
      workspaceId: "ws-1", type: "message.received",
      data: { messageId: "m-1", preview: "halo" },
    });
    expect(fake.rows.webhookDeliveries).toHaveLength(1);
    const delivery = fake.rows.webhookDeliveries[0]!;
    expect(delivery.endpointId).toBe(mine);
    expect(delivery.workspaceId).toBe("ws-1");
    expect(delivery.status).toBe("pending");
    expect(enqueued).toEqual([String(delivery.id)]);
    const payload = delivery.payload as { id: string; type: string; workspaceId: string; data: { preview: string } };
    expect(payload.id).toBe(String(delivery.id));
    expect(payload.type).toBe("message.received");
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.data.preview).toBe("halo");
  });

  test("a failing enqueue never throws and never starves other endpoints", async () => {
    const fake = createFakeDatabase();
    seedEndpoint(fake);
    seedEndpoint(fake);
    let calls = 0;
    const emitter = createOutboundWebhookEmitter({
      getDatabase: () => fake.db,
      enqueuer: {
        async enqueueWebhookDelivery() {
          calls += 1;
          if (calls === 1) throw new Error("redis down");
        },
      },
      log: () => undefined,
    });
    await expect(emitter.emit({ workspaceId: "ws-1", type: "message.received", data: {} })).resolves.toBeUndefined();
    expect(calls).toBe(2); // second endpoint still attempted
    expect(fake.rows.webhookDeliveries).toHaveLength(2);
  });

  test("an endpoint-store failure is swallowed (emit resolves)", async () => {
    const emitter = createOutboundWebhookEmitter({
      getDatabase: () => { throw new Error("db down"); },
      enqueuer: { async enqueueWebhookDelivery() {} },
      log: () => undefined,
    });
    await expect(emitter.emit({ workspaceId: "ws-1", type: "message.received", data: {} })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------- dispatcher

interface Emitted { workspaceId: string; type: string; data: Record<string, unknown> }

function dispatcherRig(store: InMemoryDispatchStore, emitted: Emitted[]) {
  store.accounts.push({
    id: "acc-ig", workspaceId: "ws-1", channel: "instagram", externalId: "ig-1", status: "connected",
  });
  store.accounts.push({
    id: "acc-wa", workspaceId: "ws-1", channel: "whatsapp", externalId: "10987", status: "connected",
  });
  const flowRuns: FlowRunJobPayload[] = [];
  const emitter: OutboundWebhookEmitter = {
    async emit(input) { emitted.push({ workspaceId: input.workspaceId, type: input.type, data: input.data }); },
  };
  const dispatcher = createFlowDispatcher({
    store,
    flowEnqueuer: { async enqueueFlowRun(job) { flowRuns.push(job); } },
    webhookEmitter: emitter,
  });
  return { dispatcher, flowRuns };
}

const igMessage = (text: string, messageExternalId = `m-${Math.random()}`): InboundEvent => ({
  type: "message.received", channel: "instagram", accountExternalId: "ig-1",
  contactExternalId: "u-1", messageExternalId,
  text, receivedAt: new Date().toISOString(),
});

describe("dispatcher webhook emission", () => {
  test("first message emits conversation.created then message.received; the next only message.received", async () => {
    const emitted: Emitted[] = [];
    const { dispatcher } = dispatcherRig(new InMemoryDispatchStore(), emitted);
    await dispatcher.dispatch([igMessage("halo")]);
    expect(emitted.map((e) => e.type)).toEqual(["conversation.created", "message.received"]);
    const received = emitted[1]!;
    expect(received.workspaceId).toBe("ws-1");
    expect(received.data.channel).toBe("instagram");
    expect(received.data.preview).toBe("halo");
    expect(typeof received.data.messageId).toBe("string");
    expect(typeof received.data.conversationId).toBe("string");

    emitted.length = 0;
    await dispatcher.dispatch([igMessage("lagi")]);
    expect(emitted.map((e) => e.type)).toEqual(["message.received"]);
  });

  test("a redelivered message (same provider id) emits nothing", async () => {
    const emitted: Emitted[] = [];
    const { dispatcher } = dispatcherRig(new InMemoryDispatchStore(), emitted);
    await dispatcher.dispatch([igMessage("halo", "m-dup")]);
    emitted.length = 0;
    await dispatcher.dispatch([igMessage("halo", "m-dup")]);
    expect(emitted).toEqual([]);
  });

  test("the preview is capped at 200 chars", async () => {
    const emitted: Emitted[] = [];
    const { dispatcher } = dispatcherRig(new InMemoryDispatchStore(), emitted);
    await dispatcher.dispatch([igMessage("x".repeat(500))]);
    const received = emitted.find((e) => e.type === "message.received")!;
    expect((received.data.preview as string).length).toBe(200);
  });

  test("race-fallback conversation reuse does NOT emit conversation.created", async () => {
    // The #0 hardening: findOpenConversation missed, but a concurrent
    // event won the insert race and createConversation returned THAT
    // thread (createdNew=false). The webhook must stay silent about a
    // "creation" that never happened here.
    // A real UUID: InMemoryDispatchStore infers its id as the
    // `crypto.randomUUID()` template-literal type, so the override has to
    // return that shape rather than an arbitrary string.
    const WINNER_ID = "11111111-1111-4111-8111-111111111111";
    type CreatedConversation = Awaited<ReturnType<InMemoryDispatchStore["createConversation"]>>;
    class RaceLosingStore extends InMemoryDispatchStore {
      override async createConversation(
        input: { workspaceId: string; channelAccountId: string; contactId: string; externalId?: string },
      ): Promise<CreatedConversation> {
        const winner: CreatedConversation = { id: WINNER_ID, ...input, createdNew: false };
        this.conversations.set(winner.id, winner);
        return winner;
      }
    }
    const emitted: Emitted[] = [];
    const { dispatcher } = dispatcherRig(new RaceLosingStore(), emitted);
    await dispatcher.dispatch([igMessage("halo")]);
    expect(emitted.map((e) => e.type)).toEqual(["message.received"]);
    expect(emitted[0]!.data.conversationId).toBe(WINNER_ID);
  });

  test("an exploding emitter never breaks dispatch", async () => {
    const store = new InMemoryDispatchStore();
    store.accounts.push({
      id: "acc-ig", workspaceId: "ws-1", channel: "instagram", externalId: "ig-1", status: "connected",
    });
    const dispatcher = createFlowDispatcher({
      store,
      flowEnqueuer: { async enqueueFlowRun() {} },
      webhookEmitter: { async emit() { throw new Error("emitter exploded"); } },
    });
    await dispatcher.dispatch([igMessage("halo")]);
    expect(store.messages).toHaveLength(1); // persisted despite the failure
  });

  test("message.status emits only when a mirror actually advances a row", async () => {
    const emitted: Emitted[] = [];
    const store = new InMemoryDispatchStore();
    const { dispatcher } = dispatcherRig(store, emitted);
    store.broadcastRecipients.push({
      id: "rec-1", broadcastId: "b-1", workspaceId: "ws-1", contactId: "ct-1",
      status: "sent", providerMessageId: "wamid.X", error: null,
      sentAt: new Date(), deliveredAt: null, readAt: null, repliedAt: null,
      createdAt: new Date(),
    } as never);
    const waStatus = (status: "delivered" | "read"): InboundEvent => ({
      type: "message.status", channel: "whatsapp", accountExternalId: "10987",
      messageExternalId: "wamid.X", status, receivedAt: new Date().toISOString(),
    });
    await dispatcher.dispatch([waStatus("delivered")]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("message.status");
    expect(emitted[0]!.data).toMatchObject({
      status: "delivered", broadcastId: "b-1", recipientId: "rec-1", contactId: "ct-1",
      providerMessageId: "wamid.X", channel: "whatsapp",
    });
    // Duplicate / out-of-order receipts move nothing and emit nothing.
    await dispatcher.dispatch([waStatus("delivered")]);
    expect(emitted).toHaveLength(1);
    await dispatcher.dispatch([waStatus("read")]);
    expect(emitted).toHaveLength(2);
    await dispatcher.dispatch([waStatus("delivered")]);
    expect(emitted).toHaveLength(2);
    // Unknown provider ids are silent too.
    await dispatcher.dispatch([{
      type: "message.status", channel: "whatsapp", accountExternalId: "10987",
      messageExternalId: "wamid.UNKNOWN", status: "delivered", receivedAt: new Date().toISOString(),
    }]);
    expect(emitted).toHaveLength(2);
  });

  test("message.status via the inbox mirror carries message + conversation ids", async () => {
    const emitted: Emitted[] = [];
    const store = new InMemoryDispatchStore();
    const { dispatcher } = dispatcherRig(store, emitted);
    store.conversations.set("conv-9", { id: "conv-9", workspaceId: "ws-1", channelAccountId: "acc-wa", contactId: "ct-9" });
    store.messages.push({
      id: "m-out-1", conversationId: "conv-9", direction: "out", externalId: "wamid.INBOX", status: "sent",
    } as never);
    await dispatcher.dispatch([{
      type: "message.status", channel: "whatsapp", accountExternalId: "10987",
      messageExternalId: "wamid.INBOX", status: "read", receivedAt: new Date().toISOString(),
    }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.data).toMatchObject({ status: "read", messageId: "m-out-1", conversationId: "conv-9" });
  });
});
