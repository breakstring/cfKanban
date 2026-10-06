<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import CopyForAgentButton from "./CopyForAgentButton.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { agentUpgradePrompt } from "../lib/agent-upgrade-prompt";
import { ApiProblem, apiRequest, hasUncertainWrite } from "../lib/api";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { notificationSessionKey } from "../lib/notifications";
import { canAccessOwnerControlPlane } from "../lib/session-capabilities";
import { registerNavigationGuard } from "../lib/router";
import type { WebSessionView, WriteResult } from "../types";

const props = defineProps<{ session: WebSessionView }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
interface AvailableRelease { version: string; url: string; published_at: string; newer_than_instance: boolean | null }
interface Channel { status: "fresh" | "stale" | "unavailable"; checked_at: string | null; last_attempt_at: string | null; retry_at: string | null; error: "rate_limited" | "query_failed" | null; releases: AvailableRelease[] }
interface Updates { current_version: string; stable: Channel; prereleases: Channel; prerelease_window: number }
interface Settings { enabled: boolean; version: number }
const settingsPath = "/api/v1/admin/upgrade-notification-settings";
const updates = ref<Updates | null>(null), settings = ref<Settings | null>(null);
const enabled = ref(false), busy = ref(false), loading = ref(false), saved = ref(false);
const uncertain = ref(false);
const selectedVersion = ref("stable");
let generation = 0;
let attempt: { enabled: boolean; expected_version: number } | null = null;
const removeGuard = registerNavigationGuard(() => !busy.value && !uncertain.value);
const beforeUnload = (event: BeforeUnloadEvent): void => {
  if (busy.value || uncertain.value) { event.preventDefault(); event.returnValue = ""; }
};
window.addEventListener("beforeunload", beforeUnload);
const { error, clearError, setError, setLocalizedError } = useLocalizedError();
const { error: settingsError, clearError: clearSettingsError, setError: setSettingsError } = useLocalizedError();
const canManage = computed(() => canAccessOwnerControlPlane(props.session));
const channels = computed(() => updates.value ? [
  { key: "stable", title: ui("Latest stable release", "最新正式版"), channel: updates.value.stable },
  { key: "prereleases", title: ui("Recent prereleases", "近期预发行版"), channel: updates.value.prereleases },
] : []);
const releaseOptions = computed(() => [
  { value: "stable", label: ui("Latest stable release", "最新正式版") },
  ...(updates.value?.prereleases.releases ?? []).map(release => ({
    value: release.version,
    label: `${release.version} · ${ui("Prerelease", "预发行版")}`,
  })),
]);
const selectedRelease = computed(() => releaseOptions.value.some(item => item.value === selectedVersion.value && item.value !== "stable")
  ? selectedVersion.value : null);
const upgradeInstruction = computed(() => agentUpgradePrompt(window.location.origin, selectedRelease.value, locale.value));
watch(releaseOptions, options => {
  if (!options.some(item => item.value === selectedVersion.value)) selectedVersion.value = "stable";
});
const time = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
function validSettings(value: unknown): value is Settings {
  const item = value as Settings;
  return !!item && typeof item.enabled === "boolean" && Number.isSafeInteger(item.version) && item.version > 0;
}
async function load(): Promise<void> {
  if (!canManage.value || loading.value || busy.value || uncertain.value) return;
  const current = generation;
  loading.value = true; saved.value = false; clearError(); clearSettingsError();
  await Promise.all([
    (async () => { try {
      const result = await apiRequest<Updates>("/api/v1/admin/release-updates", { authorizationCurrent: () => current === generation });
      if (current === generation) updates.value = result;
    } catch (caught) { if (current === generation) setError(caught); } })(),
    (async () => { try {
      const result = await apiRequest<Settings>(settingsPath, { validateResponse: validSettings, authorizationCurrent: () => current === generation });
      if (current === generation) { settings.value = result; enabled.value = result.enabled; }
    } catch (caught) { if (current === generation) setSettingsError(caught); } })(),
  ]);
  if (current === generation) loading.value = false;
}
async function save(): Promise<void> {
  if (!canManage.value || loading.value || busy.value || settings.value === null) return;
  const current = generation;
  attempt ??= { enabled: enabled.value, expected_version: settings.value.version };
  busy.value = true; saved.value = false; clearSettingsError();
  try {
    const result = await apiRequest<WriteResult<Settings>>(settingsPath, { method: "PATCH", body: attempt, idempotencyScope: `${props.session.session_id}:${props.session.principal.id}`,  authorizationCurrent: () => current === generation });
    if (current !== generation) return;
    settings.value = result.resource; enabled.value = result.resource.enabled;
    uncertain.value = false; attempt = null;
    const readback = await apiRequest<Settings>(settingsPath, { validateResponse: validSettings, authorizationCurrent: () => current === generation });
    if (current !== generation) return;
    settings.value = readback; enabled.value = readback.enabled;
    saved.value = readback.enabled === result.resource.enabled && readback.version >= result.resource.version;
    if (!saved.value) setLocalizedError("The setting changed again. Review the current value before saving.", "设置已再次变化，请核对当前值后再保存。");
  } catch (caught) {
    if (current !== generation) return;
    uncertain.value = hasUncertainWrite(settingsPath);
    if (!uncertain.value) attempt = null;
    setSettingsError(caught);
    if (caught instanceof ApiProblem && caught.status === 409 && !uncertain.value) {
      try {
        const result = await apiRequest<Settings>(settingsPath, { validateResponse: validSettings, authorizationCurrent: () => current === generation });
        if (current === generation) settings.value = result;
      } catch { /* Keep the original conflict visible. */ }
    }
  } finally { if (current === generation) busy.value = false; }
}
watch(() => `${notificationSessionKey(props.session)}:${canManage.value}`, () => {
  generation++; updates.value = null; settings.value = null; enabled.value = false;
  selectedVersion.value = "stable";
  busy.value = false; loading.value = false; uncertain.value = false; saved.value = false; attempt = null;
  void load();
}, { immediate: true });
onUnmounted(() => { generation++; removeGuard(); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <section v-if="canManage" class="version-updates-panel">
    <div class="section-heading-row">
      <h2>{{ ui("Versions & updates", "版本与更新") }}</h2>
      <UButton color="neutral" variant="outline" :disabled="loading || busy || uncertain" @click="load">{{ ui("Check again", "重新检查") }}</UButton>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="loading" role="status">{{ ui("Checking version information…", "正在检查版本信息…") }}</p>
    <template v-if="updates">
      <p>{{ ui("This instance is running", "当前实例运行版本") }} <strong class="mono">{{ updates.current_version }}</strong></p>
      <section v-for="entry in channels" :key="entry.key" class="version-channel">
        <h3>{{ entry.title }}</h3>
        <p v-if="entry.channel.status !== 'fresh'" role="status">{{ entry.channel.status === 'stale' ? ui("Cached information is out of date.", "缓存信息已过期。") : ui("Version information is unavailable.", "暂时无法获取版本信息。") }} {{ entry.channel.error === 'rate_limited' ? ui("GitHub rate limit reached.", "GitHub 查询已被限流。") : ui("GitHub could not be checked.", "GitHub 查询未成功。") }}</p>
        <p v-if="entry.channel.checked_at" class="muted">{{ ui("Last successful check:", "最近成功检查：") }} {{ time(entry.channel.checked_at) }}</p>
        <p v-if="entry.channel.last_attempt_at && entry.channel.status !== 'fresh'" class="muted">{{ ui("Last attempt:", "最近尝试：") }} {{ time(entry.channel.last_attempt_at) }}</p>
        <p v-if="entry.channel.retry_at" class="muted">{{ ui("Next check available:", "下次可检查时间：") }} {{ time(entry.channel.retry_at) }}</p>
        <ul v-if="entry.channel.releases.length" class="version-release-list">
          <li v-for="release in entry.channel.releases" :key="release.version">
            <a :href="release.url" target="_blank" rel="noopener noreferrer" class="mono">{{ release.version }}</a>
            <span>{{ release.newer_than_instance === null ? ui("Version comparison unavailable", "暂时无法比较版本") : release.newer_than_instance ? ui("Newer version available", "有较新版本可选") : ui("Not newer than this instance", "未高于当前实例版本") }}</span>
            <span class="muted">{{ time(release.published_at) }}</span>
          </li>
        </ul>
        <p v-else-if="entry.channel.status === 'fresh'">{{ ui("No release found in this channel.", "该范围内未发现发行版。") }}</p>
      </section>
      <p class="muted version-discovery-note">{{ ui("Up to 5 prereleases from GitHub's first releases page, inspecting at most 20 entries and ordered by publication time. Choose an exact version; compatibility is checked in the upgrade plan.", "从 GitHub 发行列表第一页最多检查 20 项，按发布时间展示最多 5 份预发行版。须明确选择准确版本，兼容性在升级计划中核验。") }}</p>
    </template>
    <section class="version-channel agent-upgrade-section" aria-labelledby="agent-upgrade-title">
      <h3 id="agent-upgrade-title">{{ ui("Ask your Agent to upgrade", "交给 Agent 升级") }}</h3>
      <p>{{ ui("Copy this prompt to your Agent to update your local plugin and online deployment.", "复制给 Agent，更新本地插件和线上部署。") }}</p>
      <div class="agent-upgrade-version">
        <label for="agent-upgrade-release">{{ ui("Target instance release", "实例目标版本") }}</label>
        <USelect id="agent-upgrade-release" v-model="selectedVersion" :items="releaseOptions" :disabled="loading" aria-describedby="agent-upgrade-version-help" />
        <p id="agent-upgrade-version-help" class="muted">{{ ui("Use the latest stable release, or choose an exact prerelease version.", "使用最新正式版，或选择准确的预发行版本。") }}</p>
      </div>
      <label for="agent-upgrade-prompt">{{ ui("Prompt for your Agent", "给 Agent 的提示") }}</label>
      <UTextarea id="agent-upgrade-prompt" class="agent-upgrade-prompt" :model-value="upgradeInstruction" :rows="3" autoresize :maxrows="6" readonly />
      <div class="agent-upgrade-actions">
        <CopyForAgentButton :text="upgradeInstruction" />
        <a :href="`/docs/${locale}/deployment/updates/`">{{ ui("Update and upgrade guide", "更新与升级指引") }}</a>
      </div>
    </section>
    <section class="version-channel">
      <h3>{{ ui("Notify users after upgrades", "升级后通知用户") }}</h3>
      <ErrorNotice v-if="settingsError" :error="settingsError" />
      <label v-if="settings" class="confirmation-check"><input v-model="enabled" type="checkbox" :disabled="loading || busy || uncertain">{{ ui("Automatically announce verified upgrades", "自动公告已确认成功的升级") }}</label>
      <p>{{ ui("Off by default. When enabled, a newer stable release or RC is announced only after a successful instance readback. Redeploys, rollbacks and local Skills updates do not announce. Personal reception preferences still apply.", "默认关闭。开启后，仅在较新正式版或 RC 升级成功并读回确认后公告。同版本重部署、回滚和本地技能更新不公告；继续尊重个人接收偏好。") }}</p>
      <UButton v-if="settings" :disabled="loading || busy || (!uncertain && enabled === settings.enabled)" @click="save">{{ uncertain ? ui("Recover original save", "恢复原保存请求") : ui("Save setting", "保存设置") }}</UButton>
      <p v-if="saved" role="status">{{ ui("Setting saved and verified.", "设置已保存并读回确认。") }}</p>
      <p v-if="uncertain" role="status">{{ ui("The save result is uncertain. Recover the same request before making another change.", "保存结果待核实，请先恢复原请求，再进行其他修改。") }}</p>
    </section>
  </section>
</template>

<style scoped>
.version-updates-panel { margin-top: 28px; }
.version-updates-panel .section-heading-row { margin-bottom: 14px; }
.version-updates-panel .version-channel { padding: 28px 0; }
.version-channel h3 { margin: 0 0 16px; }
.version-channel p { margin: 0 0 12px; }
.version-channel > :last-child { margin-bottom: 0; }
.version-discovery-note { margin: 20px 0 4px; }
.agent-upgrade-version { display: grid; gap: 8px; margin: 20px 0; }
.agent-upgrade-version > :deep(button) { width: min(100%, 420px); }
.agent-upgrade-section label { display: block; margin-bottom: 8px; font-weight: 600; }
.agent-upgrade-prompt { display: block; width: 100%; margin: 10px 0 16px; }
.agent-upgrade-prompt :deep(textarea) { font-family: var(--font-ui); line-height: 1.65; overflow-wrap: anywhere; }
.agent-upgrade-actions { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 16px 24px; }
.agent-upgrade-actions > a { display: inline-flex; align-items: center; min-height: 40px; }
@media (max-width: 600px) {
  .version-updates-panel { margin-top: 24px; }
  .version-updates-panel .version-channel { padding: 24px 0; }
  .agent-upgrade-actions > a { min-height: 44px; }
}
</style>
