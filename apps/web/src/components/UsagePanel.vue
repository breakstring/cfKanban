<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import type { WriteResult } from "../types";

const props = withDefaults(defineProps<{ summary?: boolean; observedOrigin?: string; refreshGeneration?: number }>(), { summary: false, refreshGeneration: 0 });
const emit = defineEmits<{ details: []; settings: [field: "analytics_enabled" | "billing_plan" | "billing_cycle_day" | "account_totals"] }>();

interface UsageMetric {
  key: string;
  value: number | null;
  unit: "bytes" | "count" | "microseconds";
  scope?: "instance" | "account";
  period_start: string | null;
  period_end: string | null;
  observed_at: string | null;
}
interface UsageBilling {
  plan: "free" | "paid" | "unknown";
  cycle_day: number | null;
  period_start: string | null;
  period_end: string | null;
  account_totals_enabled: boolean;
  r2_standard_only_scope?: "unknown" | "instance" | "account";
  allowances_shared: true;
  analytics_not_invoice: true;
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
    billing?: UsageBilling;
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
async function reloadSettings(): Promise<boolean> {
  saving.value = true;
  try {
    const result = await apiRequest<AttachmentSettings>("/api/v1/admin/attachment-settings", { signal: settingsController.signal });
    if (disposed) return false;
    applySettings(result);
    settingsError.value = "";
    return true;
  } catch { if (!disposed) settingsError.value = "failed"; return false; }
  finally { if (!disposed) saving.value = false; }
}
async function saveSettings(): Promise<void> {
  if (saving.value) return;
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
    if (!disposed) {
      if (error instanceof ApiProblem && error.status === 409) {
        const refreshed = await reloadSettings();
        if (!disposed && refreshed) settingsError.value = "conflict";
      } else settingsError.value = "failed";
    }
  } finally { if (!disposed) saving.value = false; }
}
const loading = ref(false);
const failed = ref(false);
let controller: AbortController | null = null;
let generation = 0;
let disposed = false;
function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }
const metricNames = computed<Record<string, string>>(() => ({
  d1_storage_bytes: ui("D1 storage", "D1 存储容量"),
  d1_rows_read: ui("D1 rows read today", "D1 当日读取行数"),
  d1_rows_written: ui("D1 rows written today", "D1 当日写入行数"),
  r2_storage_bytes: ui("R2 storage", "R2 存储容量"),
  r2_objects: ui("R2 objects", "R2 对象数"),
  r2_operations: ui("R2 operations today", "R2 当日操作量"),
  workers_daily_requests: ui("Requests", "请求次数"),
  workers_daily_cpu_microseconds: ui("CPU time", "CPU 用时"),
  r2_daily_class_a_operations: ui("Class A operations", "Class A 操作量"),
  r2_daily_class_b_operations: ui("Class B operations", "Class B 操作量"),
  r2_daily_unclassified_operations: ui("Unclassified operations", "未分类操作量"),
  workers_requests: ui("Workers requests", "Workers 请求量"),
  workers_cpu_microseconds: ui("Workers cumulative CPU", "Workers 累计 CPU"),
  r2_class_a_operations: ui("R2 Class A operations", "R2 Class A 操作量"),
  r2_class_b_operations: ui("R2 Class B operations", "R2 Class B 操作量"),
  r2_unclassified_operations: ui("R2 unclassified operations", "R2 未分类操作量"),
  d1_billing_rows_read: ui("D1 rows read in billing period", "D1 账单周期读取行数"),
  d1_billing_rows_written: ui("D1 rows written in billing period", "D1 账单周期写入行数"),
}));
const scope = ref<"instance" | "account">("instance");
const accountAvailable = computed(() => Boolean(usage.value?.cloudflare.billing?.account_totals_enabled));
const currentScopeMetrics = computed(() => usage.value?.cloudflare.metrics.filter(metric => (metric.scope ?? "instance") === scope.value) ?? []);
function isToday(metric: UsageMetric): boolean {
  const day = usage.value?.generated_at.slice(0, 10);
  if (!day || !metric.period_start || !metric.period_end) return false;
  const start = Date.parse(`${day}T00:00:00Z`);
  return Date.parse(metric.period_start) === start && Date.parse(metric.period_end) > start && Date.parse(metric.period_end) <= start + 86_400_000;
}
function validUnit(metric: UsageMetric): boolean {
  return metric.unit === (metric.key.endsWith("_storage_bytes") ? "bytes" : metric.key.endsWith("_cpu_microseconds") ? "microseconds" : "count");
}
const resourceGroups = computed(() => [
  { key: "workers", label: "Workers", keys: ["workers_daily_requests", "workers_daily_cpu_microseconds"] },
  { key: "d1", label: "D1", keys: ["d1_rows_read", "d1_rows_written"] },
  { key: "r2", label: "R2", keys: ["r2_daily_class_a_operations", "r2_daily_class_b_operations", "r2_operations"] },
].map(group => ({ ...group, entries: group.keys.map(key => {
  const legacy = key.replace("_daily_", "_");
  const metric = currentScopeMetrics.value.find(item => item.key === key && validUnit(item) && isToday(item))
    ?? currentScopeMetrics.value.find(item => item.key === legacy && validUnit(item) && isToday(item));
  return { key, label: metricNames.value[key] ?? key, metric };
}) })).filter(group => group.key !== "r2" || usage.value?.attachments.enabled || currentScopeMetrics.value.some(item => item.key.startsWith("r2_") && item.value !== null)));
const storageMetrics = computed(() => ["d1_storage_bytes", "r2_storage_bytes", "r2_objects"].map(key => ({
  key, label: metricNames.value[key] ?? key, metric: currentScopeMetrics.value.find(item => item.key === key && validUnit(item)),
})).filter(entry => !entry.key.startsWith("r2_") || usage.value?.attachments.enabled || entry.metric?.value != null));
const billingMetrics = computed(() => {
  const billing = usage.value?.cloudflare.billing;
  if (!billing?.cycle_day || !billing.period_start || !billing.period_end) return [];
  const start = Date.parse(billing.period_start), end = Date.parse(billing.period_end);
  return currentScopeMetrics.value.filter(metric => ["workers_requests", "workers_cpu_microseconds", "r2_class_a_operations", "r2_class_b_operations", "r2_unclassified_operations", "d1_billing_rows_read", "d1_billing_rows_written"].includes(metric.key)
    && validUnit(metric) && (!metric.key.startsWith("workers_") || billing.plan === "paid")
    && Date.parse(metric.period_start ?? "") === start && Date.parse(metric.period_end ?? "") > start && Date.parse(metric.period_end ?? "") <= end);
});
const summaryMetrics = computed(() => ["d1_storage_bytes", "d1_rows_read", "r2_storage_bytes"].map(key => ({
  key, label: metricNames.value[key] ?? key,
  metric: usage.value?.cloudflare.status === "not_configured" ? undefined : usage.value?.cloudflare.metrics.find(metric => metric.key === key && validUnit(metric) && (key !== "d1_rows_read" || isToday(metric)) && (metric.scope ?? "instance") === "instance"),
})));
function metricValue(metric: UsageMetric | undefined): string {
  if (metric?.value == null) return ui("Unavailable", "暂无数据");
  return metric.unit === "bytes" ? bytes(metric.value) : `${number(metric.value)}${metric.unit === "microseconds" ? " µs" : ""}`;
}
const statusText = computed(() => usage.value?.cloudflare.refreshing ? ui("Updating…", "更新中…") : ({
  not_configured: ui("Not configured", "未配置"),
  pending: ui("Preparing usage data", "正在准备数据"),
  fresh: ui("Up to date", "已更新"),
  stale: ui("Showing earlier data", "显示上次数据"),
  error: ui("Temporarily unavailable", "暂时不可用"),
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
function snapshotExpired(value: Usage): boolean {
  const collectedAt = value.cloudflare.collected_at ? Date.parse(value.cloudflare.collected_at) : NaN;
  return !Number.isFinite(collectedAt) || Date.now() - collectedAt >= 15 * 60 * 1000;
}
let readbackTimer: ReturnType<typeof setTimeout> | null = null;
let lastFocusRead = 0;
function clearReadback(): void { if (readbackTimer) clearTimeout(readbackTimer); readbackTimer = null; }
function scheduleReadback(request: number, attempt = 0): void {
  if (disposed || request !== generation || attempt >= 3) return;
  clearReadback();
  readbackTimer = setTimeout(async () => {
    try {
      const result = await apiRequest<Usage>("/api/v1/admin/usage", controller ? { signal: controller.signal } : {});
      if (disposed || request !== generation) return;
      usage.value = result; failed.value = false;
      if (result.cloudflare.refreshing) scheduleReadback(request, attempt + 1);
    } catch (error) {
      if (disposed || request !== generation) return;
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) { usage.value = null; failed.value = true; }
      else scheduleReadback(request, attempt + 1);
    }
  }, [1000, 3000, 5000][attempt]);
}
async function refresh(): Promise<void> {
  const request = ++generation;
  clearReadback();
  lastFocusRead = Date.now();
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  failed.value = false;
  try {
    const signal = controller.signal;
    const result = await apiRequest<Usage>("/api/v1/admin/usage", { signal });
    if (disposed || request !== generation) return;
    usage.value = result;
    if (needsCollection(result)) {
      const updated = await apiRequest<Usage>("/api/v1/admin/usage/refresh", { method: "POST", body: { mode: "stale" }, signal });
      if (!disposed && request === generation) usage.value = updated;
    }
    if (usage.value?.cloudflare.refreshing) scheduleReadback(request);
  } catch (error) {
    if (!disposed && request === generation) {
      failed.value = true;
      if (usage.value?.cloudflare.status === "fresh") usage.value.cloudflare.status = "stale";
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) usage.value = null;
      else scheduleReadback(request);
    }
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}
watch(() => props.summary, (summary, previousSummary) => {
  if (summary || !previousSummary || loading.value) return;
  const current = usage.value;
  // API 状态对应读取时刻；概览可能已经停留很久。
  if (current?.cloudflare.status === "fresh" && (failed.value || snapshotExpired(current))) current.cloudflare.status = "stale";
  if (failed.value || current === null || needsCollection(current)) void refresh();
});
watch(() => props.refreshGeneration, () => { void refresh(); });
function onFocus(): void {
  if (!loading.value && Date.now() - lastFocusRead >= 60_000) void refresh();
}
watch(accountAvailable, available => { if (!available) scope.value = "instance"; });
onMounted(() => { void refresh(); if (typeof window !== "undefined") window.addEventListener("focus", onFocus); });
onUnmounted(() => { disposed = true; generation++; clearReadback(); controller?.abort(); settingsController.abort(); if (typeof window !== "undefined") window.removeEventListener("focus", onFocus); });
</script>

<template>
  <section class="owner-section usage-panel" aria-labelledby="usage-heading" :aria-busy="loading">
    <div class="section-heading-row">
      <div><h2 id="usage-heading">{{ summary ? ui('Usage & quotas', '用量与配额') : ui('Today’s usage', '当日用量') }}</h2><p class="muted-copy">{{ summary ? ui('A quick view of this instance.', '当前实例的用量概况。') : ui('UTC day · Statistics may be delayed', '按 UTC 日统计 · 数据可能延迟') }}</p></div>
      <UButton v-if="summary" color="neutral" variant="outline" type="button" @click="emit('details')">{{ ui('View usage', '查看用量') }}</UButton>
      <label v-else-if="accountAvailable" class="usage-scope">{{ ui('Scope', '统计范围') }}<USelect v-model="scope" :items="[{value:'instance',label:ui('This instance','本实例')},{value:'account',label:ui('Whole account','整个账户')}]" /></label>
    </div>
    <p v-if="failed" class="warning-panel" role="status">{{ usage ? ui('The latest data is temporarily unavailable. Earlier values are kept.', '暂时无法取得最新数据，已保留上次结果。') : ui('Usage data is temporarily unavailable. We will try again automatically.', '暂时无法读取用量，系统会自动重试。') }}</p>
    <p v-if="!usage && loading" class="muted-copy" role="status">{{ ui('Loading usage…', '正在加载用量…') }}</p>
    <template v-if="usage">
      <p class="usage-update muted-copy" role="status">{{ statusText }}<template v-if="usage.cloudflare.collected_at && usage.cloudflare.status !== 'not_configured'"> · {{ shortTime(usage.cloudflare.collected_at) }}</template></p>
      <dl v-if="summary" class="usage-metrics usage-summary-metrics">
        <div><dt>{{ ui('Attachment storage', '附件占用空间') }}</dt><dd><strong>{{ bytes(usage.attachments.reserved_bytes) }}</strong></dd></div>
        <div v-for="entry in summaryMetrics" :key="entry.key"><dt>{{ entry.label }}</dt><dd><strong>{{ metricValue(entry.metric) }}</strong></dd></div>
      </dl>
      <template v-else>
        <p v-if="usage.cloudflare.status === 'not_configured'" class="usage-empty">{{ ui('Connect Cloudflare above to see usage. If collection is turned off, enable it in statistics settings.', '在上方连接 Cloudflare 后即可查看用量；如果已关闭采集，可在统计设置中启用。') }}</p>
        <template v-else>
          <div class="usage-resources">
            <section v-for="group in resourceGroups" :key="group.key" class="usage-resource" :aria-label="group.label">
              <h3>{{ group.label }}</h3>
              <dl class="usage-metrics"><div v-for="entry in group.entries" :key="entry.key"><dt>{{ entry.label }}</dt><dd><strong>{{ metricValue(entry.metric) }}</strong></dd></div></dl>
            </section>
          </div>
          <div class="usage-storage"><h3>{{ ui('Current storage', '当前存储') }}</h3><dl class="usage-metrics"><div v-for="entry in storageMetrics" :key="entry.key"><dt>{{ entry.label }}</dt><dd><strong>{{ metricValue(entry.metric) }}</strong></dd></div></dl></div>
        </template>
        <details class="usage-details">
          <summary>{{ ui('Statistics settings & data details', '统计设置与数据详情') }}</summary>
          <div class="usage-preferences">
            <UButton color="neutral" variant="outline" type="button" @click="emit('settings', 'analytics_enabled')">{{ ui('Usage collection', '用量采集') }}</UButton>
            <UButton color="neutral" variant="outline" type="button" @click="emit('settings', 'account_totals')">{{ ui('Account totals', '账户汇总') }}</UButton>
            <UButton color="neutral" variant="outline" type="button" @click="emit('settings', 'billing_plan')">{{ ui('Cloudflare plan', 'Cloudflare 方案') }}</UButton>
            <UButton color="neutral" variant="outline" type="button" @click="emit('settings', 'billing_cycle_day')">{{ ui('Billing cycle', '账单周期') }}</UButton>
          </div>
          <p v-if="usage.cloudflare.billing">{{ ui('Plan', '方案') }}: {{ usage.cloudflare.billing.plan === 'unknown' ? ui('Not specified', '未声明') : usage.cloudflare.billing.plan === 'free' ? 'Free' : 'Paid' }} · {{ ui('Cycle start day', '账期起始日') }}: {{ usage.cloudflare.billing.cycle_day ?? ui('Not specified', '未声明') }}</p>
          <p class="muted-copy">{{ ui('Daily usage does not require a billing cycle. Set your actual Cloudflare plan and cycle to view period totals. This does not change your subscription.', '查看当日用量不需要填写账期。声明实际 Cloudflare 方案和账期后可查看周期累计，不会改变订阅。') }}</p>
          <template v-if="billingMetrics.length"><h3>{{ ui('Billing-period usage', '账期累计用量') }}</h3><dl class="usage-metrics"><div v-for="metric in billingMetrics" :key="metric.key"><dt>{{ metricNames[metric.key] ?? metric.key }}</dt><dd><strong>{{ metricValue(metric) }}</strong></dd></div></dl></template>
          <p class="muted-copy">{{ ui('Allowances are shared across the Cloudflare account. Instance usage is not remaining allowance or an invoice.', 'Cloudflare 额度由账户内资源共享，本实例用量不表示账户剩余额度，也不代表账单。') }}</p>
          <p class="muted-copy">{{ ui('Storage is the latest observation, not daily consumption. Missing values are not zero.', '容量为最近一次观测，不是每日消耗；暂无数据不代表用量为零。') }}</p>
          <p class="muted-copy">{{ ui('Last collected', '最近采集') }}: {{ time(usage.cloudflare.collected_at) }}</p>
          <dl class="usage-windows"><div v-for="metric in currentScopeMetrics" :key="metric.key"><dt>{{ metricNames[metric.key] ?? metric.key }}</dt><dd>{{ time(metric.period_start) }} — {{ time(metric.period_end) }}<template v-if="metric.observed_at"> · {{ ui('Observed', '观测于') }} {{ time(metric.observed_at) }}</template></dd></div></dl>
        </details>
        <div class="usage-attachment">
      <div class="usage-cloud-heading"><h3>{{ ui('Attachment storage limit', '附件存储上限') }}</h3><UButton color="neutral" variant="ghost" v-if="!editing" class="text-button" type="button" :disabled="loading" @click="editSettings">{{ ui('Set limit', '设置上限') }}</UButton></div>
      <p>{{ bytes(usage.attachments.reserved_bytes) }} / {{ !usage.attachments.limit_configured ? ui('Not set', '未设置') : usage.attachments.limit_bytes === null ? ui('Unlimited', '不限制') : bytes(usage.attachments.limit_bytes) }}<template v-if="usage.attachments.limit_configured && usage.attachments.limit_bytes !== null"> · {{ number(percent) }}%</template> · {{ usage.attachments.enabled ? ui('Attachments enabled', '附件已启用') : ui('Attachments disabled', '附件未启用') }}</p>
      <meter v-if="usage.attachments.limit_configured && usage.attachments.limit_bytes !== null && usage.attachments.limit_bytes > 0" :class="{ 'capacity-reached': capacityReached }" min="0" :high="usage.attachments.limit_bytes * 0.9" :optimum="0" :max="usage.attachments.limit_bytes" :value="usage.attachments.reserved_bytes" :aria-label="ui('Reserved attachment storage', '附件占用空间')" />
      <p v-if="capacityReached" class="warning-panel" role="status">{{ ui('Storage limit reached. New uploads are paused; existing attachments remain accessible. Raise the limit or wait for reclamation to free space.', '已达到容量上限，新增上传已暂停；已有附件仍可访问。可提高上限或等待回收释放容量。') }}</p>
      <p v-if="!usage.attachments.limit_configured" class="warning-panel">{{ ui('Choose a storage limit or explicitly select unlimited before uploading new files.', '请先设置存储上限或明确选择不限制，再上传新文件。') }}</p>
      <form v-if="editing" class="usage-settings" @submit.prevent="saveSettings">
        <label>{{ ui('Storage limit', '存储上限') }}<USelect v-model="settingsMode" :disabled="saving" :placeholder="ui('Choose…','请选择…')" :items="[{value:'limited',label:ui('Set a limit','设置容量上限')},{value:'unlimited',label:ui('Unlimited','不限制')}]" /></label>
        <label v-if="settingsMode === 'limited'">{{ ui('Capacity (MiB)', '容量（MiB）') }}<UInput v-model="limitMiB" type="number" min="0.00000095367431640625" step="any" :disabled="saving" required /></label>
        <p class="muted-copy">{{ ui('1 GiB = 1024 MiB. Lowering the limit keeps existing files and blocks new uploads above the limit. Unlimited has no application budget cap and may incur R2 charges.', '1 GiB = 1024 MiB。调低上限不删除已有文件，超出时仅阻止新上传。不限制表示没有应用容量上限，仍可能产生 R2 费用。') }}</p>
        <p v-if="settingsError" role="alert" class="warning-panel">{{ settingsError === 'invalid' ? ui('Choose a mode and enter a positive capacity precise to whole bytes.', '请选择模式，并输入可精确换算为整数字节的正容量。') : settingsError === 'conflict' ? ui('The current limit changed elsewhere and has been updated below. Review it before saving your draft again.', '当前上限已被其他操作修改，下方已更新。请核对后再次保存，草稿已保留。') : ui('Could not save or read settings. Your draft is retained; try again.', '保存或读取设置失败，草稿已保留，请重试。') }}</p>
        <div class="usage-setting-actions"><UButton color="neutral" variant="outline" class="secondary-button" type="submit" :disabled="saving">{{ saving ? ui('Saving…', '正在保存…') : ui('Save', '保存') }}</UButton><UButton color="neutral" variant="ghost" class="text-button" type="button" :disabled="saving" @click="editing = false">{{ ui('Cancel', '取消') }}</UButton></div>
      </form>
      <p class="muted-copy">{{ ui('Reserved until files are reclaimed, including uploads and deleted files. Not actual R2 storage or a billing cap.', '含上传中和已删除文件，回收后释放；不等于 R2 实际容量或账单上限。') }}</p>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.usage-update { margin: 0 0 16px; font-size: 13px; }
.usage-resources { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.usage-resource h3, .usage-storage h3 { margin: 0 0 8px; font-size: 14px; }
.usage-resource .usage-metrics { grid-template-columns: 1fr; }
.usage-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 24px; margin: 0; }
.usage-metrics dt { color: var(--color-text-muted); font-size: 13px; }
.usage-metrics dd { margin: 6px 0 0; font-size: 22px; font-variant-numeric: tabular-nums; }
.usage-storage, .usage-attachment { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--color-border); }
.usage-details { margin-top: 24px; }
.usage-details summary { cursor: pointer; color: var(--color-text-muted); }
.usage-details .usage-metrics { margin: 16px 0; }
.usage-preferences { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.usage-summary-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.usage-scope, .usage-settings label { display: grid; gap: 6px; }
.usage-scope { font-size: 13px; color: var(--color-text-muted); }
.usage-settings { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 12px 0; }
.usage-settings p { flex-basis: 100%; margin: 0; }
.usage-setting-actions, .usage-cloud-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.usage-cloud-heading h3 { margin: 0; font-size: 15px; }
.usage-panel meter { width: min(100%, 480px); height: 12px; accent-color: var(--color-primary); }
.usage-panel meter.capacity-reached { accent-color: var(--color-warning); }
.usage-panel meter.capacity-reached::-webkit-meter-optimum-value { background: var(--color-warning); }
.usage-panel meter.capacity-reached::-moz-meter-bar { background: var(--color-warning); }
.usage-windows > div { padding: 8px 0; border-bottom: 1px solid var(--color-border); }
.usage-windows dd { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .usage-resources { grid-template-columns: 1fr; gap: 20px; }
  .usage-resource .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-metrics, .usage-summary-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-metrics dd { font-size: 19px; }
}
</style>
