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

const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * Count-aware phrasing. Hand-rolled `${n === 1 ? "" : "s"}` was applied at one
 * call site and forgotten at others, which is how `claim(s)` reached the UI.
 *
 * Chinese has no plural inflection, so `zh` collapses to a single form.
 */
export function plural(
  locale: Locale,
  count: number,
  forms: { one: string; other: string; zh: string },
): string {
  if (locale === "zh-CN") return forms.zh.replace("{n}", String(count));
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const form = rules.select(count) === "one" ? forms.one : forms.other;
  return form.replace("{n}", String(count));
}
