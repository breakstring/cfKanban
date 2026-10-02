import { watch } from "vue";

import type { Locale } from "../types";
import { locale } from "./i18n-core";
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

locale.value = initialLocale();
watch(locale, (value) => {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.documentElement.lang = value;
  writeStoredLocale(() => window.localStorage, STORAGE_KEY, value);
}, { immediate: true });
