/**
 * Message + system variables (combined adoption package #1).
 *
 * ONE interpolation engine for every send surface: flow send_message
 * nodes (flow-engine executor), sequence steps, broadcast template
 * params, and inbox manual replies. Before this module, Botara message
 * texts were fully static - the audits (ChatbotX + wacrm) flagged the
 * missing personalization layer as the platform's #1 structural gap.
 *
 * Syntax: `{{path}}` with dot paths; whitespace inside the braces is
 * tolerated (`{{ contact.name }}`). Supported roots:
 *
 *   contact.name          display name, falling back to the external id
 *   contact.externalId     the contact's id on its channel
 *   contact.channel       the contact's channel key
 *   contact.tags          tags joined with ", "
 *   contact.<field>        any contact custom field (reserved keys above
 *                          win over a custom field of the same name);
 *                          nested objects resolve by walking the path
 *   workspace.name
 *   channel.name           channel account display name (falls back to
 *                          the platform key when the account has none)
 *   channel.platform       channel key (whatsapp, telegram, ...)
 *   vars.<name>            the flow-run variable bag (trigger data +
 *                          caller-loaded values); on non-flow surfaces
 *                          the bag is simply empty
 *   system.date            current date in UTC, YYYY-MM-DD
 *   system.time            current time in UTC, HH:MM (24h)
 *   system.now             current timestamp, full ISO 8601 (UTC)
 *
 * Semantics (deliberate, mirrored in docs/variables.md):
 * - Unknown / unresolvable variables render as an EMPTY STRING and add
 *   an UNKNOWN_VARIABLE warning carrying the path. Interpolation NEVER
 *   throws and never leaks a raw `{{...}}` token to a customer.
 * - Non-string values stringify: numbers/booleans via String(), arrays
 *   join with ", ", objects render as JSON.
 * - null / missing values count as unresolvable.
 * - There is NO escaping mechanism in v1: a literal `{{` in authored
 *   text is always treated as a variable opener.
 * - system.* is evaluated in UTC: workspaces store no timezone yet
 *   (a workspace-timezone field arrives with the analytics package).
 */

export interface InterpolationWarning {
  code: "UNKNOWN_VARIABLE";
  /** The dot path that could not be resolved, e.g. "contact.city". */
  path: string;
}

export interface InterpolationResult {
  text: string;
  warnings: InterpolationWarning[];
}

/** A contact as the send paths know it (DB row subset / snapshot). */
export interface InterpolationContactInput {
  displayName?: string | null;
  externalId: string;
  channel: string;
  tags?: readonly string[] | null;
  customFields?: Record<string, unknown> | null;
}

/** A channel account as the send paths know it (DB row subset). */
export interface InterpolationChannelInput {
  displayName?: string | null;
  /** Channel key (whatsapp, telegram, ...). */
  channel?: string | null;
}

/**
 * The built context `interpolate` consumes. Construct it with
 * buildVariableContext from row-shaped data; `now` is injectable for
 * tests and defaults to the moment of interpolation.
 */
export interface VariableContext {
  contact?: {
    name: string;
    externalId: string;
    channel: string;
    tags: readonly string[];
    customFields: Record<string, unknown>;
  };
  workspace?: { name?: string | null };
  channel?: { name?: string | null; platform?: string | null };
  vars?: Record<string, unknown>;
  now?: Date;
}

export function buildVariableContext(input: {
  contact?: InterpolationContactInput | null;
  workspaceName?: string | null;
  channelAccount?: InterpolationChannelInput | null;
  vars?: Record<string, unknown>;
  now?: Date;
}): VariableContext {
  const ctx: VariableContext = {};
  if (input.contact) {
    ctx.contact = {
      name: input.contact.displayName ?? input.contact.externalId,
      externalId: input.contact.externalId,
      channel: input.contact.channel,
      tags: input.contact.tags ?? [],
      customFields: input.contact.customFields ?? {},
    };
  }
  if (input.workspaceName !== undefined) ctx.workspace = { name: input.workspaceName };
  if (input.channelAccount) {
    ctx.channel = {
      name: input.channelAccount.displayName ?? input.channelAccount.channel ?? null,
      platform: input.channelAccount.channel ?? null,
    };
  }
  if (input.vars) ctx.vars = input.vars;
  if (input.now) ctx.now = input.now;
  return ctx;
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => stringifyValue(item)).join(", ");
  return JSON.stringify(value) ?? "";
}

/** Walk `root` along `segments`; found only when every step exists and the leaf is non-null. */
function walk(root: unknown, segments: string[]): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || current === undefined) return { found: false };
  return { found: true, value: current };
}

function resolvePath(path: string, ctx: VariableContext): { found: boolean; value?: unknown } {
  const segments = path.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return { found: false };
  const [root, ...rest] = segments as [string, ...string[]];
  switch (root) {
    case "contact": {
      if (!ctx.contact || rest.length === 0) return { found: false };
      // Reserved keys win over custom fields of the same name.
      if (rest.length === 1) {
        if (rest[0] === "name") return { found: true, value: ctx.contact.name };
        if (rest[0] === "externalId") return { found: true, value: ctx.contact.externalId };
        if (rest[0] === "channel") return { found: true, value: ctx.contact.channel };
        if (rest[0] === "tags") return { found: true, value: ctx.contact.tags };
      }
      return walk(ctx.contact.customFields, rest);
    }
    case "workspace": {
      if (rest.length === 1 && rest[0] === "name" && ctx.workspace?.name != null) {
        return { found: true, value: ctx.workspace.name };
      }
      return { found: false };
    }
    case "channel": {
      if (!ctx.channel || rest.length !== 1) return { found: false };
      if (rest[0] === "name" && ctx.channel.name != null) return { found: true, value: ctx.channel.name };
      if (rest[0] === "platform" && ctx.channel.platform != null) return { found: true, value: ctx.channel.platform };
      return { found: false };
    }
    case "vars": {
      if (!ctx.vars || rest.length === 0) return { found: false };
      return walk(ctx.vars, rest);
    }
    case "system": {
      if (rest.length !== 1) return { found: false };
      const now = ctx.now ?? new Date();
      if (rest[0] === "date") return { found: true, value: now.toISOString().slice(0, 10) };
      if (rest[0] === "time") return { found: true, value: now.toISOString().slice(11, 16) };
      if (rest[0] === "now") return { found: true, value: now.toISOString() };
      return { found: false };
    }
    default:
      return { found: false };
  }
}

/**
 * Render `template` against `ctx`. A template without tokens returns
 * byte-identical with zero warnings. Never throws.
 */
export function interpolate(template: string, ctx: VariableContext): InterpolationResult {
  if (!template.includes("{{")) return { text: template, warnings: [] };
  const warnings: InterpolationWarning[] = [];
  const text = template.replace(TOKEN_RE, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const resolved = resolvePath(path, ctx);
    if (!resolved.found) {
      warnings.push({ code: "UNKNOWN_VARIABLE", path });
      return "";
    }
    return stringifyValue(resolved.value);
  });
  return { text, warnings };
}
