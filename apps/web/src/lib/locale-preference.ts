export type SupportedLocale = "en" | "zh-CN";

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
