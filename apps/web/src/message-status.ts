/**
 * Delivery-state glyphs for outbound inbox bubbles (package #8). The
 * API has always exposed the message status; now that provider receipts
 * advance it (sent → delivered → read), the bubble renders ticks
 * instead of the raw status word. Unknown statuses render nothing -
 * the localized label next to the ticks carries the fallback.
 */
export function messageStatusTicks(status: string): { ticks: string; read: boolean } {
  switch (status) {
    case "queued":
      return { ticks: "◷", read: false };
    case "sent":
      return { ticks: "✓", read: false };
    case "delivered":
      return { ticks: "✓✓", read: false };
    case "read":
      return { ticks: "✓✓", read: true };
    case "failed":
      return { ticks: "✗", read: false };
    default:
      return { ticks: "", read: false };
  }
}

/** i18n key for a message status label, or null when the status has no known label. */
export function messageStatusLabelKey(status: string): string | null {
  switch (status) {
    case "queued":
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return `inbox.status.${status}`;
    default:
      return null;
  }
}
