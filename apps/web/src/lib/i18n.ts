import { watch } from "vue";

import type { Locale } from "../types";
import { locale, setLocale } from "./i18n-core";
import { detectedBrowserLocale, readStoredLocale, writeStoredLocale } from "./locale-preference";

export { htmlLanguage, locale, setLocale, t } from "./i18n-core";
export type { TranslationKey } from "./i18n-core";

const STORAGE_KEY = "cfkanban_locale";
let browserLocale: Locale | null = null;

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const saved = readStoredLocale(() => window.localStorage, STORAGE_KEY);
  if (saved === "en" || saved === "zh-CN") browserLocale = saved;
  return browserLocale ?? detectedBrowserLocale(window.navigator);
}

const initialBrowserLocale = initialLocale();
let accountLocaleActive = false;
let applyingAccountLocale = false;

export function applyAccountLocalePreference(saved: Locale | null | undefined, authenticated: boolean, preferSystemFallback = false): void {
  accountLocaleActive = authenticated;
  applyingAccountLocale = true;
  try {
    setLocale(authenticated || preferSystemFallback
      ? (saved === "en" || saved === "zh-CN" ? saved : detectedBrowserLocale(typeof window === "undefined" ? undefined : window.navigator))
      : (browserLocale ?? detectedBrowserLocale(typeof window === "undefined" ? undefined : window.navigator)));
  } finally {
    applyingAccountLocale = false;
  }
}

locale.value = initialBrowserLocale;
watch(locale, (value, previous) => {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.documentElement.lang = value;
  if (previous !== undefined && !accountLocaleActive && !applyingAccountLocale) {
    browserLocale = value;
    writeStoredLocale(() => window.localStorage, STORAGE_KEY, value);
  }
}, { immediate: true, flush: "sync" });
