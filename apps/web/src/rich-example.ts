import type { RichBlock, RichButton } from "./api";

/**
 * THE canonical rich-buttons example, reused everywhere a user fills in
 * a buttons block (FlowBuilder editor placeholders + "Use example",
 * Inbox composer placeholders + "Use example", docs/rich-messages.md).
 * Keeping one example means the docs, the builder hints and the payload
 * users copy all agree: the payload codes (HARGA / JADWAL) are exactly
 * what a follow-up flow's postback trigger should match.
 */
export const RICH_BUTTONS_EXAMPLE: RichBlock = {
  kind: "buttons",
  text: "Halo! Mau lihat apa dulu?",
  buttons: [
    { type: "reply", title: "Lihat Harga", payload: "HARGA" },
    { type: "reply", title: "Cek Jadwal", payload: "JADWAL" },
    { type: "url", title: "Kunjungi Website", url: "https://example.com" },
  ],
};

/** The example buttons as Inbox composer rows (composer type union has no postback). */
export const RICH_BUTTONS_EXAMPLE_COMPOSER: Array<{
  type: "reply" | "url";
  title: string;
  payload: string;
  url: string;
}> = (RICH_BUTTONS_EXAMPLE.kind === "buttons" ? RICH_BUTTONS_EXAMPLE.buttons : []).map(
  (b: RichButton) => ({
    type: b.type === "url" ? ("url" as const) : ("reply" as const),
    title: b.title,
    payload: b.payload ?? "",
    url: b.url ?? "",
  }),
);
