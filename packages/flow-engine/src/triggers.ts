/**
 * Flow trigger matching (Fase 4).
 *
 * A flow's trigger is stored at flow level (flows.trigger jsonb) so the
 * inbound dispatcher can match WITHOUT parsing the graph:
 *
 *   { type: "keyword",  config: { keyword: "harga", match?: "contains"|"equals" } }
 *   { type: "postback", config: { payload: "GET_STARTED", match?: ... } }
 *   { type: "comment_keyword", config: { keyword, match?, publicReplyText?,
 *       autoHide?, privateText? } }   // comment automation / comment-to-DM
 *   { type: "manual",   config: {} }   // never matches inbound events
 *
 * Matching is case-insensitive and trims surrounding whitespace. "contains"
 * is the default for keywords (chat users type sentences, not exact
 * commands); "equals" is available for strict commands. This function is
 * pure and is shared by the API dispatcher and its unit tests.
 */
export interface FlowTrigger {
  type: "keyword" | "postback" | "manual" | "comment_keyword";
  config: Record<string, unknown>;
}

/**
 * Comment-automation trigger config (trigger type "comment_keyword").
 * Semantics: when a comment matches, the dispatcher enqueues a
 * comment-action job - the worker posts `publicReplyText` as a public
 * comment reply (when set), hides the comment (when `autoHide`), and
 * delivers a PRIVATE reply to the comment: `privateText` when set,
 * otherwise the flow's first send_message node text (that node is then
 * skipped in the ensuing flow run). The flow then continues in the
 * resulting DM conversation.
 */
export interface CommentTriggerConfig {
  keyword: string;
  match?: "contains" | "equals";
  publicReplyText?: string;
  autoHide?: boolean;
  privateText?: string;
}

/** Read a comment_keyword trigger's config defensively (jsonb is untyped at rest). */
export function commentTriggerConfig(trigger: FlowTrigger): CommentTriggerConfig | null {
  if (trigger.type !== "comment_keyword") return null;
  const config = trigger.config ?? {};
  const keyword = typeof config.keyword === "string" ? config.keyword : "";
  if (!keyword) return null;
  return {
    keyword,
    match: config.match === "equals" ? "equals" : "contains",
    publicReplyText: typeof config.publicReplyText === "string" && config.publicReplyText
      ? config.publicReplyText
      : undefined,
    autoHide: config.autoHide === true,
    privateText: typeof config.privateText === "string" && config.privateText
      ? config.privateText
      : undefined,
  };
}

const normalize = (s: string): string => s.trim().toLowerCase();

export function flowTriggerMatches(
  trigger: FlowTrigger,
  input: { text?: string; payload?: string; commentText?: string },
): boolean {
  if (trigger.type === "manual") return false;
  const config = trigger.config ?? {};
  const matchMode = config.match === "equals" ? "equals" : "contains";

  if (trigger.type === "keyword" || trigger.type === "comment_keyword") {
    // keyword matches message text; comment_keyword matches comment text.
    const keyword = typeof config.keyword === "string" ? normalize(config.keyword) : "";
    if (!keyword) return false;
    const text = normalize(
      trigger.type === "comment_keyword" ? (input.commentText ?? "") : (input.text ?? ""),
    );
    if (!text) return false;
    return matchMode === "equals" ? text === keyword : text.includes(keyword);
  }

  // postback: match the button/postback payload string.
  const expected = typeof config.payload === "string" ? normalize(config.payload) : "";
  if (!expected) return false;
  const payload = normalize(input.payload ?? "");
  if (!payload) return false;
  return matchMode === "equals" ? payload === expected : payload.includes(expected);
}
