import type { SavedReply } from "./api";

/**
 * Saved-replies picker model (package #2): the pure filtering behind the
 * composer's saved-reply search.
 *
 * Behavior:
 *  - an empty query returns the library as-is (the API orders by title);
 *  - a query starting with "/" matches SHORTCUTS by prefix first (the
 *    quick path: type "/ha" to find "/halo"), then falls back to plain
 *    substring matches over title/body/shortcut (also tried without the
 *    slash, since titles and bodies do not contain it);
 *  - any other query is a case-insensitive substring match over title,
 *    body, and shortcut, preserving title order.
 * Picking an entry inserts its BODY into the composer verbatim; bodies
 * may contain {{variables}}, which the normal reply path renders per
 * contact at send time.
 */
export function filterSavedReplies(replies: SavedReply[], query: string): SavedReply[] {
  const q = query.trim().toLowerCase();
  if (!q) return replies;
  const matchesText = (r: SavedReply): boolean =>
    r.title.toLowerCase().includes(q)
    || r.body.toLowerCase().includes(q)
    || (r.shortcut ?? "").toLowerCase().includes(q);
  if (q.startsWith("/")) {
    const byShortcut = replies.filter((r) => (r.shortcut ?? "").toLowerCase().startsWith(q));
    const bare = q.slice(1);
    const matchesBare = (r: SavedReply): boolean =>
      r.title.toLowerCase().includes(bare)
      || r.body.toLowerCase().includes(bare)
      || (r.shortcut ?? "").toLowerCase().includes(bare);
    const rest = replies.filter((r) => !byShortcut.includes(r) && (matchesText(r) || matchesBare(r)));
    return [...byShortcut, ...rest];
  }
  return replies.filter(matchesText);
}
