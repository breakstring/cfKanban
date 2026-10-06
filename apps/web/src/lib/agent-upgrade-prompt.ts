import type { Locale } from "../types";

export function agentUpgradePrompt(origin: string, version: string | null, locale: Locale): string {
  const guide = new URL(`/docs/${locale}/deployment/updates/`, origin).href;
  if (locale === "zh-CN") {
    return [
      `请按 ${guide} 更新现有 cfKanban 实例 ${origin}。先核对本机已有的 cfKanban 技能包和宿主插件，展示目标版本和本地更新计划，等我确认后更新。`,
      `随后核对实例当前版本。${version ? `我选择的准确实例目标是 ${version}。` : "先检查可用版本并让我选择准确目标，不默认选择预发行版。"}请校验不可变工件与兼容性，展示实例升级计划及影响，等我明确确认后执行并读回结果。`,
      "保留现有 Owner 身份、凭据、绑定和资源；环境或归属无法核实时，先说明缺项，不转入首次安装、身份迁移或新实例部署。",
    ].join("\n\n");
  }
  return [
    `Use ${guide} to update my existing cfKanban instance at ${origin}. First check the locally installed cfKanban Skills bundle and host plugin; show their target versions and local update plan, then wait for my confirmation before updating them.`,
    `Then check the instance's current version. ${version ? `My exact instance target is ${version}.` : "Check available versions and let me choose an exact target; do not default to a prerelease."} Verify immutable artifacts and compatibility, show the instance upgrade plan and impact, then wait for my explicit confirmation before applying it and reading back the result.`,
    "Preserve the existing Owner identity, credentials, binding, and resources. If the setup or ownership cannot be verified, explain what is missing; do not start a first-time installation, identity migration, or new instance deployment.",
  ].join("\n\n");
}
