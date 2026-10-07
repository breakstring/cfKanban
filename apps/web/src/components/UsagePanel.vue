<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
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
  warning_percent: number;
  allowances_shared: true;
  analytics_not_invoice: true;
}
interface UsageAlert {
  metric_key: string;
  scope: "instance" | "account";
  level: "warning" | "reached";
  value: number;
  allowance: number;
  percent: number;
  period_start: string;
  period_end: string;
}
interface Usage {
  generated_at: string;
  attachments: { enabled: boolean; reserved_bytes: number; limit_bytes: number | null; limit_configured: boolean; settings_version: number };
  public_access?: {
    status: "not_configured" | "configured" | "invalid";
    hostname: string | null;
    mode: "custom_domain" | null;
    waf_profile: "disabled" | "anonymous-api-filter" | null;
    verified_at: string | null;
    live_verified: false;
  };
  cloudflare: {
    status: "not_configured" | "pending" | "fresh" | "stale" | "error";
    refreshing: boolean;
    collected_at: string | null;
    attempted_at: string | null;
    error: string | null;
    metrics: UsageMetric[];
    billing?: UsageBilling;
    alerts?: UsageAlert[];
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
const baseMetricKeys = ["d1_storage_bytes", "d1_rows_read", "d1_rows_written", "r2_storage_bytes", "r2_objects", "r2_operations"];
const metricNames = computed<Record<string, string>>(() => ({
  d1_storage_bytes: ui("D1 storage", "D1 存储容量"),
  d1_rows_read: ui("D1 rows read today", "D1 当日读取行数"),
  d1_rows_written: ui("D1 rows written today", "D1 当日写入行数"),
  r2_storage_bytes: ui("R2 storage", "R2 存储容量"),
  r2_objects: ui("R2 objects", "R2 对象数"),
  r2_operations: ui("R2 operations today", "R2 当日操作量"),
  workers_requests: ui("Workers requests", "Workers 请求量"),
  workers_cpu_microseconds: ui("Workers cumulative CPU", "Workers 累计 CPU"),
  r2_class_a_operations: ui("R2 Class A operations", "R2 Class A 操作量"),
  r2_class_b_operations: ui("R2 Class B operations", "R2 Class B 操作量"),
  r2_unclassified_operations: ui("R2 unclassified operations", "R2 未分类操作量"),
  d1_billing_rows_read: ui("D1 rows read in billing period", "D1 账单周期读取行数"),
  d1_billing_rows_written: ui("D1 rows written in billing period", "D1 账单周期写入行数"),
}));
const metricGroups = computed(() => {
  const values = usage.value?.cloudflare.metrics ?? [];
  return (["instance", "account"] as const).map(scope => {
    const scoped = values.filter(metric => (metric.scope ?? "instance") === scope);
    const keys = [...new Set([...(scope === "instance" ? baseMetricKeys : []), ...scoped.map(metric => metric.key)])];
    const charts = [
      { key: "d1", title: ui("D1 read and write counts", "D1 读取与写入行数"), keys: ["d1_rows_read", "d1_rows_written"] },
      { key: "r2", title: ui("R2 operation counts", "R2 操作分类数量"), keys: ["r2_class_a_operations", "r2_class_b_operations", "r2_unclassified_operations"] },
    ].flatMap(chart => {
      const entries = chart.keys.map(key => ({ key, label: metricNames.value[key] ?? key, metric: scoped.find(metric => metric.key === key) }));
      const known = entries.flatMap(entry => entry.metric?.value == null ? [] : [entry.metric]);
      const first = known[0];
      if (known.length < 2 || !first?.period_start || !first.period_end
        || known.some(metric => metric.unit !== "count" || metric.period_start !== first.period_start || metric.period_end !== first.period_end)) return [];
      return [{ ...chart, entries, maximum: Math.max(...known.map(metric => metric.value ?? 0)) }];
    });
    return { scope, label: scope === "instance" ? ui("Instance usage", "本实例用量") : ui("Account totals", "账户总量"), charts,
      metrics: keys.map(key => ({ key, label: metricNames.value[key] ?? key, metric: scoped.find(metric => metric.key === key) })) };
  }).filter(group => group.scope === "instance" || group.metrics.length > 0 || usage.value?.cloudflare.billing?.account_totals_enabled);
});
const summaryMetrics = computed(() => ["d1_storage_bytes", "d1_rows_read", "r2_storage_bytes"].map(key => ({
  key, label: metricNames.value[key] ?? key,
  metric: usage.value?.cloudflare.status === "not_configured" ? undefined : usage.value?.cloudflare.metrics.find(metric => metric.key === key && (metric.scope ?? "instance") === "instance"),
})));
const observedOrigin = computed(() => props.observedOrigin || globalThis.location?.origin || null);
const visibleAlerts = computed(() => !failed.value && usage.value?.cloudflare.status === "fresh" && !usage.value.cloudflare.refreshing
  ? (usage.value.cloudflare.alerts ?? []).slice(0, 16) : []);
function metricValue(metric: UsageMetric | undefined): string {
  if (metric?.value == null) return ui("Unknown", "未知");
  return metric.unit === "bytes" ? bytes(metric.value) : `${number(metric.value)}${metric.unit === "microseconds" ? " µs" : ""}`;
}
function alertValue(alert: UsageAlert, value: number): string {
  const metric = usage.value?.cloudflare.metrics.find(item => item.key === alert.metric_key && (item.scope ?? "instance") === alert.scope);
  return metricValue({ key: alert.metric_key, value, unit: metric?.unit ?? "count", period_start: null, period_end: null, observed_at: null });
}
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
function snapshotExpired(value: Usage): boolean {
  const collectedAt = value.cloudflare.collected_at ? Date.parse(value.cloudflare.collected_at) : NaN;
  return !Number.isFinite(collectedAt) || Date.now() - collectedAt >= 15 * 60 * 1000;
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
      if (usage.value?.cloudflare.status === "fresh") usage.value.cloudflare.status = "stale";
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) usage.value = null;
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
  if (failed.value || current === null || needsCollection(current)) void refresh("open");
});
watch(() => props.refreshGeneration, () => { void refresh("open"); });
onMounted(() => refresh("open"));
onUnmounted(() => { disposed = true; generation++; controller?.abort(); settingsController.abort(); });
</script>

<template>
  <section class="owner-section usage-panel" aria-labelledby="usage-heading" :aria-busy="loading">
    <div class="section-heading-row">
      <div><h2 id="usage-heading">{{ ui('Usage & limits', '用量与限额') }}</h2><p>{{ summary ? ui('Key figures from the latest snapshot.', '最近快照中的关键数据。') : ui('Application budget and Cloudflare statistics for this instance.', '本实例的应用预算与 Cloudflare 统计。') }}</p></div>
      <UButton v-if="summary" color="neutral" variant="outline" class="secondary-button" type="button" @click="emit('details')">{{ ui('View usage details', '查看用量详情') }}</UButton>
      <UButton v-else color="neutral" variant="outline" class="secondary-button" type="button" :disabled="loading || saving" @click="refresh()">{{ loading ? ui('Loading…', '正在读取…') : ui('Refresh usage', '刷新用量') }}</UButton>
    </div>
    <p v-if="failed" class="warning-panel" role="alert">{{ usage ? ui('Refresh failed. Displayed values are from the previous snapshot and may be out of date.', '刷新失败。下方保留上次快照，数据可能已过期。') : ui('Usage is unavailable. Try refreshing usage.', '暂时无法读取用量，请刷新用量重试。') }}</p>
    <template v-if="summary && usage">
      <dl class="usage-metrics usage-summary-metrics">
        <div><dt>{{ ui('Attachment budget reserved', '附件预留预算') }}</dt><dd><strong>{{ bytes(usage.attachments.reserved_bytes) }}</strong></dd><p class="muted-copy">{{ !usage.attachments.limit_configured ? ui('Limit not set', '尚未设置上限') : usage.attachments.limit_bytes === null ? ui('Unlimited application budget', '应用预算不限制') : `${ui('Limit', '上限')}: ${bytes(usage.attachments.limit_bytes)}` }}</p></div>
        <div v-for="entry in summaryMetrics" :key="entry.key"><dt>{{ entry.label }}</dt><dd><strong>{{ metricValue(entry.metric) }}</strong></dd></div>
      </dl>
      <p class="muted-copy usage-summary-status" role="status">{{ statusText }}<template v-if="usage.cloudflare.collected_at && usage.cloudflare.status !== 'not_configured'"> · {{ ui('Updated', '更新于') }} {{ shortTime(usage.cloudflare.collected_at) }}</template><template v-if="visibleAlerts.length"> · {{ visibleAlerts.length }} {{ ui('allowance reminders', '项额度提醒') }}</template></p>
    </template>
    <p v-else-if="summary && loading" class="muted-copy" role="status">{{ ui('Loading usage…', '正在读取用量…') }}</p>
    <template v-if="!summary && usage">
      <div class="usage-cloud-heading"><h3>{{ ui('Attachment application budget', '附件应用预算') }}</h3><UButton color="neutral" variant="ghost" v-if="!editing" class="text-button" type="button" :disabled="loading" @click="editSettings">{{ ui('Set limit', '设置上限') }}</UButton></div>
      <p>{{ bytes(usage.attachments.reserved_bytes) }} / {{ !usage.attachments.limit_configured ? ui('Not set', '未设置') : usage.attachments.limit_bytes === null ? ui('Unlimited', '不限制') : bytes(usage.attachments.limit_bytes) }}<template v-if="usage.attachments.limit_configured && usage.attachments.limit_bytes !== null"> · {{ number(percent) }}%</template> · {{ usage.attachments.enabled ? ui('Attachments enabled', '附件已启用') : ui('Attachments disabled', '附件未启用') }}</p>
      <meter v-if="usage.attachments.limit_configured && usage.attachments.limit_bytes !== null && usage.attachments.limit_bytes > 0" :class="{ 'capacity-reached': capacityReached }" min="0" :high="usage.attachments.limit_bytes * 0.9" :optimum="0" :max="usage.attachments.limit_bytes" :value="usage.attachments.reserved_bytes" :aria-label="ui('Reserved attachment budget', '附件预留预算')" />
      <p v-if="capacityReached" class="warning-panel" role="status">{{ ui('Storage limit reached. New uploads are paused; existing attachments remain accessible. Raise the limit or wait for reclamation to free space.', '已达到容量上限，新增上传已暂停；已有附件仍可访问。可提高上限或等待回收释放容量。') }}</p>
      <p v-if="!usage.attachments.limit_configured" class="warning-panel">{{ ui('Choose a storage limit or explicitly select unlimited before uploading new files.', '请先设置存储上限或明确选择不限制，再上传新文件。') }}</p>
      <form v-if="editing" class="usage-settings" @submit.prevent="saveSettings">
        <label>{{ ui('Storage limit', '存储上限') }}<select v-model="settingsMode" :disabled="saving"><option value="" disabled>{{ ui('Choose…', '请选择…') }}</option><option value="limited">{{ ui('Set a limit', '设置容量上限') }}</option><option value="unlimited">{{ ui('Unlimited', '不限制') }}</option></select></label>
        <label v-if="settingsMode === 'limited'">{{ ui('Capacity (MiB)', '容量（MiB）') }}<input v-model="limitMiB" type="number" min="0.00000095367431640625" step="any" :disabled="saving" required /></label>
        <p class="muted-copy">{{ ui('1 GiB = 1024 MiB. Lowering the limit keeps existing files and blocks new uploads above the limit. Unlimited has no application budget cap and may incur R2 charges.', '1 GiB = 1024 MiB。调低上限不删除已有文件，超出时仅阻止新上传。不限制表示没有应用容量上限，仍可能产生 R2 费用。') }}</p>
        <p v-if="settingsError" role="alert" class="warning-panel">{{ settingsError === 'invalid' ? ui('Choose a mode and enter a positive capacity precise to whole bytes.', '请选择模式，并输入可精确换算为整数字节的正容量。') : settingsError === 'conflict' ? ui('Settings changed elsewhere. Refresh settings, review the current budget, then save your retained draft.', '设置已被其他操作修改。请刷新设置并核对当前预算，再保存保留的草稿。') : ui('Could not save or read settings. Your draft is retained; try again.', '保存或读取设置失败，草稿已保留，请重试。') }}</p>
        <div class="usage-setting-actions"><UButton color="neutral" variant="outline" v-if="settingsError === 'conflict'" class="secondary-button" type="button" :disabled="saving" @click="reloadSettings">{{ ui('Refresh settings', '刷新设置') }}</UButton><UButton color="neutral" variant="outline" class="secondary-button" type="submit" :disabled="saving || settingsError === 'conflict'">{{ saving ? ui('Saving…', '正在保存…') : ui('Save', '保存') }}</UButton><UButton color="neutral" variant="ghost" class="text-button" type="button" :disabled="saving" @click="editing = false">{{ ui('Cancel', '取消') }}</UButton></div>
      </form>
      <p class="muted-copy">{{ ui('Reserved until files are reclaimed, including uploads and deleted files. Not actual R2 storage or a billing cap.', '含上传中和已删除文件，回收后释放；不等于 R2 实际容量或账单上限。') }}</p>
      <div class="usage-cloud-heading"><h3>{{ ui('Cloudflare statistics', 'Cloudflare 用量统计') }}</h3><span role="status">{{ statusText }}</span><span v-if="usage.cloudflare.collected_at && usage.cloudflare.status !== 'not_configured'">{{ ui('Updated', '更新于') }} {{ shortTime(usage.cloudflare.collected_at) }}</span></div>
      <p v-if="usage.cloudflare.status === 'not_configured'" class="muted-copy">{{ ui('The connection or resource settings are missing, or collection is disabled.', '连接或资源设置尚未配置，或采集已关闭。') }} <a href="/app/admin">{{ ui('Check connection in Overview', '在概览中检查连接') }}</a> · <a href="#connection-configuration-heading" @click="emit('settings', 'analytics_enabled')">{{ ui('Usage collection setting', '用量采集设置') }}</a></p>
      <template v-else>
        <p v-if="usage.cloudflare.refreshing" class="muted-copy" role="status">{{ ui('Collection is in progress. Refresh usage later to read the result.', '正在采集中，请稍后手动刷新用量查看结果。') }}</p>
        <p v-if="!usage.cloudflare.refreshing && (usage.cloudflare.status === 'stale' || usage.cloudflare.error)" class="warning-panel">{{ ui('Collection failed or the snapshot is older than fifteen minutes. Available values are retained; unknown values are not zero.', '采集失败或快照已超过十五分钟。保留已有数据；未知值不代表零。') }}</p>
        <div v-if="usage.cloudflare.billing" class="usage-billing">
          <p>{{ ui('Cloudflare Workers/D1 plan', 'Cloudflare Workers/D1 方案') }}: {{ usage.cloudflare.billing.plan === 'free' ? 'Free' : usage.cloudflare.billing.plan === 'paid' ? 'Paid' : ui('Unknown', '未知') }} · {{ ui('cfKanban usage reminder threshold', 'cfKanban 用量提醒阈值') }}: {{ number(usage.cloudflare.billing.warning_percent) }}%</p>
          <p v-if="usage.cloudflare.billing.plan === 'free'" class="muted-copy">{{ ui('Workers and D1 allowances use the current UTC day. R2 operation allowances use the configured billing period.', 'Workers 与 D1 额度按 UTC 当日比较；R2 操作额度按配置的账单周期比较。') }}</p>
          <p v-if="usage.cloudflare.billing.cycle_day === null" class="muted-copy">{{ ui('Billing cycle is not configured. Monthly usage and allowance comparisons remain unknown. This is the Cloudflare billing cycle, not a separate cfKanban cycle; Free daily figures do not require it.', '尚未配置账单周期，月累计量与月额度比较保持未知。这里指 Cloudflare 的账单周期，不是 cfKanban 自己维护的周期；Free 的日用量不依赖月周期。') }}</p>
          <p v-else class="muted-copy">{{ ui('Billing period starts on UTC day', '账单周期起始日（UTC）') }} {{ usage.cloudflare.billing.cycle_day }}{{ ui(' of each month, adjusted to the last day of shorter months.', ' 号，短月按月末调整。') }}</p>
          <p v-if="usage.cloudflare.billing.plan === 'unknown'" class="muted-copy">{{ ui('Free/Paid is not declared in this deployment. cfKanban does not read your subscription, so Unknown does not mean your Cloudflare plan is missing.', '本次部署尚未声明 Free/Paid。cfKanban 不读取订阅状态，因此“未知”不表示你的 Cloudflare 没有服务方案。') }}</p>
          <p v-if="!usage.cloudflare.billing.r2_standard_only_scope || usage.cloudflare.billing.r2_standard_only_scope === 'unknown'" class="muted-copy">{{ ui('R2 free allowances apply only to Standard storage. Its usage scope is unconfirmed, so R2 allowance reminders are unavailable.', 'R2 免费额度仅适用于 Standard 存储；尚未确认其用量范围，因此暂不提供 R2 额度提醒。') }}</p>
          <p v-else-if="usage.cloudflare.billing.r2_standard_only_scope === 'instance'" class="muted-copy">{{ ui('Standard-only R2 usage is confirmed for this instance. This does not confirm the account totals; R2 free allowances are compared only for this instance.', '仅已确认本实例的 R2 用量全部属于 Standard，不代表账户总量也满足此条件；R2 免费额度仅比较本实例用量。') }}</p>
        </div>
        <p class="muted-copy"><a href="#connection-configuration-heading" @click="emit('settings', 'billing_plan')">{{ ui('Change plan, billing cycle, or reminders in Usage settings', '在用量设置中修改方案、账期或提醒') }}</a></p>
        <section v-if="visibleAlerts.length" class="usage-alerts" aria-labelledby="usage-alerts-heading">
          <h4 id="usage-alerts-heading">{{ ui('Shared allowance reminders', '共享额度提醒') }}</h4>
          <p class="muted-copy">{{ ui('Calculated from this fresh usage snapshot. These are separate from Cloudflare billing Budget Alerts.', '根据本次新鲜用量快照计算，与 Cloudflare 账单预算警报是两套提醒。') }}</p>
          <ul>
            <li v-for="alert in visibleAlerts" :key="`${alert.scope}:${alert.metric_key}`" class="warning-panel">
              <strong>{{ alert.scope === 'instance' ? ui('Instance contribution', '本实例贡献') : ui('Account total', '账户总量') }} · {{ metricNames[alert.metric_key] ?? alert.metric_key }}</strong><br />
              {{ alertValue(alert, alert.value) }} / {{ alertValue(alert, alert.allowance) }} · {{ number(alert.percent) }}% · {{ alert.level === 'reached' ? ui('Shared allowance reached', '已达到共享额度') : ui('Warning threshold reached', '已达到提醒阈值') }}
              <meter class="usage-allowance-meter" min="0" :max="alert.allowance" :value="Math.min(alert.value, alert.allowance)" :aria-label="`${metricNames[alert.metric_key] ?? alert.metric_key}: ${number(alert.percent)}%`" />
            </li>
          </ul>
        </section>
        <section v-for="group in metricGroups" :key="group.scope" class="usage-metric-group" :aria-label="group.label">
          <h4>{{ group.label }}</h4>
          <p v-if="group.scope === 'account'" class="muted-copy">{{ ui('Optional account totals include other resources in the account and may be delayed.', '可选账户总量包含账户内其他资源，统计可能延迟。') }}</p>
          <p v-if="!group.metrics.length" class="muted-copy">{{ ui('No account observation is available yet.', '暂未取得账户总量观测。') }}</p>
          <dl v-else class="usage-metrics">
            <div v-for="entry in group.metrics" :key="entry.key"><dt>{{ entry.label }}</dt><dd><strong>{{ metricValue(entry.metric) }}</strong></dd></div>
          </dl>
        </section>
        <p v-if="usage.cloudflare.billing && !usage.cloudflare.billing.account_totals_enabled" class="muted-copy">{{ ui('Account totals are not enabled.', '未启用账户总量。') }} <a href="#connection-configuration-heading" @click="emit('settings', 'account_totals')">{{ ui('Review account totals setting', '查看账户汇总设置') }}</a></p>
      </template>
      <p class="muted-copy usage-note">{{ ui('Allowances are shared across the account. Instance figures show contribution, not remaining allowance. Analytics may be sampled or delayed and are not an invoice.', '额度由账户内资源共享，实例数据只表示贡献，不表示剩余额度。统计可能采样或延迟，不代表账单。') }}</p>
      <p class="muted-copy usage-note">{{ ui('Daily totals use UTC; storage uses the latest available observation and may be delayed.', '今日按 UTC 统计；容量为最近可用观测，可能延迟。') }}</p>
      <p class="muted-copy usage-note">{{ ui('Web and Skill share a 15-minute cache · 60-second cooldown · No background polling', '页面与技能共用 15 分钟缓存 · 冷却 60 秒 · 无后台轮询') }}</p>
      <details class="usage-details">
        <summary>{{ ui('Data details & snapshot charts', '数据详情与快照图表') }}</summary>
        <p class="muted-copy">{{ ui('These bars compare counts from the latest snapshot in the same window, not allowance percentages. The separate usage history panel shows collected complete UTC days and preserves missing dates.', '这里的横条比较最新快照同一窗口内的数量，不是额度百分比。独立的用量历史面板展示已采集的完整 UTC 日，并保留缺日。') }}</p>
        <p class="muted-copy">{{ ui('Application snapshot read at', '应用快照读取于') }}: {{ time(usage.generated_at) }}</p>
        <template v-if="usage.cloudflare.status !== 'not_configured'">
          <p class="muted-copy">{{ ui('Last successful collection', '上次成功采集') }}: {{ time(usage.cloudflare.collected_at) }}<br />{{ ui('Last attempt', '上次尝试') }}: {{ time(usage.cloudflare.attempted_at) }}</p>
          <p v-if="usage.cloudflare.billing" class="muted-copy">{{ ui('Billing period observation', '账单周期观测范围') }}: {{ time(usage.cloudflare.billing.period_start) }} — {{ time(usage.cloudflare.billing.period_end) }}</p>
          <template v-for="group in metricGroups" :key="group.scope">
            <h4>{{ group.label }}</h4>
            <figure v-for="chart in group.charts" :key="chart.key" class="usage-chart">
              <figcaption>{{ chart.title }}</figcaption>
              <ul>
                <li v-for="entry in chart.entries" :key="entry.key">
                  <div class="usage-chart-label"><span>{{ entry.label }}</span><strong>{{ metricValue(entry.metric) }}</strong></div>
                  <div v-if="entry.metric?.value != null" class="usage-chart-track" aria-hidden="true"><span :style="{ width: `${chart.maximum > 0 ? entry.metric.value / chart.maximum * 100 : 0}%` }" /></div>
                </li>
              </ul>
            </figure>
            <dl class="usage-windows">
              <div v-for="entry in group.metrics" :key="entry.key">
                <dt>{{ entry.label }}</dt>
                <dd>
                  {{ ui('Window', '统计窗口') }}: {{ time(entry.metric?.period_start ?? null) }} — {{ time(entry.metric?.period_end ?? null) }}<br />
                  {{ ui('Observed', '观测时间') }}: {{ time(entry.metric?.observed_at ?? null) }}
                </dd>
              </div>
            </dl>
          </template>
        </template>
        <p class="muted-copy">{{ ui('Daily totals start at 00:00 UTC. Storage and object counts use the latest available observation within 24 hours, excluding the current hour.', '日累计量从 UTC 当日 00:00 起算。容量与对象数采用最近 24 小时内最近一次可用观测，不包含当前小时。') }}</p>
        <p class="muted-copy">{{ ui('Instance usage does not represent account-wide usage or remaining allowances. Project active quotas remain in each project’s Public Join settings.', '本实例用量不代表账户总用量或剩余额度。项目配额仍在各项目的公开加入设置中查看。') }}</p>
        <p class="muted-copy">{{ ui('CPU is cumulative microseconds, not a percentile-based estimate. R2 Class A/B follows operation classification; unclassified requests remain separate. Observed storage is not GB-month billing.', 'CPU 为累计微秒值，不按分位数估算。R2 按操作分类展示 Class A/B，未分类请求单独保留。观测容量不等于 GB-month 计费用量。') }}</p>
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
.usage-allowance-meter { display: block; margin-top: 8px; }
.usage-cloud-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
.usage-cloud-heading span { color: var(--color-text-muted); font-size: 13px; }
.usage-metric-group h4, .usage-alerts h4 { margin: 16px 0 8px; }
.usage-alerts ul { display: grid; gap: 8px; list-style: none; padding: 0; }
.usage-alerts li { margin: 0; }
.usage-billing p { margin: 8px 0; }
.usage-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 24px; margin: 8px 0 16px; }
.usage-metrics > div { padding: 16px 0; border-bottom: 1px solid var(--color-border); }
.usage-metrics dt { color: var(--color-text-muted); font-size: 13px; }
.usage-metrics dd { margin: 8px 0 0; font-size: 22px; font-variant-numeric: tabular-nums; }
.usage-note { margin: 4px 0; }
.usage-details { margin-top: 16px; }
.usage-details summary { cursor: pointer; color: var(--color-text-muted); }
.usage-summary-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.usage-summary-metrics p { margin: 4px 0 0; font-size: 12px; }
.usage-summary-status { margin-bottom: 0; }
.usage-chart { margin: 16px 0 24px; max-width: 720px; }
.usage-chart figcaption { font-weight: 600; }
.usage-chart ul { display: grid; gap: 12px; margin: 12px 0 0; padding: 0; list-style: none; }
.usage-chart-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin-bottom: 4px; font-size: 13px; }
.usage-chart-label strong { font-variant-numeric: tabular-nums; }
.usage-chart-track { height: 12px; border-radius: 3px; background: var(--color-surface-muted); overflow: hidden; }
.usage-chart-track span { display: block; height: 100%; background: var(--color-primary); }
.usage-windows > div { padding: 8px 0; border-bottom: 1px solid var(--color-border); }
.usage-windows dd { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 600px) { .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; } }
</style>
