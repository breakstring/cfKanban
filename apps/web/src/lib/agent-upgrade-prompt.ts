import type { Locale } from "../types";

export function agentUpgradePrompt(origin: string, version: string | null, locale: Locale): string {
  if (locale === "zh-CN") {
    return `请使用 cfkanban-deploy 技能，先更新本地 cfKanban 插件，再将 ${origin} 的线上部署升级到${version ?? "最新正式版"}。`;
  }
  return `Use the cfkanban-deploy skill to update my local cfKanban plugin, then upgrade the deployment at ${origin} to ${version ?? "the latest stable release"}.`;
}
