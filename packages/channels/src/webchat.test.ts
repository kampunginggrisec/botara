import { describe, expect, test } from "bun:test";
import { UnconfiguredWebchatStore, WebchatAdapter, type WebchatStore } from "./webchat";

const ACCOUNT = { id: "a1", externalId: "webchat:ws-1" };

describe("webchat adapter", () => {
  test("send delivers the reply through the injected store port", async () => {
    const delivered: Array<{ toExternalId: string; text: string; idempotencyKey: string }> = [];
    const store: WebchatStore = {
      async deliverOutbound(input) {
        delivered.push(input);
        return { messageId: "msg-1" };
      },
    };
    const chat = new WebchatAdapter({ store });
    const res = await chat.send({
      account: ACCOUNT, toExternalId: "webchat-session:s-1", text: "halo, ada yang bisa dibantu?",
      idempotencyKey: "reply:1",
    });
    expect(res).toEqual({ externalMessageId: "msg-1", status: "sent" });
    expect(delivered).toEqual([{
      toExternalId: "webchat-session:s-1", text: "halo, ada yang bisa dibantu?", idempotencyKey: "reply:1",
    }]);
    expect((await chat.health()).ok).toBe(true);
  });

  test("without a store, send fails honestly with CONFIGURATION (never fakes delivery)", async () => {
    const chat = new WebchatAdapter();
    await expect(chat.send({
      account: ACCOUNT, toExternalId: "webchat-session:s-1", text: "halo", idempotencyKey: "k",
    })).rejects.toMatchObject({ code: "CONFIGURATION", status: 503 });
    expect((await chat.health()).ok).toBe(false);
    expect(chat.capabilities.canDM).toBe(true);
  });

  test("unconfigured store class is exported for wiring checks", () => {
    expect(new UnconfiguredWebchatStore()).toBeInstanceOf(UnconfiguredWebchatStore);
  });

  test("there are no external webhooks to parse", async () => {
    const chat = new WebchatAdapter();
    expect(await chat.parseWebhook({ anything: true })).toEqual([]);
  });
});
