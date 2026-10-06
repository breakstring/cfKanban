<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import ErrorNotice from "./ErrorNotice.vue";
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
      <p class="muted">{{ ui("Up to 5 prereleases from the 20 most recent GitHub releases. Prereleases require an explicit version choice. Compatibility is checked when preparing an upgrade plan.", "预发行版最多展示 GitHub 最近 20 份发行中的 5 份。预发行版须明确选择准确版本，兼容性在准备升级计划时核验。") }}</p>
    </template>
    <section class="version-channel">
      <h3>{{ ui("Update local Skills", "更新本地技能") }}</h3>
      <p>{{ ui("This site cannot read your local Skills version. Check the installed version locally, then update the Skills bundle and host plugin separately.", "站点无法读取本地技能版本。请先在本地核对安装版本，再独立更新技能包和宿主插件。") }}</p>
      <code>cfkanban --version</code>
      <p><a :href="`/docs/${locale}/deployment/updates/`">{{ ui("Local Skills update guide", "本地技能更新指引") }}</a></p>
    </section>
    <section class="version-channel">
      <h3>{{ ui("Upgrade this instance", "升级此实例") }}</h3>
      <p>{{ ui("Use cfkanban-deploy or the public CLI to select a verified immutable release and prepare a plan. Review the target and authorize that plan before applying it.", "使用 cfkanban-deploy 或公共 CLI 选择已校验的不可变发行并准备计划，核对目标并授权该计划后执行。") }}</p>
      <p><a :href="`/docs/${locale}/deployment/updates/`">{{ ui("Instance upgrade guide", "实例升级指引") }}</a></p>
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
