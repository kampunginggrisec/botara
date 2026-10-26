import { useState } from "react";
import { useI18n } from "./i18n";
import {
  VARIABLE_GROUP_LABEL_KEYS, VARIABLE_GROUP_ORDER, insertIntoElement, variableOptions, variableToken,
  type VariableGroup,
} from "./variables";

/**
 * Variable-insert picker (variables package #1): an "{x} Variable"
 * button opening a small grouped menu; clicking an entry inserts its
 * `{{token}}` at the caret of the field returned by `target`. Shared by
 * the inbox composer, broadcast form, sequence editor, and flow
 * builder so every authoring surface offers the same catalogue.
 */
export function VariablePicker({
  target,
  includeVars = false,
}: {
  /** Resolves the field to insert into (usually a ref getter). */
  target: () => HTMLInputElement | HTMLTextAreaElement | null;
  /** Flow surfaces only: the `vars.*` root exists just inside flow runs. */
  includeVars?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const options = variableOptions(includeVars);
  const groups = VARIABLE_GROUP_ORDER.filter((g) => options.some((o) => o.group === g));

  const pick = (token: string) => {
    const el = target();
    if (el) insertIntoElement(el, token);
    setOpen(false);
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
      >
        {t("variables.insert")}
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-72 w-72 overflow-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {groups.map((group: VariableGroup) => (
            <div key={group} className="py-1">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {t(VARIABLE_GROUP_LABEL_KEYS[group])}
              </div>
              {options.filter((o) => o.group === group).map((opt) => (
                <button
                  key={opt.token}
                  type="button"
                  onClick={() => pick(opt.token)}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <span>{t(opt.labelKey)}</span>
                  <code className="text-[10px] text-slate-400">{variableToken(opt.token)}</code>
                </button>
              ))}
            </div>
          ))}
          <p className="border-t border-slate-100 px-2 py-1.5 text-[10px] text-slate-400 dark:border-slate-800">
            {t("variables.hint")}
          </p>
        </div>
      )}
    </div>
  );
}
