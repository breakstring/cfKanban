import { watch } from "vue";

import type { Locale } from "../types";
import { locale, setLocale } from "./i18n-core";
import { readStoredLocale, resolveLocalePreference, writeStoredLocale } from "./locale-preference";

export { htmlLanguage, locale, setLocale, t } from "./i18n-core";
export type { TranslationKey } from "./i18n-core";

const STORAGE_KEY = "cfkanban_locale";

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  return resolveLocalePreference(
    readStoredLocale(() => window.localStorage, STORAGE_KEY),
    window.navigator.languages,
  );
}

let browserLocale = initialLocale();
let accountLocaleActive = false;

export function applyAccountLocalePreference(saved: Locale | null | undefined, authenticated: boolean): void {
  accountLocaleActive = authenticated;
  setLocale(authenticated && (saved === "en" || saved === "zh-CN") ? saved : browserLocale);
}

locale.value = browserLocale;
watch(locale, (value) => {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.documentElement.lang = value;
  if (!accountLocaleActive) {
    browserLocale = value;
    writeStoredLocale(() => window.localStorage, STORAGE_KEY, value);
  }
}, { immediate: true, flush: "sync" });
