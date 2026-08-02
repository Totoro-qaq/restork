export type Locale = "en" | "zh-CN";

export const LOCALE_STORAGE_KEY = "restork.locale";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function browserLanguage(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language;
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "zh-CN";
}

export function detectLocale(
  storage: Storage | null = browserStorage(),
  language: string = browserLanguage(),
): Locale {
  try {
    const saved = storage?.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // A blocked storage API must never prevent the local Dashboard from starting.
  }
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function persistLocale(
  locale: Locale,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory choice still applies when persistence is unavailable.
  }
}

export function alternateLocale(locale: Locale): Locale {
  return locale === "en" ? "zh-CN" : "en";
}

export function localeOf(root: HTMLElement): Locale {
  return isLocale(root.dataset.locale) ? root.dataset.locale : "en";
}

export function tr(locale: Locale, english: string, chinese: string): string {
  return locale === "zh-CN" ? chinese : english;
}
