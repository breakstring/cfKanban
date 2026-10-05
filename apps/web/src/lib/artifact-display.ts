import type { Locale } from "../types";

const labels = {
  en: { path: "Path", url: "URL", commit: "Commit", other: "Other" },
  "zh-CN": { path: "路径", url: "链接", commit: "提交", other: "其他" },
} as const;

export function artifactKindLabel(kind: string, locale: Locale): string {
  return Object.hasOwn(labels[locale], kind)
    ? labels[locale][kind as keyof typeof labels.en]
    : kind;
}
