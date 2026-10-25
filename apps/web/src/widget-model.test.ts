import { describe, expect, test } from "bun:test";
import { buttonClickBody, widgetRichView } from "./widget-model";
import { RICH_BUTTONS_EXAMPLE } from "./rich-example";

/**
 * Webchat widget rich view-model: the persisted payload -> clickable
 * buttons mapping and the click-request builder. The widget shell
 * (widget.ts) only does DOM work with these results; its rendering is
 * exercised end-to-end in the deployment smoke, these tests pin the
 * pure mapping contract.
 */

describe("widgetRichView: buttons blocks", () => {
  test("the canonical example maps to one group of reply/url buttons", () => {
    const view = widgetRichView(RICH_BUTTONS_EXAMPLE);
    expect(view?.text).toBe("Halo! Mau lihat apa dulu?");
    expect(view?.groups).toHaveLength(1);
    const buttons = view!.groups[0]!.buttons;
    expect(buttons.map((b) => b.title)).toEqual(["Lihat Harga", "Cek Jadwal", "Kunjungi Website"]);
    expect(buttons[0]!.action).toEqual({ type: "reply", payload: "HARGA" });
    expect(buttons[1]!.action).toEqual({ type: "reply", payload: "JADWAL" });
    expect(buttons[2]!.action).toEqual({ type: "url", url: "https://example.com" });
  });

  test("postback buttons behave like reply buttons; a missing payload falls back to the title", () => {
    const view = widgetRichView({
      kind: "buttons", text: "Pilih:",
      buttons: [
        { type: "postback", title: "Ya", payload: "YES" },
        { type: "reply", title: "Tidak" },
      ],
    });
    const buttons = view!.groups[0]!.buttons;
    expect(buttons[0]!.action).toEqual({ type: "reply", payload: "YES" });
    expect(buttons[1]!.action).toEqual({ type: "reply", payload: "Tidak" });
  });

  test("malformed buttons are skipped; an all-broken block returns null", () => {
    expect(widgetRichView({ kind: "buttons", text: "x", buttons: [{ type: "url", title: "No URL" }] })).toBeNull();
    const view = widgetRichView({
      kind: "buttons", text: "x",
      buttons: [{ type: "url", title: "No URL" }, { type: "reply", title: "OK", payload: "OK" }],
    });
    expect(view!.groups[0]!.buttons).toHaveLength(1);
  });
});

describe("widgetRichView: list blocks", () => {
  test("sections become groups; rows become reply buttons carrying the row id and description", () => {
    const view = widgetRichView({
      kind: "list", text: "Pilih layanan:", buttonText: "Lihat",
      sections: [
        { title: "Paket", rows: [
          { id: "basic", title: "Basic", description: "Rp99rb/bln" },
          { id: "pro", title: "Pro" },
        ] },
        { title: "Lainnya", rows: [{ id: "cs", title: "Chat CS" }] },
      ],
    });
    expect(view?.text).toBe("Pilih layanan:");
    expect(view?.groups.map((g) => g.title)).toEqual(["Paket", "Lainnya"]);
    const first = view!.groups[0]!.buttons[0]!;
    expect(first.title).toBe("Basic");
    expect(first.description).toBe("Rp99rb/bln");
    expect(first.action).toEqual({ type: "reply", payload: "basic" });
    expect(view!.groups[0]!.buttons[1]!.description).toBeUndefined();
  });
});

describe("widgetRichView: non-native payloads render as plain text (null)", () => {
  test("carousel/product/catalog, click echoes, and garbage all return null", () => {
    expect(widgetRichView({ kind: "carousel", cards: [{ title: "A" }] })).toBeNull();
    expect(widgetRichView({ kind: "product", catalogId: "c", productId: "p" })).toBeNull();
    expect(widgetRichView({ kind: "catalog", catalogId: "c" })).toBeNull();
    expect(widgetRichView({ buttonPayload: "HARGA" })).toBeNull();
    expect(widgetRichView(null)).toBeNull();
    expect(widgetRichView("buttons")).toBeNull();
    expect(widgetRichView({ kind: "buttons" })).toBeNull();
    expect(widgetRichView(undefined)).toBeNull();
  });
});

describe("buttonClickBody", () => {
  test("a reply button posts its title as text and its payload as buttonPayload", () => {
    const view = widgetRichView(RICH_BUTTONS_EXAMPLE)!;
    expect(buttonClickBody(view.groups[0]!.buttons[0]!)).toEqual({
      text: "Lihat Harga", buttonPayload: "HARGA",
    });
  });

  test("a URL button posts nothing (it opens the link instead)", () => {
    const view = widgetRichView(RICH_BUTTONS_EXAMPLE)!;
    expect(buttonClickBody(view.groups[0]!.buttons[2]!)).toBeNull();
  });
});
