import { describe, expect, test } from "bun:test";
import { UnconfiguredWebchatStore, WebchatAdapter, type WebchatStore } from "./webchat";
import type { RichBlock } from "./rich";

const ACCOUNT = { id: "a1", externalId: "webchat:ws-1" };

const BUTTONS: RichBlock = {
  kind: "buttons",
  text: "Halo! Mau lihat apa dulu?",
  buttons: [
    { type: "reply", title: "Lihat Harga", payload: "HARGA" },
    { type: "url", title: "Kunjungi Website", url: "https://example.com" },
  ],
};

const LIST: RichBlock = {
  kind: "list",
  text: "Pilih layanan:",
  buttonText: "Lihat",
  sections: [{ title: "Paket", rows: [{ id: "basic", title: "Basic" }, { id: "pro", title: "Pro" }] }],
};

function recordingStore() {
  const delivered: Array<{ toExternalId: string; text: string; idempotencyKey: string; payload?: RichBlock }> = [];
  const store: WebchatStore = {
    async deliverOutbound(input) {
      delivered.push(input);
      return { messageId: "msg-1" };
    },
  };
  return { store, delivered };
}

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

  test("buttons blocks are delivered WITH payload intact (widget renders them natively)", async () => {
    const { store, delivered } = recordingStore();
    const chat = new WebchatAdapter({ store });
    const res = await chat.send({
      account: ACCOUNT, toExternalId: "webchat-session:s-1", rich: BUTTONS, idempotencyKey: "reply:rich-1",
    });
    // No degradation warning: the widget renders these buttons itself.
    expect(res).toEqual({ externalMessageId: "msg-1", status: "sent" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toEqual(BUTTONS);
    // The persisted body still carries the formatted plain-text rendering.
    expect(delivered[0]!.text).toContain("Halo! Mau lihat apa dulu?");
    expect(delivered[0]!.text).toContain("Lihat Harga");
    expect(chat.capabilities.richButtons).toBe(true);
  });

  test("list blocks are delivered WITH payload intact too", async () => {
    const { store, delivered } = recordingStore();
    const chat = new WebchatAdapter({ store });
    const res = await chat.send({
      account: ACCOUNT, toExternalId: "webchat-session:s-1", rich: LIST, idempotencyKey: "reply:rich-2",
    });
    expect(res.warnings).toBeUndefined();
    expect(delivered[0]!.payload).toEqual(LIST);
    expect(chat.capabilities.richLists).toBe(true);
  });

  test("carousel and catalog blocks still degrade to text with the typed warning (no payload)", async () => {
    const { store, delivered } = recordingStore();
    const chat = new WebchatAdapter({ store });
    const carousel: RichBlock = { kind: "carousel", cards: [{ title: "Kartu A" }, { title: "Kartu B" }] };
    const res = await chat.send({
      account: ACCOUNT, toExternalId: "webchat-session:s-1", rich: carousel, idempotencyKey: "reply:rich-3",
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(delivered[0]!.payload).toBeUndefined();
    expect(delivered[0]!.text).toContain("Kartu A");

    const catalog: RichBlock = { kind: "catalog", catalogId: "cat-1", text: "Lihat katalog kami" };
    const res2 = await chat.send({
      account: ACCOUNT, toExternalId: "webchat-session:s-1", rich: catalog, idempotencyKey: "reply:rich-4",
    });
    expect(res2.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(delivered[1]!.payload).toBeUndefined();
    expect(chat.capabilities.carousel).toBe(false);
    expect(chat.capabilities.catalog).toBe(false);
  });
});
