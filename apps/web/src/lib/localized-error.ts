import { computed, shallowRef, type ComputedRef } from "vue";

import type { Locale } from "../types";
import { errorText } from "./api";
import { locale, t, type TranslationKey } from "./i18n";

export interface LocalizedText {
  en: string;
  "zh-CN": string;
}

type ErrorPart =
  | { kind: "problem"; value: unknown }
  | { key: TranslationKey; kind: "translation" }
  | { kind: "localized"; value: LocalizedText };

export interface LocalizedErrorState {
  appendError: (value: unknown) => void;
  clearError: () => void;
  error: ComputedRef<string>;
  setError: (value: unknown) => void;
  setErrorKey: (key: TranslationKey) => void;
  setLocalizedError: (english: string, chinese: string) => void;
  setLocalizedTextError: (value: LocalizedText) => void;
}

export function localizedText(english: string, chinese: string): LocalizedText {
  return { en: english, "zh-CN": chinese };
}

export function resolveLocalizedText(value: string | LocalizedText, selectedLocale: Locale): string {
  return typeof value === "string" ? value : value[selectedLocale];
}

function renderPart(part: ErrorPart, selectedLocale: Locale): string {
  if (part.kind === "problem") return errorText(part.value);
  if (part.kind === "translation") return t(part.key);
  return resolveLocalizedText(part.value, selectedLocale);
}

export function useLocalizedError(): LocalizedErrorState {
  const parts = shallowRef<ErrorPart[]>([]);
  const error = computed(() => parts.value
    .map((part) => renderPart(part, locale.value))
    .filter(Boolean)
    .join(" "));

  return {
    appendError(value) {
      parts.value = [...parts.value, { kind: "problem", value }];
    },
    clearError() {
      parts.value = [];
    },
    error,
    setError(value) {
      parts.value = [{ kind: "problem", value }];
    },
    setErrorKey(key) {
      parts.value = [{ key, kind: "translation" }];
    },
    setLocalizedError(english, chinese) {
      parts.value = [{ kind: "localized", value: localizedText(english, chinese) }];
    },
    setLocalizedTextError(value) {
      parts.value = [{ kind: "localized", value }];
    },
  };
}
