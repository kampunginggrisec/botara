import { z } from "zod";

/**
 * Rich message blocks (adopted-features package) - the channel-agnostic
 * block model shared by the flow engine's send_message node, the inbox
 * reply API, and every channel adapter's send path.
 *
 * Design: ONE model, per-channel renderers. A renderer either renders the
 * block natively (driven by the capability matrix flags richButtons /
 * richLists / carousel / catalog) or degrades it to a formatted plain-text
 * rendering (richToPlainText) plus a TYPED warning code on the SendResult -
 * a block is never silently dropped or mangled.
 *
 * Limits follow the strictest mainstream provider constraints (WhatsApp
 * interactive messages) so a block that validates here renders almost
 * everywhere; renderers still enforce their own caps and warn when they
 * truncate.
 */

export const richButtonSchema = z.object({
  type: z.enum(["reply", "url", "postback"]),
  title: z.string().min(1).max(80),
  /** Selection payload for reply/postback buttons (callback data). */
  payload: z.string().min(1).max(256).optional(),
  /** Target URL for url buttons. */
  url: z.string().url().max(2000).optional(),
}).superRefine((button, ctx) => {
  if (button.type === "url" && !button.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url buttons require a url" });
  }
  if (button.type !== "url" && !button.payload) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "reply/postback buttons require a payload" });
  }
});

export const richButtonsBlockSchema = z.object({
  kind: z.literal("buttons"),
  text: z.string().min(1).max(4096),
  buttons: z.array(richButtonSchema).min(1).max(10),
});

export const richListBlockSchema = z.object({
  kind: z.literal("list"),
  text: z.string().min(1).max(4096),
  /** Label of the button that opens the list (WhatsApp / native pickers). */
  buttonText: z.string().min(1).max(40),
  sections: z.array(z.object({
    title: z.string().min(1).max(80),
    rows: z.array(z.object({
      id: z.string().min(1).max(200),
      title: z.string().min(1).max(80),
      description: z.string().max(160).optional(),
    })).min(1).max(10),
  })).min(1).max(10),
});

export const richCarouselBlockSchema = z.object({
  kind: z.literal("carousel"),
  cards: z.array(z.object({
    title: z.string().min(1).max(160),
    subtitle: z.string().max(320).optional(),
    imageUrl: z.string().url().max(2000).optional(),
    buttons: z.array(richButtonSchema).max(3).optional(),
  })).min(1).max(10),
});

export const richProductBlockSchema = z.object({
  kind: z.literal("product"),
  catalogId: z.string().min(1).max(200),
  productId: z.string().min(1).max(200),
  text: z.string().max(4096).optional(),
});

export const richCatalogSectionSchema = z.object({
  title: z.string().min(1).max(80),
  productIds: z.array(z.string().min(1).max(200)).min(1).max(30),
});

export const richCatalogBlockSchema = z.object({
  kind: z.literal("catalog"),
  catalogId: z.string().min(1).max(200),
  text: z.string().max(4096).optional(),
  sections: z.array(richCatalogSectionSchema).max(10).optional(),
});

export const richBlockSchema = z.discriminatedUnion("kind", [
  richButtonsBlockSchema,
  richListBlockSchema,
  richCarouselBlockSchema,
  richProductBlockSchema,
  richCatalogBlockSchema,
]);

export type RichButton = z.infer<typeof richButtonSchema>;
export type RichBlock = z.infer<typeof richBlockSchema>;

/**
 * Typed warning codes a renderer attaches to SendResult.warnings when a
 * block could not be rendered exactly as authored. Callers (inbox, worker
 * logs) surface these - degradation is always visible, never silent.
 */
export type RichWarning =
  | "RICH_DEGRADED_TO_TEXT" // whole block rendered as formatted plain text
  | "RICH_BUTTONS_TRUNCATED" // provider button cap cut some buttons
  | "RICH_TITLES_TRUNCATED" // provider title-length cap shortened a title
  | "RICH_ROWS_TRUNCATED" // provider list-row cap cut some rows
  | "RICH_URL_BUTTONS_DROPPED" // url buttons cannot render on this surface
  | "RICH_CAROUSEL_SEQUENTIAL" // carousel sent as a sequence of card messages
  | "RICH_LIST_AS_KEYBOARD"; // list rendered as an inline keyboard

/** The plain-text body of a block (used as the persisted message body and as the text fallback rendering). */
export function richBlockText(block: RichBlock): string {
  switch (block.kind) {
    case "buttons": return block.text;
    case "list": return block.text;
    case "carousel": return block.cards[0]?.title ?? "";
    case "product": return block.text ?? "";
    case "catalog": return block.text ?? "";
  }
}

/**
 * Deterministic formatted plain-text rendering of any block - the universal
 * fallback for channels without a native renderer for the block kind
 * (email, webchat, unsupported combos elsewhere). Buttons become labelled
 * lines, list rows become a numbered outline, cards stack vertically.
 */
export function richToPlainText(block: RichBlock): string {
  switch (block.kind) {
    case "buttons": {
      const lines = block.buttons.map((b) =>
        b.type === "url" ? `- ${b.title}: ${b.url ?? ""}` : `- ${b.title}`);
      return [block.text, ...lines].join("\n");
    }
    case "list": {
      const lines: string[] = [block.text];
      for (const section of block.sections) {
        lines.push("", section.title);
        section.rows.forEach((row, i) => {
          lines.push(`${i + 1}. ${row.title}${row.description ? ` - ${row.description}` : ""}`);
        });
      }
      return lines.join("\n");
    }
    case "carousel": {
      return block.cards.map((card) => {
        const lines = [card.title];
        if (card.subtitle) lines.push(card.subtitle);
        if (card.imageUrl) lines.push(card.imageUrl);
        for (const b of card.buttons ?? []) {
          lines.push(b.type === "url" ? `- ${b.title}: ${b.url ?? ""}` : `- ${b.title}`);
        }
        return lines.join("\n");
      }).join("\n\n");
    }
    case "product":
      return [block.text ?? "", `Product: ${block.productId} (catalog ${block.catalogId})`]
        .filter(Boolean).join("\n");
    case "catalog": {
      const lines = [block.text ?? `Catalog: ${block.catalogId}`];
      for (const section of block.sections ?? []) {
        lines.push("", section.title, ...section.productIds.map((id) => `- ${id}`));
      }
      return lines.join("\n");
    }
  }
}
