import type { Locale } from "../types";

export function agentUpgradePrompt(origin: string, version: string | null, locale: Locale): string {
  const target = version ?? (locale === "zh-CN" ? "最新正式版" : "the latest stable release");
  if (locale === "zh-CN") {
    return `请以 ${target} 为目标版本，使用 cfkanban-deploy 技能将本地 cfKanban 插件和 ${origin} 的线上部署都升级到该版本。`;
  }
  return `With ${target} as the target version, use the cfkanban-deploy skill to upgrade both my local cfKanban plugin and the deployment at ${origin} to that version.`;
}
