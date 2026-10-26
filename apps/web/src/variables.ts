import type { DictKey } from "./i18n/en";

/**
 * Variable picker model (variables package #1): the documented
 * `{{...}}` catalogue shared by every authoring surface (inbox
 * composer, broadcast form, sequence editor, flow builder) plus the
 * pure insertion math. The catalogue mirrors docs/variables.md and the
 * @botara/shared engine roots - keep all three in sync.
 */

export type VariableGroup = "contact" | "workspace" | "channel" | "vars" | "system";

export interface VariableOption {
  /** Dot path inside the braces, e.g. "contact.name". */
  token: string;
  group: VariableGroup;
  labelKey: DictKey;
}

export const VARIABLE_GROUP_ORDER: VariableGroup[] = ["contact", "workspace", "channel", "workspace", "vars", "system"];

export const VARIABLE_GROUP_LABEL_KEYS: Record<VariableGroup, DictKey> = {
  contact: "variables.group.contact",
  workspace: "variables.group.workspace",
  channel: "variables.group.channel",
  vars: "variables.group.vars",
  system: "variables.group.system",
};

export const VARIABLE_OPTIONS: VariableOption[] = [
  { token: "contact.name", group: "contact", labelKey: "variables.opt.contactName" },
  { token: "contact.externalId", group: "contact", labelKey: "variables.opt.contactExternalId" },
  { token: "contact.channel", group: "contact", labelKey: "variables.opt.contactChannel" },
  { token: "contact.tags", group: "contact", labelKey: "variables.opt.contactTags" },
  { token: "contact.customField", group: "contact", labelKey: "variables.opt.contactCustomField" },
  { token: "channel.name", group: "channel", labelKey: "variables.opt.channelName" },
  { token: "channel.platform", group: "channel", labelKey: "variables.opt.channelPlatform" },
  { token: "workspace.name", group: "workspace", labelKey: "variables.opt.workspaceName" },
  { token: "vars.value", group: "vars", labelKey: "variables.opt.varsValue" },
  { token: "system.date", group: "system", labelKey: "variables.opt.systemDate" },
  { token: "system.time", group: "system", labelKey: "variables.opt.systemTime" },
  { token: "system.now", group: "system", labelKey: "variables.opt.systemNow" },
];

/** Options for one surface; the `vars` root only exists inside flow runs. */
export function variableOptions(includeVars: boolean): VariableOption[] {
  return VARIABLE_OPTIONS.filter((opt) => includeVars || opt.group !== "vars");
}

export function variableToken(token: string): string {
  return `{{${token}}}`;
}

/**
 * Insert `{{token}}` into `text` replacing the selection
 * [selStart, selEnd) (a null selection appends at the end). Returns the
 * new text and the caret position just after the inserted token.
 */
export function insertVariable(
  text: string,
  token: string,
  selStart: number | null,
  selEnd: number | null,
): { text: string; caret: number } {
  const inserted = variableToken(token);
  const start = selStart ?? text.length;
  const end = selEnd ?? start;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    caret: start + inserted.length,
  };
}

/**
 * Insert raw text (a saved-reply body, package #2) into `text` replacing
 * the selection [selStart, selEnd) - same caret math as insertVariable,
 * without the {{ }} wrapping. Returns the new text and the caret just
 * after the inserted text.
 */
export function insertPlainText(
  text: string,
  inserted: string,
  selStart: number | null,
  selEnd: number | null,
): { text: string; caret: number } {
  const start = selStart ?? text.length;
  const end = selEnd ?? start;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    caret: start + inserted.length,
  };
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Insert a {{token}} into a (possibly React-controlled) field at its
 * current selection: set the value through the native setter so React's
 * change tracking sees it, dispatch `input` so onChange fires, then
 * restore focus with the caret after the inserted text.
 */
export function insertIntoElement(el: TextField, token: string): void {
  insertTextIntoElement(el, variableToken(token));
}

/**
 * Insert arbitrary text into a field at its current selection - the
 * shared machinery behind insertIntoElement (variable tokens) and the
 * saved-replies picker (raw bodies, package #2).
 */
export function insertTextIntoElement(el: TextField, inserted: string): void {
  const { text, caret } = insertPlainText(el.value, inserted, el.selectionStart, el.selectionEnd);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  requestAnimationFrame(() => {
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      /* some input types (number) reject selection ranges */
    }
  });
}
