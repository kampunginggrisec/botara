import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";

/**
 * Light/dark theme (Fase 4). Default = OS preference
 * (prefers-color-scheme) on first visit; the choice is persisted in
 * localStorage under "botara.theme" and applied as the `dark` class on
 * <html>. index.html carries a tiny inline script that applies the class
 * before first paint to avoid a flash.
 */
export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "botara.theme";

export function detectInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* storage unavailable */ }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(detectInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
  }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Sun/moon toggle button shown next to the language switcher. */
export function ThemeToggle({ dark = false }: { dark?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const label = theme === "dark" ? t("theme.light") : t("theme.dark");
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={`${t("theme.toggle")} - ${label}`}
      aria-label={t("theme.toggle")}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border text-sm transition-colors ${
        dark
          ? "border-slate-700 text-slate-200 hover:bg-slate-800"
          : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {theme === "dark" ? "\u2600" : "\u263E"}
    </button>
  );
}
