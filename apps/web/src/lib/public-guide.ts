import type { Locale } from "../types";

export type PublicGuide = "deploy-guide" | "join";

export function publicGuideUrl(origin: string, guide: PublicGuide, locale: Locale): string {
  const localizedSuffix = locale === "zh-CN" ? ".zh-CN" : "";
  return new URL(`/${guide}${localizedSuffix}.md`, origin).href;
}

export function deployAgentInstruction(origin: string, locale: Locale): string {
  const guideUrl = publicGuideUrl(origin, "deploy-guide", locale);
  return locale === "zh-CN"
    ? `请阅读 ${guideUrl}，按里面的步骤帮我安装或更新 cfKanban 技能，并部署一个新实例。`
    : `Read ${guideUrl}, then follow it to install or update the cfKanban Skills and deploy a new instance for me.`;
}

export function publicJoinInstruction(
  origin: string,
  publicId: string,
  role: "reader" | "writer",
  locale: Locale,
): string {
  const guideUrl = publicGuideUrl(origin, "join", locale);
  return locale === "zh-CN"
    ? `请阅读 ${guideUrl}，并按其中步骤使用 cfKanban 技能加入：实例 ${origin}，公开加入 ID ${publicId}，角色 ${role}。`
    : `Read ${guideUrl}, then follow it with the cfKanban Skill to join instance ${origin}, Public Join ID ${publicId}, as ${role}.`;
}
