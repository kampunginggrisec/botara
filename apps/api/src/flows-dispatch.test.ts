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
