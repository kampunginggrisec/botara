import { describe, expect, test } from "bun:test";
import { StaticCredentialProvider } from "./credentials";
import { InstagramAdapter } from "./instagram";
import { MessengerAdapter } from "./messenger";
import { TelegramAdapter } from "./telegram";
import { WhatsAppAdapter } from "./whatsapp";
import { buildVariableContext } from "@botara/shared";
import { interpolateRichBlock, richBlockSchema, richToPlainText, type RichBlock } from "./rich";
import type { FetchLike } from "./types";

/**
 * Rich-block renderers: payload-shape tests per adapter (mocked fetch) plus
 * the degradation contract - unsupported combos become formatted text + a
 * typed warning on the result, never a silent drop.
 */

const metaCreds = new StaticCredentialProvider({ accessToken: "meta-token" });
const tgCreds = new StaticCredentialProvider({ botToken: "123456:TEST" });
const WA_ACCOUNT = { id: "a-wa", externalId: "10987654321" };
const PAGE = { id: "a-msgr", externalId: "page-1" };
const IG = { id: "a-ig", externalId: "ig-1" };
const TG = { id: "a-tg", externalId: "555000111" };

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const bodies = () => calls.map((c) => JSON.parse(c.init!.body as string) as Record<string, any>);
  return { fetchFn, calls, bodies };
}

const waOk = { body: { messages: [{ id: "wamid.R1" }] } };
const metaOk = { body: { message_id: "mid.R1" } };
const tgOk = (id: number) => ({ body: { ok: true, result: { message_id: id } } });

const buttonsBlock: RichBlock = {
  kind: "buttons",
  text: "Pick one",
  buttons: [
    { type: "reply", title: "Prices", payload: "PRICES" },
    { type: "postback", title: "Support", payload: "SUPPORT" },
  ],
};

describe("rich block schema", () => {
  test("validates blocks and rejects a url button without a url", () => {
    expect(richBlockSchema.safeParse(buttonsBlock).success).toBe(true);
    const bad = richBlockSchema.safeParse({
      kind: "buttons", text: "x", buttons: [{ type: "url", title: "Open" }],
    });
    expect(bad.success).toBe(false);
  });

  test("richToPlainText renders buttons, list rows, and cards", () => {
    expect(richToPlainText(buttonsBlock)).toBe("Pick one\n- Prices\n- Support");
    const list = richToPlainText({
      kind: "list", text: "Menu", buttonText: "Open",
      sections: [{ title: "Food", rows: [{ id: "r1", title: "Nasi", description: "rice" }] }],
    });
    expect(list).toContain("1. Nasi - rice");
    const carousel = richToPlainText({
      kind: "carousel",
      cards: [{ title: "A" }, { title: "B", subtitle: "bee", buttons: [{ type: "url", title: "Go", url: "https://x.example" }] }],
    });
    expect(carousel).toContain("B\nbee\n- Go: https://x.example");
  });
});

describe("whatsapp rich renderer", () => {
  test("reply buttons -> interactive button message", async () => {
    const { fetchFn, bodies } = mockFetch([waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    const res = await wa.send({ account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k", rich: buttonsBlock });
    expect(res.externalMessageId).toBe("wamid.R1");
    expect(res.warnings).toBeUndefined();
    const body = bodies()[0]!;
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("button");
    expect(body.interactive.body.text).toBe("Pick one");
    expect(body.interactive.action.buttons).toEqual([
      { type: "reply", reply: { id: "PRICES", title: "Prices" } },
      { type: "reply", reply: { id: "SUPPORT", title: "Support" } },
    ]);
  });

  test("more than 3 reply buttons truncates with a warning", async () => {
    const { fetchFn, bodies } = mockFetch([waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    const rich: RichBlock = {
      kind: "buttons", text: "Many",
      buttons: [1, 2, 3, 4].map((n) => ({ type: "reply" as const, title: `B${n}`, payload: `P${n}` })),
    };
    const res = await wa.send({ account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k", rich });
    expect(res.warnings).toEqual(["RICH_BUTTONS_TRUNCATED"]);
    expect(bodies()[0]!.interactive.action.buttons).toHaveLength(3);
  });

  test("a single url button -> CTA URL message", async () => {
    const { fetchFn, bodies } = mockFetch([waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: { kind: "buttons", text: "Shop now", buttons: [{ type: "url", title: "Open shop", url: "https://shop.example" }] },
    });
    const body = bodies()[0]!;
    expect(body.interactive.type).toBe("cta_url");
    expect(body.interactive.action).toEqual({
      name: "cta_url",
      parameters: { display_text: "Open shop", url: "https://shop.example" },
    });
  });

  test("list -> interactive list message with sections and rows", async () => {
    const { fetchFn, bodies } = mockFetch([waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: {
        kind: "list", text: "Our menu", buttonText: "See menu",
        sections: [{ title: "Food", rows: [{ id: "r1", title: "Nasi goreng", description: "Fried rice" }] }],
      },
    });
    const body = bodies()[0]!;
    expect(body.interactive.type).toBe("list");
    expect(body.interactive.action.button).toBe("See menu");
    expect(body.interactive.action.sections).toEqual([
      { title: "Food", rows: [{ id: "r1", title: "Nasi goreng", description: "Fried rice" }] },
    ]);
  });

  test("product -> single-product message; catalog with sections -> product_list", async () => {
    const { fetchFn, bodies } = mockFetch([waOk, waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: { kind: "product", catalogId: "cat-1", productId: "sku-9", text: "Check this" },
    });
    expect(bodies()[0]!.interactive).toEqual({
      type: "product",
      body: { text: "Check this" },
      action: { catalog_id: "cat-1", product_retailer_id: "sku-9" },
    });
    await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: {
        kind: "catalog", catalogId: "cat-1", text: "Browse",
        sections: [{ title: "Shoes", productIds: ["sku-1", "sku-2"] }],
      },
    });
    const list = bodies()[1]!;
    expect(list.interactive.type).toBe("product_list");
    expect(list.interactive.action).toEqual({
      catalog_id: "cat-1",
      sections: [{ title: "Shoes", product_items: [{ product_retailer_id: "sku-1" }, { product_retailer_id: "sku-2" }] }],
    });
  });

  test("carousel and section-less catalog degrade to text with a warning", async () => {
    const { fetchFn, bodies } = mockFetch([waOk, waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    const res = await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: { kind: "carousel", cards: [{ title: "Card A" }] },
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(bodies()[0]!.type).toBe("text");
    expect(bodies()[0]!.text.body).toContain("Card A");
    const res2 = await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: { kind: "catalog", catalogId: "cat-1", text: "Catalog" },
    });
    expect(res2.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
  });

  test("mixed reply+url buttons degrade to text with a warning (no single native shape)", async () => {
    const { fetchFn, bodies } = mockFetch([waOk]);
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn });
    const res = await wa.send({
      account: WA_ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      rich: {
        kind: "buttons", text: "Mix",
        buttons: [
          { type: "reply", title: "A", payload: "A" },
          { type: "url", title: "B", url: "https://b.example" },
        ],
      },
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(bodies()[0]!.type).toBe("text");
  });

  test("click-to-WhatsApp referral is parsed onto the message event", async () => {
    const wa = new WhatsAppAdapter({ credentials: metaCreds, fetchFn: mockFetch([]).fetchFn });
    const events = await wa.parseWebhook({
      entry: [{
        id: "waba-1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "10987654321" },
            messages: [{
              from: "62812", id: "wamid.IN1", timestamp: "1700000000", type: "text",
              text: { body: "hi from ad" },
              referral: { source_id: "ad-9", source_type: "ADS", ctwa_clid: "clid-1" },
            }],
          },
        }],
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received",
      referral: { source: "ADS", ctwaClid: "clid-1", sourceId: "ad-9" },
    });
  });
});

describe("messenger rich renderer", () => {
  test("buttons -> button template with postback + web_url buttons", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const msgr = new MessengerAdapter({ credentials: metaCreds, fetchFn });
    await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      rich: {
        kind: "buttons", text: "Choose",
        buttons: [
          { type: "reply", title: "Yes", payload: "YES" },
          { type: "url", title: "Site", url: "https://example.com" },
        ],
      },
    });
    const msg = bodies()[0]!.message;
    expect(msg.attachment.payload.template_type).toBe("button");
    expect(msg.attachment.payload.buttons).toEqual([
      { type: "postback", title: "Yes", payload: "YES" },
      { type: "web_url", title: "Site", url: "https://example.com" },
    ]);
  });

  test("more than 3 tappable buttons -> quick replies on text", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const msgr = new MessengerAdapter({ credentials: metaCreds, fetchFn });
    const res = await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      rich: {
        kind: "buttons", text: "Pick",
        buttons: [1, 2, 3, 4].map((n) => ({ type: "reply" as const, title: `Opt ${n}`, payload: `O${n}` })),
      },
    });
    expect(res.warnings).toBeUndefined();
    const msg = bodies()[0]!.message;
    expect(msg.text).toBe("Pick");
    expect(msg.quick_replies).toHaveLength(4);
    expect(msg.quick_replies[0]).toEqual({ content_type: "text", title: "Opt 1", payload: "O1" });
  });

  test("carousel -> generic template elements", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const msgr = new MessengerAdapter({ credentials: metaCreds, fetchFn });
    await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      rich: {
        kind: "carousel",
        cards: [{ title: "Shoe", subtitle: "Red", imageUrl: "https://img.example/shoe.png", buttons: [{ type: "url", title: "Buy", url: "https://shop.example" }] }],
      },
    });
    const payload = bodies()[0]!.message.attachment.payload;
    expect(payload.template_type).toBe("generic");
    expect(payload.elements).toEqual([{
      title: "Shoe", subtitle: "Red", image_url: "https://img.example/shoe.png",
      buttons: [{ type: "web_url", title: "Buy", url: "https://shop.example" }],
    }]);
  });

  test("list degrades to text with a warning (Meta retired the list template)", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const msgr = new MessengerAdapter({ credentials: metaCreds, fetchFn });
    const res = await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      rich: { kind: "list", text: "Menu", buttonText: "Open", sections: [{ title: "S", rows: [{ id: "r", title: "Row" }] }] },
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(bodies()[0]!.message.text).toContain("Row");
  });

  test("private reply posts to me/messages with a comment_id recipient", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const msgr = new MessengerAdapter({ credentials: metaCreds, fetchFn });
    const res = await msgr.privateReplyToComment(PAGE, "comment-77", "Sent you a DM!");
    expect(res.externalMessageId).toBe("mid.R1");
    expect(bodies()[0]).toEqual({
      recipient: { comment_id: "comment-77" },
      messaging_type: "RESPONSE",
      message: { text: "Sent you a DM!" },
    });
  });

  test("page feed comments parse into comment.received; postback referral is surfaced", async () => {
    const msgr = new MessengerAdapter({ credentials: metaCreds, fetchFn: mockFetch([]).fetchFn });
    const events = await msgr.parseWebhook({
      entry: [{
        id: "page-1",
        changes: [{
          field: "feed",
          value: {
            item: "comment", verb: "add", comment_id: "c-1", post_id: "p-1",
            message: "price please", from: { id: "u-9" }, created_time: 1700000000,
          },
        }],
        messaging: [{
          sender: { id: "u-9" }, timestamp: 1700000000000,
          postback: { payload: "GET_STARTED", title: "Get Started", referral: { ref: "promo25", source: "SHORTLINK" } },
        }],
      }],
    });
    const comment = events.find((e) => e.type === "comment.received");
    expect(comment).toMatchObject({
      channel: "messenger", commentExternalId: "c-1", postExternalId: "p-1",
      text: "price please", authorExternalId: "u-9",
    });
    const referral = events.find((e) => e.type === "referral.received");
    expect(referral).toMatchObject({ ref: "promo25", source: "SHORTLINK", contactExternalId: "u-9" });
  });
});

describe("instagram rich renderer", () => {
  test("buttons -> quick replies; url buttons dropped with a warning", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const ig = new InstagramAdapter({ credentials: metaCreds, fetchFn });
    const res = await ig.send({
      account: IG, toExternalId: "u-1", idempotencyKey: "k",
      rich: {
        kind: "buttons", text: "Hi",
        buttons: [
          { type: "reply", title: "Catalog", payload: "CAT" },
          { type: "url", title: "Web", url: "https://example.com" },
        ],
      },
    });
    expect(res.warnings).toEqual(["RICH_URL_BUTTONS_DROPPED"]);
    const msg = bodies()[0]!.message;
    expect(msg.text).toBe("Hi");
    expect(msg.quick_replies).toEqual([{ content_type: "text", title: "Catalog", payload: "CAT" }]);
  });

  test("carousel -> generic template via the Send API", async () => {
    const { fetchFn, calls, bodies } = mockFetch([metaOk]);
    const ig = new InstagramAdapter({ credentials: metaCreds, fetchFn });
    await ig.send({
      account: IG, toExternalId: "u-1", idempotencyKey: "k",
      rich: { kind: "carousel", cards: [{ title: "One" }, { title: "Two", imageUrl: "https://img.example/2.png" }] },
    });
    expect(calls[0]!.url).toBe("https://graph.instagram.com/ig-1/messages");
    const payload = bodies()[0]!.message.attachment.payload;
    expect(payload.template_type).toBe("generic");
    expect(payload.elements).toHaveLength(2);
  });

  test("list degrades to text with a warning", async () => {
    const { fetchFn, bodies } = mockFetch([metaOk]);
    const ig = new InstagramAdapter({ credentials: metaCreds, fetchFn });
    const res = await ig.send({
      account: IG, toExternalId: "u-1", idempotencyKey: "k",
      rich: { kind: "list", text: "Menu", buttonText: "Open", sections: [{ title: "S", rows: [{ id: "r", title: "Row" }] }] },
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(bodies()[0]!.message.text).toContain("Row");
  });

  test("private reply posts recipient.comment_id to the account messages endpoint", async () => {
    const { fetchFn, calls, bodies } = mockFetch([metaOk]);
    const ig = new InstagramAdapter({ credentials: metaCreds, fetchFn });
    const res = await ig.privateReplyToComment(IG, "comment-5", "Check your DM");
    expect(res.externalMessageId).toBe("mid.R1");
    expect(calls[0]!.url).toBe("https://graph.instagram.com/ig-1/messages");
    expect(bodies()[0]).toEqual({
      recipient: { comment_id: "comment-5" },
      message: { text: "Check your DM" },
    });
  });
});

describe("telegram rich renderer", () => {
  test("buttons -> inline keyboard with callback_data and url buttons", async () => {
    const { fetchFn, bodies } = mockFetch([tgOk(11)]);
    const tg = new TelegramAdapter({ credentials: tgCreds, fetchFn });
    const res = await tg.send({ account: TG, toExternalId: "777", idempotencyKey: "k", rich: buttonsBlock });
    expect(res.externalMessageId).toBe("11");
    expect(bodies()[0]!.text).toBe("Pick one");
    expect(bodies()[0]!.reply_markup.inline_keyboard).toEqual([
      [{ text: "Prices", callback_data: "PRICES" }, { text: "Support", callback_data: "SUPPORT" }],
    ]);
  });

  test("list -> text outline + one-button-per-row keyboard with a warning", async () => {
    const { fetchFn, bodies } = mockFetch([tgOk(12)]);
    const tg = new TelegramAdapter({ credentials: tgCreds, fetchFn });
    const res = await tg.send({
      account: TG, toExternalId: "777", idempotencyKey: "k",
      rich: { kind: "list", text: "Menu", buttonText: "Open", sections: [{ title: "Food", rows: [{ id: "r1", title: "Nasi" }] }] },
    });
    expect(res.warnings).toEqual(["RICH_LIST_AS_KEYBOARD"]);
    expect(bodies()[0]!.reply_markup.inline_keyboard).toEqual([[{ text: "Nasi", callback_data: "r1" }]]);
  });

  test("carousel -> sequential card messages, first id returned, warning attached", async () => {
    const { fetchFn, calls, bodies } = mockFetch([tgOk(21), tgOk(22)]);
    const tg = new TelegramAdapter({ credentials: tgCreds, fetchFn });
    const res = await tg.send({
      account: TG, toExternalId: "777", idempotencyKey: "k",
      rich: {
        kind: "carousel",
        cards: [
          { title: "First", imageUrl: "https://img.example/1.png", buttons: [{ type: "url", title: "Buy", url: "https://shop.example" }] },
          { title: "Second" },
        ],
      },
    });
    expect(res.externalMessageId).toBe("21");
    expect(res.warnings).toEqual(["RICH_CAROUSEL_SEQUENTIAL"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toEndWith("/sendPhoto");
    expect(bodies()[0]).toMatchObject({ photo: "https://img.example/1.png", caption: "First" });
    expect(bodies()[0]!.reply_markup.inline_keyboard).toEqual([[{ text: "Buy", url: "https://shop.example" }]]);
    expect(calls[1]!.url).toEndWith("/sendMessage");
  });

  test("catalog degrades to text with a warning", async () => {
    const { fetchFn, bodies } = mockFetch([tgOk(31)]);
    const tg = new TelegramAdapter({ credentials: tgCreds, fetchFn });
    const res = await tg.send({
      account: TG, toExternalId: "777", idempotencyKey: "k",
      rich: { kind: "catalog", catalogId: "c1", text: "Browse all", sections: [{ title: "S", productIds: ["p1"] }] },
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    expect(bodies()[0]!.text).toContain("p1");
  });
});

describe("interpolateRichBlock (variables package #1)", () => {
  const vctx = buildVariableContext({
    contact: { displayName: "Sari", externalId: "628111", channel: "whatsapp", customFields: { city: "Surabaya" } },
    workspaceName: "Toko Sari",
  });

  test("buttons block: text + button titles render; payload/url untouched; input not mutated", () => {
    const block: RichBlock = {
      kind: "buttons",
      text: "Halo {{contact.name}} dari {{contact.city}}!",
      buttons: [
        { type: "reply", title: "Pesanan {{contact.name}}", payload: "track_{{contact.name}}" },
        { type: "url", title: "Buka {{workspace.name}}", url: "https://example.com/{{contact.name}}" },
      ],
    };
    const { block: out, warnings } = interpolateRichBlock(block, vctx);
    expect(warnings).toEqual([]);
    if (out.kind !== "buttons") throw new Error("kind changed");
    expect(out.text).toBe("Halo Sari dari Surabaya!");
    expect(out.buttons[0]!.title).toBe("Pesanan Sari");
    expect(out.buttons[0]!.payload).toBe("track_{{contact.name}}");
    expect(out.buttons[1]!.title).toBe("Buka Toko Sari");
    expect(out.buttons[1]!.url).toBe("https://example.com/{{contact.name}}");
    if (block.kind !== "buttons") throw new Error("kind changed");
    expect(block.text).toBe("Halo {{contact.name}} dari {{contact.city}}!");
  });

  test("list + carousel + catalog text fields render; unknown variables warn", () => {
    const list: RichBlock = {
      kind: "list",
      text: "Menu untuk {{contact.name}}",
      buttonText: "Lihat {{contact.missing}}",
      sections: [{ title: "Seksi {{contact.city}}", rows: [{ id: "1", title: "Baris {{contact.name}}", description: "di {{contact.city}}" }] }],
    };
    const r1 = interpolateRichBlock(list, vctx);
    if (r1.block.kind !== "list") throw new Error("kind changed");
    expect(r1.block.text).toBe("Menu untuk Sari");
    expect(r1.block.buttonText).toBe("Lihat ");
    expect(r1.block.sections[0]!.title).toBe("Seksi Surabaya");
    expect(r1.block.sections[0]!.rows[0]!.title).toBe("Baris Sari");
    expect(r1.block.sections[0]!.rows[0]!.description).toBe("di Surabaya");
    expect(r1.warnings).toEqual([{ code: "UNKNOWN_VARIABLE", path: "contact.missing" }]);

    const carousel: RichBlock = {
      kind: "carousel",
      cards: [{ title: "Untuk {{contact.name}}", subtitle: "dari {{workspace.name}}", imageUrl: "https://x.co/a.png" }],
    };
    const r2 = interpolateRichBlock(carousel, vctx);
    if (r2.block.kind !== "carousel") throw new Error("kind changed");
    expect(r2.block.cards[0]!.title).toBe("Untuk Sari");
    expect(r2.block.cards[0]!.subtitle).toBe("dari Toko Sari");
    expect(r2.block.cards[0]!.imageUrl).toBe("https://x.co/a.png");
  });

  test("a block without variables passes through with zero warnings", () => {
    const block: RichBlock = { kind: "product", catalogId: "c1", productId: "p1", text: "Lihat produk ini" };
    const { block: out, warnings } = interpolateRichBlock(block, vctx);
    expect(out).toEqual(block);
    expect(warnings).toEqual([]);
  });
});
