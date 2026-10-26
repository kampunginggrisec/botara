import { describe, expect, test } from "bun:test";
import {
  InMemoryDispatchStore, createFlowDispatcher,
  type CommentActionJobPayload, type FlowRunJobPayload,
} from "./flows-dispatch";
import type { InboundEvent } from "@botara/channels";

/**
 * Inbound dispatcher over the in-memory store: keyword regression, comment
 * automation enqueueing + duplicate suppression, and growth attribution
 * (priority over keyword matching, once-per-contact conversions).
 */

function setup() {
  const store = new InMemoryDispatchStore();
  store.accounts.push({
    id: "acc-ig", workspaceId: "ws-1", channel: "instagram", externalId: "ig-1", status: "connected",
  });
  store.accounts.push({
    id: "acc-tg", workspaceId: "ws-1", channel: "telegram", externalId: "555", status: "connected",
  });
  store.accounts.push({
    id: "acc-wa", workspaceId: "ws-1", channel: "whatsapp", externalId: "10987", status: "connected",
  });
  const flowRuns: FlowRunJobPayload[] = [];
  const commentActions: CommentActionJobPayload[] = [];
  const dispatcher = createFlowDispatcher({
    store,
    flowEnqueuer: { async enqueueFlowRun(job) { flowRuns.push(job); } },
    commentEnqueuer: { async enqueueCommentAction(job) { commentActions.push(job); } },
  });
  return { store, dispatcher, flowRuns, commentActions };
}

const igMessage = (text: string): InboundEvent => ({
  type: "message.received", channel: "instagram", accountExternalId: "ig-1",
  contactExternalId: "u-1", messageExternalId: `m-${Math.random()}`,
  text, receivedAt: new Date().toISOString(),
});

const igComment = (text: string, commentId = "c-1"): InboundEvent => ({
  type: "comment.received", channel: "instagram", accountExternalId: "ig-1",
  postExternalId: "p-1", commentExternalId: commentId, text,
  authorExternalId: "u-9", receivedAt: new Date().toISOString(),
});

describe("keyword dispatch (regression)", () => {
  test("a matching keyword enqueues a flow run and persists the message", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "price" } } });
    await dispatcher.dispatch([igMessage("what is the price?")]);
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0]).toMatchObject({ flowId: "f-kw", workspaceId: "ws-1" });
    expect(store.messages).toHaveLength(1);
  });

  test("a non-matching message enqueues nothing", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "price" } } });
    await dispatcher.dispatch([igMessage("hello there")]);
    expect(flowRuns).toHaveLength(0);
  });
});

describe("comment automation dispatch", () => {
  test("a matching comment enqueues ONE comment-action with the trigger config", async () => {
    const { store, dispatcher, commentActions, flowRuns } = setup();
    store.flows.push({
      id: "f-comment", workspaceId: "ws-1",
      trigger: {
        type: "comment_keyword",
        config: { keyword: "price", publicReplyText: "Check your DM!", autoHide: true, privateText: "Here is the price list" },
      },
    });
    await dispatcher.dispatch([igComment("PRICE please")]);
    expect(commentActions).toHaveLength(1);
    expect(commentActions[0]).toMatchObject({
      flowId: "f-comment",
      channelAccountId: "acc-ig",
      commentExternalId: "c-1",
      authorExternalId: "u-9",
      publicReplyText: "Check your DM!",
      autoHide: true,
      privateText: "Here is the price list",
    });
    // Comment flows do NOT also run as keyword flow-runs.
    expect(flowRuns).toHaveLength(0);
  });

  test("duplicate suppression: a processed comment is not enqueued again", async () => {
    const { store, dispatcher, commentActions } = setup();
    store.flows.push({
      id: "f-comment", workspaceId: "ws-1",
      trigger: { type: "comment_keyword", config: { keyword: "price" } },
    });
    store.processedComments.add("acc-ig:c-1:f-comment");
    await dispatcher.dispatch([igComment("price?")]);
    expect(commentActions).toHaveLength(0);
  });

  test("non-matching comments and other channels' flows are ignored", async () => {
    const { store, dispatcher, commentActions } = setup();
    store.flows.push({
      id: "f-comment", workspaceId: "ws-1",
      trigger: { type: "comment_keyword", config: { keyword: "price" } },
    });
    await dispatcher.dispatch([igComment("nice photo!")]);
    expect(commentActions).toHaveLength(0);
  });
});

describe("growth attribution", () => {
  test("messenger referral: bound flow runs INSTEAD of keyword matching, conversion counted once per contact", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.accounts.push({
      id: "acc-msgr", workspaceId: "ws-1", channel: "messenger", externalId: "page-1", status: "connected",
    });
    store.growthLinks.push({
      id: "link-1", workspaceId: "ws-1", channelAccountId: "acc-msgr", slug: "promo25", boundFlowId: "f-bound",
    });
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "price" } } });

    const referral: InboundEvent = {
      type: "referral.received", channel: "messenger", accountExternalId: "page-1",
      contactExternalId: "u-7", ref: "promo25", source: "SHORTLINK", receivedAt: new Date().toISOString(),
    };
    await dispatcher.dispatch([referral]);
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0]!.flowId).toBe("f-bound");
    expect(store.conversions.get("link-1")).toBe(1);
    const contact = [...store.contacts.values()][0]!;
    expect(contact.tags).toContain("growth:promo25");

    // Same contact again: no second conversion (tag already present).
    await dispatcher.dispatch([referral]);
    expect(store.conversions.get("link-1")).toBe(1);
  });

  test("telegram /start <slug> attributes and runs the bound flow with priority over keywords", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.growthLinks.push({
      id: "link-tg", workspaceId: "ws-1", channelAccountId: "acc-tg", slug: "deal2026", boundFlowId: "f-tg",
    });
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "start" } } });
    await dispatcher.dispatch([{
      type: "message.received", channel: "telegram", accountExternalId: "",
      contactExternalId: "777", messageExternalId: "tm-1", text: "/start deal2026",
      receivedAt: new Date().toISOString(),
    }]);
    expect(flowRuns.map((r) => r.flowId)).toEqual(["f-tg"]);
    expect(store.conversions.get("link-tg")).toBe(1);
  });

  test("a growth link WITHOUT a bound flow still tags + counts, and keyword matching proceeds", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.growthLinks.push({
      id: "link-x", workspaceId: "ws-1", channelAccountId: "acc-tg", slug: "plain", boundFlowId: null,
    });
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "start" } } });
    await dispatcher.dispatch([{
      type: "message.received", channel: "telegram", accountExternalId: "",
      contactExternalId: "778", messageExternalId: "tm-2", text: "/start plain",
      receivedAt: new Date().toISOString(),
    }]);
    expect(store.conversions.get("link-x")).toBe(1);
    expect(flowRuns.map((r) => r.flowId)).toEqual(["f-kw"]);
  });

  test("whatsapp referral attributes only under the single-link rule", async () => {
    const { store, dispatcher } = setup();
    store.growthLinks.push({
      id: "link-wa", workspaceId: "ws-1", channelAccountId: "acc-wa", slug: "waone", boundFlowId: null,
    });
    const waReferralMessage: InboundEvent = {
      type: "message.received", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wm-1", text: "hi",
      referral: { source: "ADS", ctwaClid: "clid-1" }, receivedAt: new Date().toISOString(),
    };
    await dispatcher.dispatch([waReferralMessage]);
    expect(store.conversions.get("link-wa")).toBe(1);

    // A second link on the same account makes attribution ambiguous -> none.
    store.growthLinks.push({
      id: "link-wa-2", workspaceId: "ws-1", channelAccountId: "acc-wa", slug: "watwo", boundFlowId: null,
    });
    await dispatcher.dispatch([{ ...waReferralMessage, contactExternalId: "62813", messageExternalId: "wm-2" }]);
    expect(store.conversions.get("link-wa")).toBe(1);
    expect(store.conversions.get("link-wa-2")).toBeUndefined();
  });

  test("an unknown slug is ignored (no conversion, keyword matching unaffected)", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "start" } } });
    await dispatcher.dispatch([{
      type: "message.received", channel: "telegram", accountExternalId: "",
      contactExternalId: "779", messageExternalId: "tm-3", text: "/start nope",
      receivedAt: new Date().toISOString(),
    }]);
    expect(store.conversions.size).toBe(0);
    expect(flowRuns.map((r) => r.flowId)).toEqual(["f-kw"]);
  });
});

describe("persisted webchat dispatch (clickable buttons)", () => {
  const base = {
    workspaceId: "ws-1", channelAccountId: "acc-webchat", contactId: "ct-1", conversationId: "conv-1",
  };

  test("a typed message matches keyword triggers and persists NOTHING (route owns persistence)", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "harga" } } });
    await dispatcher.dispatchPersistedWebchat({ ...base, text: "minta harga dong" });
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0]).toMatchObject({
      flowId: "f-kw", workspaceId: "ws-1", contactId: "ct-1",
      conversationId: "conv-1", channelAccountId: "acc-webchat", triggerText: "minta harga dong",
    });
    expect(store.messages).toHaveLength(0);
  });

  test("a button click matches the postback trigger by payload", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-pb", workspaceId: "ws-1", trigger: { type: "postback", config: { payload: "HARGA" } } });
    await dispatcher.dispatchPersistedWebchat({ ...base, text: "Lihat Harga", buttonPayload: "HARGA" });
    expect(flowRuns.map((r) => r.flowId)).toEqual(["f-pb"]);
    expect(flowRuns[0]!.triggerText).toBe("HARGA");
    expect(store.messages).toHaveLength(0);
  });

  test("a button click ALSO matches keyword triggers against the button title", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-kw-title", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "jadwal" } } });
    store.flows.push({ id: "f-pb", workspaceId: "ws-1", trigger: { type: "postback", config: { payload: "JADWAL" } } });
    await dispatcher.dispatchPersistedWebchat({ ...base, text: "Cek Jadwal", buttonPayload: "JADWAL" });
    // Both flows fire: postback by payload, keyword by title text.
    expect(flowRuns.map((r) => r.flowId).sort()).toEqual(["f-kw-title", "f-pb"]);
  });

  test("a click whose payload matches nothing enqueues nothing; other workspaces' flows never match", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-pb", workspaceId: "ws-1", trigger: { type: "postback", config: { payload: "HARGA" } } });
    store.flows.push({ id: "f-other", workspaceId: "ws-2", trigger: { type: "keyword", config: { keyword: "halo" } } });
    await dispatcher.dispatchPersistedWebchat({ ...base, text: "Lihat Harga", buttonPayload: "LAINNYA" });
    expect(flowRuns).toHaveLength(0);
    await dispatcher.dispatchPersistedWebchat({ ...base, text: "halo" });
    expect(flowRuns).toHaveLength(0);
  });

  test("a typed message never matches postback triggers (no payload)", async () => {
    const { store, dispatcher, flowRuns } = setup();
    store.flows.push({ id: "f-pb", workspaceId: "ws-1", trigger: { type: "postback", config: { payload: "HARGA" } } });
    await dispatcher.dispatchPersistedWebchat({ ...base, text: "HARGA" });
    expect(flowRuns).toHaveLength(0);
  });
});

describe("whatsapp coexistence dispatch", () => {
  function waSetup() {
    const store = new InMemoryDispatchStore();
    store.accounts.push({
      id: "acc-wa", workspaceId: "ws-1", channel: "whatsapp", externalId: "10987", status: "connected",
    });
    const flowRuns: FlowRunJobPayload[] = [];
    const published: Array<{ direction: string }> = [];
    const dispatcher = createFlowDispatcher({
      store,
      flowEnqueuer: { async enqueueFlowRun(job) { flowRuns.push(job); } },
      publisher: {
        async publishInboxMessage(event) { published.push({ direction: event.direction }); },
        async publishInboxUpdate() {},
      },
    });
    return { store, dispatcher, flowRuns, published };
  }

  const waEcho = (text: string, id = "wamid.E1"): InboundEvent => ({
    type: "message.echo", channel: "whatsapp", accountExternalId: "10987",
    contactExternalId: "62812", messageExternalId: id,
    text, receivedAt: new Date().toISOString(),
  });

  test("an echo persists ONCE as an outbound message, publishes once, and a redelivery dedupes", async () => {
    const { store, dispatcher, published } = waSetup();
    await dispatcher.dispatch([waEcho("dibalas dari HP")]);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      direction: "out", type: "text", body: "dibalas dari HP", externalId: "wamid.E1",
    });
    expect(published).toEqual([{ direction: "out" }]);
    // Meta redelivers the echo webhook: no second row, no second publish.
    await dispatcher.dispatch([waEcho("dibalas dari HP")]);
    expect(store.messages).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  test("an echo NEVER matches flow triggers and NEVER moves the reply-window anchor", async () => {
    const { store, dispatcher, flowRuns } = waSetup();
    // A keyword flow whose keyword appears verbatim in the echo text:
    // echoes must still not fire it (the business wrote it, not the customer).
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "price" } } });
    await dispatcher.dispatch([waEcho("the price is 5")]);
    expect(flowRuns).toHaveLength(0);
    const conversation = [...store.conversations.values()][0]!;
    // The window anchor is driven ONLY by inbound customer messages.
    expect(conversation.lastUserMessageAt).toBeUndefined();
  });

  test("state sync upserts contacts (create, then name refresh); remove keeps the platform contact", async () => {
    const { store, dispatcher } = waSetup();
    const sync = (contacts: Extract<InboundEvent, { type: "contacts.synced" }>["contacts"]): InboundEvent => ({
      type: "contacts.synced", channel: "whatsapp", accountExternalId: "10987",
      contacts, receivedAt: new Date().toISOString(),
    });
    await dispatcher.dispatch([sync([{ externalId: "628111", displayName: "Sari", action: "add" }])]);
    let contact = await store.getContactByExternal("ws-1", "whatsapp", "628111");
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Sari");
    // Re-sync with a corrected name updates in place (no duplicate contact).
    await dispatcher.dispatch([sync([{ externalId: "628111", displayName: "Sari Wijaya", action: "update" }])]);
    contact = await store.getContactByExternal("ws-1", "whatsapp", "628111");
    expect(contact!.displayName).toBe("Sari Wijaya");
    expect(store.contacts.size).toBe(1);
    // Phone-side removal must NOT delete the platform contact.
    await dispatcher.dispatch([sync([{ externalId: "628111", action: "remove" }])]);
    contact = await store.getContactByExternal("ws-1", "whatsapp", "628111");
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Sari Wijaya");
    expect(store.contacts.size).toBe(1);
  });

  test("history persists with ORIGINAL timestamps, dedupes on redelivery, and stays quiet", async () => {
    const { store, dispatcher, flowRuns, published } = waSetup();
    store.flows.push({ id: "f-kw", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "halo" } } });
    const old = "2026-09-01T10:00:00.000Z";
    const historyMsg: InboundEvent = {
      type: "message.history", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.H1", direction: "in",
      text: "halo lama", receivedAt: old,
    };
    await dispatcher.dispatch([historyMsg]);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ direction: "in", body: "halo lama", createdAt: old });
    // No realtime publish, no flow run - backfill is a quiet import.
    expect(published).toHaveLength(0);
    expect(flowRuns).toHaveLength(0);
    // The window anchor is the ORIGINAL time, not "now": an old message
    // must not fake a fresh 24h window.
    const conversation = [...store.conversations.values()][0]!;
    expect(conversation.lastUserMessageAt).toBe(old);
    // Redelivered chunk: deduped on the wamid.
    await dispatcher.dispatch([historyMsg]);
    expect(store.messages).toHaveLength(1);
  });

  test("an older backfilled inbound never pulls the window anchor backwards", async () => {
    const { store, dispatcher } = waSetup();
    const liveAt = "2026-10-20T10:00:00.000Z";
    await dispatcher.dispatch([{
      type: "message.received", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.LIVE1", text: "pesan live",
      receivedAt: liveAt,
    }]);
    const conversation = [...store.conversations.values()][0]!;
    expect(conversation.lastUserMessageAt).toBe(liveAt);
    // An older history message (also already-live overlap) arrives after:
    await dispatcher.dispatch([{
      type: "message.history", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.H-OLD", direction: "in",
      text: "pesan lama", receivedAt: "2026-08-01T10:00:00.000Z",
    }]);
    expect(conversation.lastUserMessageAt).toBe(liveAt);
    // ... while a NEWER backfilled inbound (still older than now) advances it.
    await dispatcher.dispatch([{
      type: "message.history", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.H-NEWER", direction: "in",
      text: "pesan agak baru", receivedAt: "2026-10-25T10:00:00.000Z",
    }]);
    expect(conversation.lastUserMessageAt).toBe("2026-10-25T10:00:00.000Z");
  });
});

describe("inbound media pipeline", () => {
  interface MediaCall {
    workspaceId: string;
    channel: string;
    media: unknown;
    messageExternalId: string;
  }

  function mediaSetup(portResult: { urls: string[]; keys: string[] } | null | "throw") {
    const store = new InMemoryDispatchStore();
    store.accounts.push(
      { id: "acc-wa", workspaceId: "ws-1", channel: "whatsapp", externalId: "10987", status: "connected" },
      { id: "acc-tg", workspaceId: "ws-1", channel: "telegram", externalId: "555", status: "connected" },
      { id: "acc-msg", workspaceId: "ws-1", channel: "messenger", externalId: "page-1", status: "connected" },
    );
    const calls: MediaCall[] = [];
    const dispatcher = createFlowDispatcher({
      store,
      flowEnqueuer: { async enqueueFlowRun() {} },
      mediaPort: {
        async fetchAndStore(input) {
          calls.push({
            workspaceId: input.workspaceId, channel: input.channel,
            media: input.media, messageExternalId: input.messageExternalId,
          });
          if (portResult === "throw") throw new Error("storage exploded");
          return portResult;
        },
      },
    });
    return { store, dispatcher, calls };
  }

  const waPhoto: InboundEvent = {
    type: "message.received", channel: "whatsapp", accountExternalId: "10987",
    contactExternalId: "62812", messageExternalId: "wamid.M1",
    text: "foto kerusakan", media: { type: "image", id: "wa-media-1", caption: "foto kerusakan", mimeType: "image/jpeg" },
    receivedAt: new Date().toISOString(),
  };

  test("whatsapp id-based media: bytes stored, urls+keys persist on the message row", async () => {
    const { store, dispatcher, calls } = mediaSetup({
      urls: ["https://media.botara.example/workspaces/ws-1/inbound/wamid.M1/image.jpg"],
      keys: ["workspaces/ws-1/inbound/wamid.M1/image.jpg"],
    });
    await dispatcher.dispatch([waPhoto]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ workspaceId: "ws-1", channel: "whatsapp", messageExternalId: "wamid.M1" });
    expect(calls[0]!.media).toMatchObject({ id: "wa-media-1" });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      type: "media", body: "foto kerusakan",
      mediaUrls: ["https://media.botara.example/workspaces/ws-1/inbound/wamid.M1/image.jpg"],
      mediaKeys: ["workspaces/ws-1/inbound/wamid.M1/image.jpg"],
    });
  });

  test("telegram file-based and messenger url-based media reach the port with their shapes", async () => {
    const { store, dispatcher, calls } = mediaSetup({ urls: ["https://m.example/x"], keys: ["k/x"] });
    await dispatcher.dispatch([
      {
        type: "message.received", channel: "telegram", accountExternalId: "",
        contactExternalId: "777", messageExternalId: "tg-9",
        text: "invoice", media: { type: "document", id: "file-9", filename: "invoice.pdf", mimeType: "application/pdf" },
        receivedAt: new Date().toISOString(),
      },
      {
        type: "message.received", channel: "messenger", accountExternalId: "page-1",
        contactExternalId: "psid-1", messageExternalId: "mid-9",
        media: { type: "image", url: "https://cdn.example.com/x.jpg" },
        receivedAt: new Date().toISOString(),
      },
    ]);
    expect(calls.map((c) => c.channel)).toEqual(["telegram", "messenger"]);
    expect(calls[0]!.media).toMatchObject({ id: "file-9" });
    expect(calls[1]!.media).toMatchObject({ url: "https://cdn.example.com/x.jpg" });
    expect(store.messages).toHaveLength(2);
    expect(store.messages.every((m) => (m.mediaKeys ?? []).length === 1)).toBe(true);
  });

  test("port returns null (storage unconfigured / fetch failed): caption-only, dispatch succeeds", async () => {
    const { store, dispatcher } = mediaSetup(null);
    await dispatcher.dispatch([waPhoto]);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ type: "media", body: "foto kerusakan", mediaUrls: [], mediaKeys: [] });
  });

  test("a throwing port still never loses the message", async () => {
    const { store, dispatcher } = mediaSetup("throw");
    await dispatcher.dispatch([waPhoto]);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ mediaUrls: [], mediaKeys: [] });
  });

  test("no media port wired: media messages persist caption-only as before", async () => {
    const store = new InMemoryDispatchStore();
    store.accounts.push({ id: "acc-wa", workspaceId: "ws-1", channel: "whatsapp", externalId: "10987", status: "connected" });
    const dispatcher = createFlowDispatcher({ store, flowEnqueuer: { async enqueueFlowRun() {} } });
    await dispatcher.dispatch([waPhoto]);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ type: "media", mediaUrls: [], mediaKeys: [] });
  });

  test("a redelivered media message does not re-fetch (dedupe first)", async () => {
    const { store, dispatcher, calls } = mediaSetup({ urls: ["https://m.example/x"], keys: ["k/x"] });
    await dispatcher.dispatch([waPhoto]);
    await dispatcher.dispatch([waPhoto]);
    expect(store.messages).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test("a coexistence echo with media goes through the same pipeline", async () => {
    const { store, dispatcher, calls } = mediaSetup({ urls: ["https://m.example/e"], keys: ["k/e"] });
    await dispatcher.dispatch([{
      type: "message.echo", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.E-MEDIA",
      text: "bukti transfer", media: { type: "image", id: "wa-media-2", caption: "bukti transfer" },
      receivedAt: new Date().toISOString(),
    }]);
    expect(calls).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ direction: "out", mediaKeys: ["k/e"] });
  });

  test("a history item with media goes through the pipeline and keeps its original timestamp", async () => {
    const { store, dispatcher, calls } = mediaSetup({ urls: ["https://m.example/h"], keys: ["k/h"] });
    const old = "2026-08-15T09:30:00.000Z";
    await dispatcher.dispatch([{
      type: "message.history", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.H-MEDIA", direction: "in",
      media: { type: "document", id: "wa-media-3", filename: "kontrak.pdf", mimeType: "application/pdf" },
      receivedAt: old,
    }]);
    expect(calls).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ createdAt: old, mediaUrls: ["https://m.example/h"], mediaKeys: ["k/h"] });
  });

  test("plain text messages never touch the media port", async () => {
    const { dispatcher, calls } = mediaSetup({ urls: ["https://m.example/x"], keys: ["k/x"] });
    await dispatcher.dispatch([{
      type: "message.received", channel: "whatsapp", accountExternalId: "10987",
      contactExternalId: "62812", messageExternalId: "wamid.T1", text: "halo",
      receivedAt: new Date().toISOString(),
    }]);
    expect(calls).toHaveLength(0);
  });
});

describe("tiktok dispatch", () => {
  function ttSetup() {
    const store = new InMemoryDispatchStore();
    store.accounts.push({
      id: "acc-tt", workspaceId: "ws-1", channel: "tiktok", externalId: "open-123", status: "connected",
    });
    const flowRuns: FlowRunJobPayload[] = [];
    const commentActions: CommentActionJobPayload[] = [];
    const dispatcher = createFlowDispatcher({
      store,
      flowEnqueuer: { async enqueueFlowRun(job) { flowRuns.push(job); } },
      commentEnqueuer: { async enqueueCommentAction(job) { commentActions.push(job); } },
    });
    return { store, dispatcher, flowRuns, commentActions };
  }

  const ttMessage = (text: string, conversationExternalId?: string): InboundEvent => ({
    type: "message.received", channel: "tiktok", accountExternalId: "open-123",
    contactExternalId: "uniq-1", messageExternalId: `tm-${Math.random()}`,
    text, ...(conversationExternalId ? { conversationExternalId } : {}),
    receivedAt: new Date().toISOString(),
  });

  test("a DM persists, records the provider conversation id, and matches keyword flows", async () => {
    const { store, dispatcher, flowRuns } = ttSetup();
    store.flows.push({ id: "f-price", workspaceId: "ws-1", trigger: { type: "keyword", config: { keyword: "price" } } });
    await dispatcher.dispatch([ttMessage("what is the price?", "conv-tt-1")]);
    expect(flowRuns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    const conversation = [...store.conversations.values()][0]!;
    expect(conversation.externalId).toBe("conv-tt-1");
  });

  test("a later DM backfills the conversation id on a conversation a comment opened", async () => {
    const { store, dispatcher } = ttSetup();
    // First DM arrives without a known conversation id (defensive parse
    // gap / comment-opened thread): the conversation exists id-less.
    await dispatcher.dispatch([ttMessage("halo")]);
    const conversation = [...store.conversations.values()][0]!;
    expect(conversation.externalId).toBeUndefined();
    // The next DM carries the id: backfilled, never overwritten after.
    await dispatcher.dispatch([ttMessage("halo lagi", "conv-tt-9")]);
    expect(conversation.externalId).toBe("conv-tt-9");
    await dispatcher.dispatch([ttMessage("lagi", "conv-OTHER")]);
    expect(conversation.externalId).toBe("conv-tt-9");
    expect(store.conversations.size).toBe(1);
  });

  test("a high-intent comment enqueues ONE comment-action for a matching comment flow", async () => {
    const { store, dispatcher, commentActions, flowRuns } = ttSetup();
    store.flows.push({
      id: "f-comment-tt", workspaceId: "ws-1",
      trigger: {
        type: "comment_keyword",
        config: { keyword: "price", publicReplyText: "Check your DM!", autoHide: true, privateText: "Here is the price list" },
      },
    });
    await dispatcher.dispatch([{
      type: "comment.received", channel: "tiktok", accountExternalId: "open-123",
      postExternalId: "video-1", commentExternalId: "comment-1", text: "PRICE please",
      authorExternalId: "uniq-7", receivedAt: new Date().toISOString(),
    }]);
    expect(commentActions).toHaveLength(1);
    expect(commentActions[0]).toMatchObject({
      flowId: "f-comment-tt", channel: "tiktok", channelAccountId: "acc-tt",
      commentExternalId: "comment-1", authorExternalId: "uniq-7",
    });
    expect(flowRuns).toHaveLength(0);
  });
});
