import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type DictKey } from "./en";
import { id } from "./id";
import { setApiLanguage } from "../api";

/**
 * Tiny typed i18n (Fase 4). Two dictionaries with identical key sets
 * (enforced by the Dictionary type + a key-parity unit test). Default
 * language is ENGLISH (Meta App Review readiness); the user's choice is
 * persisted in localStorage under "botara.lang".
 */
export type Lang = "en" | "id";
export const LANG_STORAGE_KEY = "botara.lang";

const DICTS: Record<Lang, Record<DictKey, string>> = { en, id };

export function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === "en" || stored === "id") return stored;
  } catch { /* storage unavailable */ }
  return "en";
}

export function translate(lang: Lang, key: DictKey, params?: Record<string, string | number>): string {
  let text = DICTS[lang][key] ?? en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: DictKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "en",
  setLang: () => undefined,
  t: (key, params) => translate("en", key, params),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    setApiLanguage(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { localStorage.setItem(LANG_STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    lang,
    setLang,
    t: (key, params) => translate(lang, key, params),
  }), [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** EN | ID switcher used in the shell header, auth page and legal pages. */
export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { lang, setLang, t } = useI18n();
  const base = "px-2 py-1 text-xs font-medium rounded-md transition-colors";
  const active = dark ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900";
  const idle = dark
    ? "text-slate-300 hover:text-white"
    : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100";
  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-lg border p-0.5 ${dark ? "border-slate-700" : "border-slate-300 dark:border-slate-700"}`}
      role="group"
      aria-label={t("lang.label")}
    >
      <button type="button" className={`${base} ${lang === "en" ? active : idle}`} onClick={() => setLang("en")}>EN</button>
      <button type="button" className={`${base} ${lang === "id" ? active : idle}`} onClick={() => setLang("id")}>ID</button>
    </div>
  );
}
