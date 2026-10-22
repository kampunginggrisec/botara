/**
 * Flow trigger matching (Fase 4).
 *
 * A flow's trigger is stored at flow level (flows.trigger jsonb) so the
 * inbound dispatcher can match WITHOUT parsing the graph:
 *
 *   { type: "keyword",  config: { keyword: "harga", match?: "contains"|"equals" } }
 *   { type: "postback", config: { payload: "GET_STARTED", match?: ... } }
 *   { type: "manual",   config: {} }   // never matches inbound events
 *
 * Matching is case-insensitive and trims surrounding whitespace. "contains"
 * is the default for keywords (chat users type sentences, not exact
 * commands); "equals" is available for strict commands. This function is
 * pure and is shared by the API dispatcher and its unit tests.
 */
export interface FlowTrigger {
  type: "keyword" | "postback" | "manual";
  config: Record<string, unknown>;
}

const normalize = (s: string): string => s.trim().toLowerCase();

export function flowTriggerMatches(
  trigger: FlowTrigger,
  input: { text?: string; payload?: string },
): boolean {
  if (trigger.type === "manual") return false;
  const config = trigger.config ?? {};
  const matchMode = config.match === "equals" ? "equals" : "contains";

  if (trigger.type === "keyword") {
    const keyword = typeof config.keyword === "string" ? normalize(config.keyword) : "";
    if (!keyword) return false;
    const text = normalize(input.text ?? "");
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
