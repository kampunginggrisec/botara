import { AppError } from "@botara/shared";
import type { TemplateRow } from "@botara/db";
import {
  connectTemplateGraph,
  type TemplateGraphDeps,
  type TemplateSyncAccountRef,
  type TemplateSyncStoreRow,
} from "./template-sync";

/**
 * WhatsApp template WRITE path (WA-4 continuation).
 *
 * The sync (`template-sync.ts`) pulls Meta's truth DOWN. This module pushes
 * UP: it validates a component tree the way Meta will, submits it
 * (`POST /{waba}/message_templates`), mirrors the returned approval status,
 * and deletes templates by name.
 *
 * Validation lives here - not in the route schema - because the rules are
 * about WhatsApp's template semantics (one BODY, sequential `{{n}}`
 * placeholders, per-type button ceilings), and the SAME validator feeds the
 * pre-send parameter-count check. One implementation, two call sites, so the
 * composer can never build something the sender rejects.
 */

/** Meta's template name rule: lowercase, digits and underscores only. */
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
/** BCP-47-ish: `en`, `id`, `pt_BR`, `zh_CN`. */
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

export const TEMPLATE_CATEGORIES = ["marketing", "utility", "authentication"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Meta's ceilings for a text template body. */
const BODY_MAX_CHARS = 1024;
const HEADER_TEXT_MAX_CHARS = 60;
const FOOTER_MAX_CHARS = 60;
const BUTTON_TEXT_MAX_CHARS = 25;
const MAX_BUTTONS = 10;

/** How many buttons of each type Meta allows in one template. */
const BUTTON_TYPE_LIMITS: Record<string, number> = {
  QUICK_REPLY: 10,
  URL: 2,
  PHONE_NUMBER: 1,
  COPY_CODE: 1,
};

export interface TemplateComponentInput {
  type?: unknown;
  format?: unknown;
  text?: unknown;
  buttons?: unknown;
  example?: unknown;
}

export interface ValidatedTemplateComponents {
  /** Normalized tree, ready to POST to Meta and to store verbatim. */
  components: Array<Record<string, unknown>>;
  /** Number of `{{n}}` body placeholders - what a broadcast must supply. */
  bodyParamCount: number;
}

/**
 * Declared as a function (not an arrow const) so TypeScript's control-flow
 * analysis treats a call as never-returning and narrows the branches below.
 */
function invalid(message: string): never {
  throw new AppError("VALIDATION", message, { status: 400 });
}

/**
 * Count positional body placeholders and enforce Meta's sequential rule.
 *
 * Meta numbers parameters `{{1}}..{{n}}` with no gaps and no repeats of a
 * skipped index; `{{1}} {{3}}` is rejected at submission, and sending two
 * values for a one-placeholder body is rejected at send time. Validating
 * here turns both into a readable 400 before anything is queued.
 */
export function countBodyParams(text: string): number {
  const matches = [...text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)];
  if (matches.length === 0) return 0;
  const indexes: number[] = [];
  for (const match of matches) {
    const raw = match[1] ?? "";
    if (!/^\d+$/.test(raw)) {
      invalid(`Body placeholders must be positional numbers like {{1}} - found "{{${raw}}}".`);
    }
    const value = Number(raw);
    if (value < 1 || value > 25) {
      invalid(`Body placeholder {{${raw}}} is out of range: WhatsApp allows {{1}} to {{25}}.`);
    }
    indexes.push(value);
  }
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  if (unique.some((value, i) => value !== i + 1)) {
    invalid(`Body placeholders must be sequential from {{1}} - found {{${unique.join("}}, {{")}}}.`);
  }
  return unique.length;
}

/**
 * Validate + normalize a component tree.
 *
 * Only the rules that change what Meta accepts or what a send needs are
 * enforced: one BODY, at most one HEADER/FOOTER/BUTTONS, text length caps,
 * button ceilings, and sequential body placeholders. Media headers are
 * accepted when they carry the `example.header_handle` Meta requires; the
 * composer only offers TEXT.
 */
export function validateTemplateComponents(input: unknown): ValidatedTemplateComponents {
  if (!Array.isArray(input) || input.length === 0) {
    invalid("components must be a non-empty array (at least one BODY component).");
  }
  const list = input as TemplateComponentInput[];
  const seen = new Set<string>();
  const components: Array<Record<string, unknown>> = [];
  let bodyParamCount = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") invalid("Every component must be an object.");
    const type = String(raw.type ?? "").toUpperCase();
    if (!["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(type)) {
      invalid(`Unknown component type "${String(raw.type)}": expected HEADER, BODY, FOOTER or BUTTONS.`);
    }
    if (seen.has(type)) invalid(`Duplicate ${type} component: a template has at most one.`);
    seen.add(type);

    if (type === "HEADER") {
      const format = String(raw.format ?? "TEXT").toUpperCase();
      if (!["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"].includes(format)) {
        invalid(`Unknown header format "${String(raw.format)}".`);
      }
      if (format === "TEXT") {
        const text = typeof raw.text === "string" ? raw.text.trim() : "";
        if (text.length === 0) invalid("A TEXT header needs a non-empty text.");
        if (text.length > HEADER_TEXT_MAX_CHARS) {
          invalid(`Header text is ${text.length} characters; WhatsApp allows ${HEADER_TEXT_MAX_CHARS}.`);
        }
        // A header may carry ONE variable, which is supplied as a header
        // parameter at send time - the composer does not expose it, but a
        // synced template may have it, so accept it here.
        components.push({ type, format, text });
        continue;
      }
      const handle = (raw.example as { header_handle?: unknown } | undefined)?.header_handle;
      if (!Array.isArray(handle) || handle.length === 0) {
        invalid(`A ${format} header needs example.header_handle (the sample media Meta reviews).`);
      }
      components.push({ type, format, example: { header_handle: handle } });
      continue;
    }

    if (type === "BODY") {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (text.length === 0) invalid("A BODY component needs a non-empty text.");
      if (text.length > BODY_MAX_CHARS) {
        invalid(`Body text is ${text.length} characters; WhatsApp allows ${BODY_MAX_CHARS}.`);
      }
      bodyParamCount = countBodyParams(text);
      components.push({ type, text });
      continue;
    }

    if (type === "FOOTER") {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (text.length === 0) invalid("A FOOTER component needs a non-empty text.");
      if (text.length > FOOTER_MAX_CHARS) {
        invalid(`Footer text is ${text.length} characters; WhatsApp allows ${FOOTER_MAX_CHARS}.`);
      }
      components.push({ type, text });
      continue;
    }

    // BUTTONS
    if (!Array.isArray(raw.buttons) || raw.buttons.length === 0) {
      invalid("A BUTTONS component needs at least one button.");
    }
    if (raw.buttons.length > MAX_BUTTONS) {
      invalid(`A template allows at most ${MAX_BUTTONS} buttons.`);
    }
    const perType: Record<string, number> = {};
    const buttons: Array<Record<string, unknown>> = [];
    for (const entry of raw.buttons as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== "object") invalid("Every button must be an object.");
      const buttonType = String(entry.type ?? "").toUpperCase();
      if (!(buttonType in BUTTON_TYPE_LIMITS)) {
        invalid(`Unknown button type "${String(entry.type)}": expected QUICK_REPLY, URL, PHONE_NUMBER or COPY_CODE.`);
      }
      perType[buttonType] = (perType[buttonType] ?? 0) + 1;
      if (perType[buttonType]! > BUTTON_TYPE_LIMITS[buttonType]!) {
        invalid(`A template allows at most ${BUTTON_TYPE_LIMITS[buttonType]} ${buttonType} button(s).`);
      }
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (text.length === 0) invalid(`A ${buttonType} button needs a label.`);
      if (text.length > BUTTON_TEXT_MAX_CHARS) {
        invalid(`Button label "${text}" is ${text.length} characters; WhatsApp allows ${BUTTON_TEXT_MAX_CHARS}.`);
      }
      if (buttonType === "URL") {
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) invalid(`A URL button needs an http(s) url - got "${url}".`);
        buttons.push({ type: buttonType, text, url });
        continue;
      }
      if (buttonType === "PHONE_NUMBER") {
        const phone = typeof entry.phone_number === "string" ? entry.phone_number.trim() : "";
        if (!/^\+?\d{6,20}$/.test(phone)) {
          invalid(`A PHONE_NUMBER button needs a dialable phone_number - got "${phone}".`);
        }
        buttons.push({ type: buttonType, text, phone_number: phone });
        continue;
      }
      buttons.push({ type: buttonType, text });
    }
    components.push({ type, buttons });
  }

  if (!seen.has("BODY")) invalid("A template must have a BODY component.");
  return { components, bodyParamCount };
}

/** Validate the parts of a submission that are not the component tree. */
export function validateTemplateName(name: string): string {
  const trimmed = name.trim();
  if (!TEMPLATE_NAME_RE.test(trimmed)) {
    invalid("Template name must be lowercase letters, digits and underscores (max 512), e.g. order_update.");
  }
  return trimmed;
}

export function validateTemplateLanguage(language: string): string {
  const trimmed = language.trim();
  if (!TEMPLATE_LANGUAGE_RE.test(trimmed)) {
    invalid(`Template language must look like "en", "id" or "pt_BR" - got "${trimmed}".`);
  }
  return trimmed;
}

export function validateTemplateCategory(category: string): TemplateCategory {
  const lower = category.trim().toLowerCase();
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(lower)) {
    invalid(`Template category must be one of ${TEMPLATE_CATEGORIES.join(", ")} - got "${category}".`);
  }
  return lower as TemplateCategory;
}

/**
 * How many body parameters a stored template expects, or null when the row
 * carries no component tree (hand-registered templates) - null means
 * "unknown, do not enforce", never "zero".
 *
 * A malformed placeholder in a MIRRORED row is not the caller's fault, so it
 * degrades to null instead of failing the broadcast: Meta's own send
 * validation is the backstop there.
 */
export function templateBodyParamCount(components: unknown): number | null {
  if (!Array.isArray(components)) return null;
  const body = components.find(
    (component) => typeof component === "object"
      && component !== null
      && String((component as { type?: unknown }).type ?? "").toUpperCase() === "BODY",
  ) as { text?: unknown } | undefined;
  if (!body || typeof body.text !== "string") return null;
  try {
    return countBodyParams(body.text);
  } catch {
    return null;
  }
}

export interface TemplateWriteStore {
  upsert: (row: TemplateSyncStoreRow) => Promise<{ row: TemplateRow; created: boolean }>;
  remove: (id: string) => Promise<boolean>;
}

export interface TemplateWriteDeps extends TemplateGraphDeps {
  store: TemplateWriteStore;
}

export interface SubmitTemplateInput {
  workspaceId: string;
  account: TemplateSyncAccountRef;
  name: string;
  language: string;
  category: string;
  components: unknown;
  /**
   * Meta refuses a category change on an existing template unless this is
   * set. Exposed because the composer legitimately re-submits a template
   * under a corrected category (ADR-008 routing follows the category).
   */
  allowCategoryChange?: boolean;
}

export interface SubmitTemplateResult {
  wabaId: string;
  template: TemplateRow;
  /** True when this submission created the local mirror row. */
  created: boolean;
}

/**
 * Submit a template to Meta and mirror the result.
 *
 * The mirrored status is Meta's answer (normally `pending`), never
 * "approved": the local row is what the broadcast pre-check reads, so
 * optimism here would let a broadcast queue against a template Meta has not
 * reviewed yet.
 */
export async function submitWhatsAppTemplate(
  deps: TemplateWriteDeps,
  input: SubmitTemplateInput,
): Promise<SubmitTemplateResult> {
  const name = validateTemplateName(input.name);
  const language = validateTemplateLanguage(input.language);
  const category = validateTemplateCategory(input.category);
  const { components } = validateTemplateComponents(input.components);

  const { wabaId, adapter } = await connectTemplateGraph(deps, input.account);
  const created = await adapter.createMessageTemplate(
    { id: input.account.id, externalId: input.account.externalId },
    wabaId,
    {
      name,
      language,
      category,
      components,
      ...(input.allowCategoryChange ? { allowCategoryChange: true } : {}),
    },
  );

  const status = created.status.toLowerCase();
  const upserted = await deps.store.upsert({
    workspaceId: input.workspaceId,
    channelAccountId: input.account.id,
    name,
    language,
    category: created.category ?? category,
    ...(created.id ? { externalId: created.id } : {}),
    status,
    messagingAccountId: wabaId,
    components,
  });

  return { wabaId, template: upserted.row, created: upserted.created };
}

export interface DeleteTemplateInput {
  workspaceId: string;
  account: TemplateSyncAccountRef;
  template: {
    id: string;
    name: string;
    /** WABA the row came from - skips the discovery round-trip when known. */
    messagingAccountId?: string | null;
  };
}

/**
 * Delete a template on Meta, then locally.
 *
 * Order matters: Meta first. A failed provider delete leaves the local row
 * intact (the operator can retry, and the panel keeps showing a template
 * that still exists). Deleting locally first would hide a template Meta
 * still holds - and still charges for.
 */
export async function deleteWhatsAppTemplate(
  deps: TemplateWriteDeps,
  input: DeleteTemplateInput,
): Promise<{ wabaId: string; deleted: boolean }> {
  const { wabaId, adapter } = await connectTemplateGraph(deps, input.account, {
    knownWabaId: input.template.messagingAccountId ?? undefined,
  });
  await adapter.deleteMessageTemplate(
    { id: input.account.id, externalId: input.account.externalId },
    wabaId,
    input.template.name,
  );
  const deleted = await deps.store.remove(input.template.id);
  return { wabaId, deleted };
}
