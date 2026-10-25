/**
 * Webchat widget rich-message view-model (pure functions, unit-tested).
 *
 * The widget (widget.ts) is a standalone IIFE script; everything about
 * turning a persisted message payload into clickable buttons lives here
 * so it can be tested without a DOM. The API persists outbound rich
 * blocks on the message row's `payload`; only kinds "buttons" and
 * "list" render natively in the widget - anything else returns null and
 * the widget shows the plain-text body.
 */

export interface WidgetRichButton {
  title: string;
  /** Smaller line under the title (list rows carry a description). */
  description?: string;
  action:
    | { type: "reply"; payload: string }
    | { type: "url"; url: string };
}

export interface WidgetRichGroup {
  /** Section title (list blocks); absent for a plain buttons block. */
  title?: string;
  buttons: WidgetRichButton[];
}

export interface WidgetRichView {
  /** The block's own message text (the bubble body). */
  text: string;
  groups: WidgetRichGroup[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the clickable-button view for a message payload, or null when
 * the payload is not a natively rendered block (plain message, click
 * echo, carousel/product/catalog, or malformed data).
 */
export function widgetRichView(payload: unknown): WidgetRichView | null {
  if (!isRecord(payload)) return null;
  if (payload.kind === "buttons") {
    const text = asString(payload.text);
    if (!text || !Array.isArray(payload.buttons)) return null;
    const buttons: WidgetRichButton[] = [];
    for (const raw of payload.buttons) {
      if (!isRecord(raw)) continue;
      const title = asString(raw.title);
      if (!title) continue;
      if (raw.type === "url") {
        const url = asString(raw.url);
        if (url) buttons.push({ title, action: { type: "url", url } });
      } else if (raw.type === "reply" || raw.type === "postback") {
        // Tapping sends the payload back; a button authored without one
        // falls back to its title (same default as the composer).
        buttons.push({ title, action: { type: "reply", payload: asString(raw.payload) ?? title } });
      }
    }
    if (buttons.length === 0) return null;
    return { text, groups: [{ buttons }] };
  }
  if (payload.kind === "list") {
    const text = asString(payload.text);
    if (!text || !Array.isArray(payload.sections)) return null;
    const groups: WidgetRichGroup[] = [];
    for (const section of payload.sections) {
      if (!isRecord(section) || !Array.isArray(section.rows)) continue;
      const buttons: WidgetRichButton[] = [];
      for (const row of section.rows) {
        if (!isRecord(row)) continue;
        const title = asString(row.title);
        const id = asString(row.id);
        if (!title || !id) continue;
        // A list-row tap posts back with the row id as its payload.
        buttons.push({ title, description: asString(row.description), action: { type: "reply", payload: id } });
      }
      if (buttons.length > 0) groups.push({ title: asString(section.title), buttons });
    }
    if (groups.length === 0) return null;
    return { text, groups };
  }
  return null;
}

/**
 * The POST body for a button tap: the visitor's message is the button's
 * title, the click code rides as buttonPayload. URL buttons return null
 * (they open a link instead of posting).
 */
export function buttonClickBody(
  button: WidgetRichButton,
): { text: string; buttonPayload: string } | null {
  if (button.action.type !== "reply") return null;
  return { text: button.title, buttonPayload: button.action.payload };
}
