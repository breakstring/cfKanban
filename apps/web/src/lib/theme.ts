export type Theme = "orange" | "blue";

interface PrincipalTheme {
  id: string;
  version: number;
  theme?: Theme;
  locale?: "en" | "zh-CN" | null;
}

export function latestPrincipalTheme<T extends PrincipalTheme>(current: T | undefined, incoming: T): T {
  if (current?.id !== incoming.id) return incoming;
  // Session refreshes may have started before a profile save completed.
  if (current.version > incoming.version) return current;
  if ((incoming.theme !== undefined || current.theme === undefined)
    && (incoming.locale !== undefined || current.locale === undefined)) return incoming;
  return {
    ...incoming,
    ...(incoming.theme === undefined && current.theme !== undefined ? { theme: current.theme } : {}),
    ...(incoming.locale === undefined && current.locale !== undefined ? { locale: current.locale } : {}),
  };
}

export function normalizeTheme(value: unknown): Theme {
  return value === "blue" ? "blue" : "orange";
}

export function applyTheme(value: unknown, authenticated = true): void {
  document.documentElement.dataset.theme = normalizeTheme(value);
  document.documentElement.toggleAttribute("data-app-ui", authenticated);
}
