export type SupportedLocale = "en" | "zh-CN";

interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredLocale(
  storage: () => LocaleStorage,
  key: string,
): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredLocale(
  storage: () => LocaleStorage,
  key: string,
  value: SupportedLocale,
): boolean {
  try {
    storage().setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function resolveLocalePreference(
  saved: string | null,
  browserLanguages: readonly string[],
): SupportedLocale {
  if (saved === "en" || saved === "zh-CN") return saved;

  const preferred = browserLanguages[0]?.trim().toLowerCase() ?? "";
  return /^zh(?:[-_]|$)/u.test(preferred) ? "zh-CN" : "en";
}

export function detectedBrowserLocale(browser?: {
  languages?: readonly string[];
  language?: string;
}): SupportedLocale {
  const languages = browser?.languages?.length ? browser.languages : [browser?.language ?? ""];
  return resolveLocalePreference(null, languages);
}
