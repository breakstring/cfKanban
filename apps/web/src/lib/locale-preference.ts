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

  const preferred = browserLanguages[0]?.toLowerCase() ?? "";
  return preferred === "zh"
    || preferred.startsWith("zh-cn")
    || preferred.startsWith("zh-hans")
    ? "zh-CN"
    : "en";
}
