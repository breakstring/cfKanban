<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import type { WriteResult } from "../types";

interface UsageMetric {
  key: string;
  value: number | null;
  unit: "bytes" | "count";
  period_start: string | null;
  period_end: string | null;
  observed_at: string | null;
}
interface Usage {
  generated_at: string;
  attachments: { enabled: boolean; reserved_bytes: number; limit_bytes: number | null; limit_configured: boolean; settings_version: number };
  cloudflare: {
    status: "not_configured" | "pending" | "fresh" | "stale" | "error";
    refreshing: boolean;
    collected_at: string | null;
    attempted_at: string | null;
    error: string | null;
    metrics: UsageMetric[];
  };
}
interface AttachmentSettings { limit_bytes: number | null; configured: boolean; version: number; reserved_bytes: number }
const usage = ref<Usage | null>(null);
const editing = ref(false);
const saving = ref(false);
const settingsMode = ref<"" | "limited" | "unlimited">("");
const limitMiB = ref("");
const settingsVersion = ref(0);
const settingsError = ref<"" | "invalid" | "failed" | "conflict">("");
const settingsController = new AbortController();
function editSettings(): void {
  const current = usage.value?.attachments;
  if (!current) return;
  settingsMode.value = !current.limit_configured ? "" : current.limit_bytes === null ? "unlimited" : "limited";
  limitMiB.value = current.limit_bytes === null ? "" : String(current.limit_bytes / 1048576);
  settingsVersion.value = current.settings_version;
  settingsError.value = "";
  editing.value = true;
}
function applySettings(value: AttachmentSettings): void {
  if (!usage.value) return;
  Object.assign(usage.value.attachments, { limit_bytes: value.limit_bytes, limit_configured: value.configured, settings_version: value.version, reserved_bytes: value.reserved_bytes });
  settingsVersion.value = value.version;
}
async function reloadSettings(): Promise<void> {
  saving.value = true;
  try {
    const result = await apiRequest<AttachmentSettings>("/api/v1/admin/attachment-settings", { signal: settingsController.signal });
    if (disposed) return;
    applySettings(result);
    settingsError.value = "";
  } catch { if (!disposed) settingsError.value = "failed"; }
  finally { if (!disposed) saving.value = false; }
}
async function saveSettings(): Promise<void> {
  if (saving.value || settingsError.value === "conflict") return;
  const value = settingsMode.value === "unlimited" ? null : Number(limitMiB.value) * 1048576;
  if (!settingsMode.value || (value !== null && (!Number.isSafeInteger(value) || value <= 0))) {
    settingsError.value = "invalid";
    return;
  }
  saving.value = true;
  settingsError.value = "";
  try {
    const result = await apiRequest<WriteResult<AttachmentSettings>>("/api/v1/admin/attachment-settings", {
      method: "PATCH", body: { expected_version: settingsVersion.value, limit_bytes: value }, signal: settingsController.signal,
    });
    if (disposed) return;
    applySettings(result.resource);
    editing.value = false;
  } catch (error) {
    if (!disposed) settingsError.value = error instanceof ApiProblem && error.status === 409 ? "conflict" : "failed";
  } finally { if (!disposed) saving.value = false; }
}
const loading = ref(false);
const failed = ref(false);
let controller: AbortController | null = null;
let generation = 0;
let disposed = false;
function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }
const metricNames = computed(() => ({
  d1_storage_bytes: ui("D1 storage", "D1 存储容量"),
  d1_rows_read: ui("D1 rows read today", "D1 当日读取行数"),
  d1_rows_written: ui("D1 rows written today", "D1 当日写入行数"),
  r2_storage_bytes: ui("R2 storage", "R2 存储容量"),
  r2_objects: ui("R2 objects", "R2 对象数"),
  r2_operations: ui("R2 operations today", "R2 当日操作量"),
}));
const statusText = computed(() => usage.value?.cloudflare.refreshing ? ui("Updating…", "更新中…") : ({
  not_configured: ui("Not configured", "未配置"),
  pending: ui("Waiting for first snapshot", "等待首次采集"),
  fresh: ui("Snapshot available", "快照可用"),
  stale: ui("Stale snapshot", "快照已过期"),
  error: ui("Collection unavailable", "采集不可用"),
}[usage.value?.cloudflare.status ?? "not_configured"]));
const capacityReached = computed(() => {
  const attachment = usage.value?.attachments;
  return attachment?.limit_configured === true && attachment.limit_bytes !== null
    && attachment.reserved_bytes >= attachment.limit_bytes;
});
const percent = computed(() => usage.value && usage.value.attachments.limit_bytes !== null && usage.value.attachments.limit_bytes > 0
  ? usage.value.attachments.reserved_bytes / usage.value.attachments.limit_bytes * 100 : 0);
function number(value: number): string { return new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(value); }
function bytes(value: number): string {
  const index = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${number(value / 1024 ** index)} ${["B", "KiB", "MiB", "GiB"][index]}`;
}
function time(value: string | null): string {
  return value ? new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : ui("Unknown", "未知");
}
function shortTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const today = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(locale.value, {
    ...(today ? {} : { month: "short", day: "numeric" } as const),
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}
function needsCollection(value: Usage): boolean {
  const cloud = value.cloudflare;
  if (cloud.status === "not_configured" || cloud.refreshing) return false;
  return cloud.collected_at === null || cloud.error !== null || cloud.status === "stale" || cloud.status === "error" || cloud.status === "pending"
    || Date.parse(value.generated_at) - Date.parse(cloud.collected_at) >= 15 * 60 * 1000;
}
async function refresh(mode: "open" | "manual" = "manual"): Promise<void> {
  const request = ++generation;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  failed.value = false;
  try {
    const signal = controller.signal;
    const result = mode === "open"
      ? await apiRequest<Usage>("/api/v1/admin/usage", { signal })
      : await apiRequest<Usage>("/api/v1/admin/usage/refresh", { method: "POST", body: { mode: "manual" }, signal });
    if (disposed || request !== generation) return;
    usage.value = result;
    if (mode === "open" && needsCollection(result)) {
      const updated = await apiRequest<Usage>("/api/v1/admin/usage/refresh", { method: "POST", body: { mode: "stale" }, signal });
      if (!disposed && request === generation) usage.value = updated;
    }
  } catch (error) {
    if (!disposed && request === generation) {
      failed.value = true;
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) usage.value = null;
    }
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}
onMounted(() => refresh("open"));
onUnmounted(() => { disposed = true; generation++; controller?.abort(); settingsController.abort(); });
</script>

<template>
  <section class="owner-section usage-panel" aria-labelledby="usage-heading" :aria-busy="loading">
    <div class="section-heading-row">
      <div><h2 id="usage-heading">{{ ui('Usage & limits', '用量与限额') }}</h2><p>{{ ui('Application budget and Cloudflare statistics for this instance.', '本实例的应用预算与 Cloudflare 统计。') }}</p></div>
      <button class="secondary-button" type="button" :disabled="loading || saving" @click="refresh()">{{ loading ? ui('Loading…', '正在读取…') : ui('Refresh usage', '刷新用量') }}</button>
    </div>
    <p v-if="failed" class="warning-panel" role="alert">{{ usage ? ui('Refresh failed. Displayed values are from the previous snapshot and may be out of date.', '刷新失败。下方保留上次快照，数据可能已过期。') : ui('Usage is unavailable. Try refreshing usage.', '暂时无法读取用量，请刷新用量重试。') }}</p>
    <template v-if="usage">
      <div class="usage-cloud-heading"><h3>{{ ui('Attachment application budget', '附件应用预算') }}</h3><button v-if="!editing" class="text-button" type="button" :disabled="loading" @click="editSettings">{{ ui('Set limit', '设置上限') }}</button></div>
      <p>{{ bytes(usage.attachments.reserved_bytes) }} / {{ !usage.attachments.limit_configured ? ui('Not set', '未设置') : usage.attachments.limit_bytes === null ? ui('Unlimited', '不限制') : bytes(usage.attachments.limit_bytes) }}<template v-if="usage.attachments.limit_configured && usage.attachments.limit_bytes !== null"> · {{ number(percent) }}%</template> · {{ usage.attachments.enabled ? ui('Attachments enabled', '附件已启用') : ui('Attachments disabled', '附件未启用') }}</p>
      <meter v-if="usage.attachments.limit_configured && usage.attachments.limit_bytes !== null && usage.attachments.limit_bytes > 0" :class="{ 'capacity-reached': capacityReached }" min="0" :high="usage.attachments.limit_bytes * 0.9" :optimum="0" :max="usage.attachments.limit_bytes" :value="usage.attachments.reserved_bytes" :aria-label="ui('Reserved attachment budget', '附件预留预算')" />
      <p v-if="capacityReached" class="warning-panel" role="status">{{ ui('Storage limit reached. New uploads are paused; existing attachments remain accessible. Raise the limit or wait for reclamation to free space.', '已达到容量上限，新增上传已暂停；已有附件仍可访问。可提高上限或等待回收释放容量。') }}</p>
      <p v-if="!usage.attachments.limit_configured" class="warning-panel">{{ ui('Choose a storage limit or explicitly select unlimited before uploading new files.', '请先设置存储上限或明确选择不限制，再上传新文件。') }}</p>
      <form v-if="editing" class="usage-settings" @submit.prevent="saveSettings">
        <label>{{ ui('Storage limit', '存储上限') }}<select v-model="settingsMode" :disabled="saving"><option value="" disabled>{{ ui('Choose…', '请选择…') }}</option><option value="limited">{{ ui('Set a limit', '设置容量上限') }}</option><option value="unlimited">{{ ui('Unlimited', '不限制') }}</option></select></label>
        <label v-if="settingsMode === 'limited'">{{ ui('Capacity (MiB)', '容量（MiB）') }}<input v-model="limitMiB" type="number" min="0.00000095367431640625" step="any" :disabled="saving" required /></label>
        <p class="muted-copy">{{ ui('1 GiB = 1024 MiB. Lowering the limit keeps existing files and blocks new uploads above the limit. Unlimited has no application budget cap and may incur R2 charges.', '1 GiB = 1024 MiB。调低上限不删除已有文件，超出时仅阻止新上传。不限制表示没有应用容量上限，仍可能产生 R2 费用。') }}</p>
        <p v-if="settingsError" role="alert" class="warning-panel">{{ settingsError === 'invalid' ? ui('Choose a mode and enter a positive capacity precise to whole bytes.', '请选择模式，并输入可精确换算为整数字节的正容量。') : settingsError === 'conflict' ? ui('Settings changed elsewhere. Refresh settings, review the current budget, then save your retained draft.', '设置已被其他操作修改。请刷新设置并核对当前预算，再保存保留的草稿。') : ui('Could not save or read settings. Your draft is retained; try again.', '保存或读取设置失败，草稿已保留，请重试。') }}</p>
        <div class="usage-setting-actions"><button v-if="settingsError === 'conflict'" class="secondary-button" type="button" :disabled="saving" @click="reloadSettings">{{ ui('Refresh settings', '刷新设置') }}</button><button class="secondary-button" type="submit" :disabled="saving || settingsError === 'conflict'">{{ saving ? ui('Saving…', '正在保存…') : ui('Save', '保存') }}</button><button class="text-button" type="button" :disabled="saving" @click="editing = false">{{ ui('Cancel', '取消') }}</button></div>
      </form>
      <p class="muted-copy">{{ ui('Reserved until files are reclaimed, including uploads and deleted files. Not actual R2 storage or a billing cap.', '含上传中和已删除文件，回收后释放；不等于 R2 实际容量或账单上限。') }}</p>
      <div class="usage-cloud-heading"><h3>{{ ui('Cloudflare instance statistics', 'Cloudflare 实例统计') }}</h3><span role="status">{{ statusText }}</span><span v-if="usage.cloudflare.collected_at && usage.cloudflare.status !== 'not_configured'">{{ ui('Updated', '更新于') }} {{ shortTime(usage.cloudflare.collected_at) }}</span></div>
      <p v-if="usage.cloudflare.status === 'not_configured'" class="muted-copy">{{ ui('Analytics credentials or resource settings are missing, or collection is disabled. Ask your deployment Agent to prepare a read-only analytics configuration.', '统计凭据或资源设置尚未配置，或采集已关闭。可请部署 Agent 准备只读统计配置方案。') }}</p>
      <template v-else>
        <p v-if="usage.cloudflare.refreshing" class="muted-copy" role="status">{{ ui('Collection is in progress. Refresh usage later to read the result.', '正在采集中，请稍后手动刷新用量查看结果。') }}</p>
        <p v-if="!usage.cloudflare.refreshing && (usage.cloudflare.status === 'stale' || usage.cloudflare.error)" class="warning-panel">{{ ui('Collection failed or the snapshot is older than fifteen minutes. Available values are retained; unknown values are not zero.', '采集失败或快照已超过十五分钟。保留已有数据；未知值不代表零。') }}</p>
        <dl class="usage-metrics">
          <div v-for="(label, key) in metricNames" :key="key">
            <dt>{{ label }}</dt>
            <dd v-for="metric in [usage.cloudflare.metrics.find(item => item.key === key)]" :key="key">
              <strong>{{ metric?.value == null ? ui('Unknown', '未知') : metric.unit === 'bytes' ? bytes(metric.value) : number(metric.value) }}</strong>
            </dd>
          </div>
        </dl>
      </template>
      <p class="muted-copy usage-note">{{ ui('Daily totals use UTC; storage uses the latest available observation and may be delayed.', '今日按 UTC 统计；容量为最近可用观测，可能延迟。') }}</p>
      <p class="muted-copy usage-note">{{ ui('Web and Skill share a 15-minute cache · 60-second cooldown · No background polling', '页面与技能共用 15 分钟缓存 · 冷却 60 秒 · 无后台轮询') }}</p>
      <details class="usage-details">
        <summary>{{ ui('Data details', '数据详情') }}</summary>
        <p class="muted-copy">{{ ui('Budget read at', '预算读取于') }}: {{ time(usage.generated_at) }}</p>
        <template v-if="usage.cloudflare.status !== 'not_configured'">
          <p class="muted-copy">{{ ui('Last successful collection', '上次成功采集') }}: {{ time(usage.cloudflare.collected_at) }}<br />{{ ui('Last attempt', '上次尝试') }}: {{ time(usage.cloudflare.attempted_at) }}</p>
          <dl class="usage-windows">
            <div v-for="(label, key) in metricNames" :key="key">
              <dt>{{ label }}</dt>
              <dd v-for="metric in [usage.cloudflare.metrics.find(item => item.key === key)]" :key="key">
                <span v-if="metric?.period_start && metric.period_end">{{ ui('Window', '统计窗口') }}: {{ time(metric.period_start) }} — {{ time(metric.period_end) }}<br /></span>
                {{ ui('Observed', '观测时间') }}: {{ time(metric?.observed_at ?? null) }}
              </dd>
            </div>
          </dl>
        </template>
        <p class="muted-copy">{{ ui('Daily totals start at 00:00 UTC. Storage and object counts use the latest available observation within 24 hours, excluding the current hour.', '日累计量从 UTC 当日 00:00 起算。容量与对象数采用最近 24 小时内最近一次可用观测，不包含当前小时。') }}</p>
        <p class="muted-copy">{{ ui('Instance usage does not represent account-wide usage or remaining allowances. Project active quotas remain in each project’s Public Join settings.', '本实例用量不代表账户总用量或剩余额度。项目配额仍在各项目的公开加入设置中查看。') }}</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.usage-settings { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 12px 0; }
.usage-settings label { display: grid; gap: 4px; }
.usage-settings p { flex-basis: 100%; margin: 0; }
.usage-setting-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.usage-panel h3 { margin: 24px 0 8px; font-size: 16px; }
.usage-panel meter { width: min(100%, 480px); height: 16px; accent-color: var(--color-primary); }
.usage-panel meter.capacity-reached { accent-color: var(--color-warning); }
.usage-panel meter.capacity-reached::-webkit-meter-optimum-value { background: var(--color-warning); }
.usage-panel meter.capacity-reached::-webkit-meter-suboptimum-value { background: var(--color-warning); }
.usage-panel meter.capacity-reached::-moz-meter-bar { background: var(--color-warning); }
.usage-cloud-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
.usage-cloud-heading span { color: var(--color-text-muted); font-size: 13px; }
.usage-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 24px; margin: 8px 0 16px; }
.usage-metrics > div { padding: 16px 0; border-bottom: 1px solid var(--color-border); }
.usage-metrics dt { color: var(--color-text-muted); font-size: 13px; }
.usage-metrics dd { margin: 8px 0 0; font-size: 22px; font-variant-numeric: tabular-nums; }
.usage-note { margin: 4px 0; }
.usage-details { margin-top: 16px; }
.usage-details summary { cursor: pointer; color: var(--color-text-muted); }
.usage-windows > div { padding: 8px 0; border-bottom: 1px solid var(--color-border); }
.usage-windows dd { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 600px) { .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; } }
</style>
