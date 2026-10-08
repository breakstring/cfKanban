<script setup lang="ts">
import USelect from "@nuxt/ui/components/Select.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import UsageHistoryChart, { type HistoryPointView } from "./UsageHistoryChart.vue";
import { ApiProblem, apiRequest, clearPendingRequestIntents, hasUncertainWrite } from "../lib/api";
import { locale } from "../lib/i18n";

interface Metric { key: string; value: number | null; unit: string; scope: "instance" | "account"; period_start: string | null; period_end: string | null; observed_at: string | null }
interface History {
  enabled: boolean; retention_days: 90; generated_at: string;
  items: { day: string; collected_at: string; metrics: Metric[]; complete_day: true }[];
  missing_days: string[]; source: "cloudflare_analytics"; history_kind: "utc_daily"; error: string | null;
}
const props = withDefaults(defineProps<{ refreshGeneration?: number }>(), { refreshGeneration: 0 });
const base = "/api/v1/admin/usage/history";
const history = ref<History | null>(null);
const days = ref("30");
const scope = ref<"instance" | "account">("instance");
const metricKey = ref("d1_rows_read");
const loading = ref(false);
const busy = ref(false);
const failed = ref(false);
const collectionUncertain = ref(false);
let controller: AbortController | null = null;
let generation = 0;
let disposed = false;
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const names = computed<Record<string, string>>(() => ({
  workers_requests: ui("Workers requests", "Workers 请求量"), workers_cpu_microseconds: ui("Workers cumulative CPU", "Workers 累计 CPU"),
  d1_rows_read: ui("D1 rows read", "D1 读取行数"), d1_rows_written: ui("D1 rows written", "D1 写入行数"), d1_storage_bytes: ui("D1 observed storage", "D1 观测容量"),
  r2_storage_bytes: ui("R2 observed storage", "R2 观测容量"), r2_objects: ui("R2 object count", "R2 对象数"),
  r2_class_a_operations: ui("R2 Class A operations", "R2 Class A 操作量"), r2_class_b_operations: ui("R2 Class B operations", "R2 Class B 操作量"),
  r2_unclassified_operations: ui("R2 unclassified operations", "R2 未分类操作量"), r2_operations: ui("R2 operations", "R2 操作量"),
}));
const metrics = computed(() => [...new Set(history.value?.items.flatMap(item => item.metrics.filter(metric => metric.scope === scope.value).map(metric => metric.key)) ?? [])]
  .map(key => ({ value: key, label: names.value[key] ?? key })));
const metricUnit = computed(() => metricKey.value.endsWith("_storage_bytes") ? "bytes" : metricKey.value === "workers_cpu_microseconds" ? "microseconds" :
  names.value[metricKey.value] ? "count" : history.value?.items.flatMap(item => item.metrics).find(metric => metric.scope === scope.value && metric.key === metricKey.value)?.unit ?? "count");
const unitLabel = computed(() => metricUnit.value === "bytes" ? ui("bytes", "字节") : metricUnit.value === "microseconds" ? ui("µs", "微秒") : metricUnit.value === "count" ? ui("count", "数量") : metricUnit.value);
const completeDays = computed(() => {
  const end = Date.parse(`${history.value?.generated_at.slice(0, 10) ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: Number(days.value) }, (_, index) => new Date(end - (Number(days.value) - index) * 86_400_000).toISOString().slice(0, 10));
});
const recentDays = computed(() => completeDays.value.slice(-7));
const accountAvailable = computed(() => Boolean(history.value?.items.some(item => item.metrics.some(metric => metric.scope === "account"))));
const points = computed<HistoryPointView[]>(() => completeDays.value.map(day => {
  const item = history.value?.items.find(item => item.day === day);
  const metric = item?.metrics.find(metric => metric.key === metricKey.value && metric.scope === scope.value);
  const start = Date.parse(`${day}T00:00:00Z`);
  const windowMatches = metric?.period_start === null && metric.period_end === null
    ? (metric.key.endsWith("_storage_bytes") || metric.key === "r2_objects") && metric.observed_at !== null && Date.parse(metric.observed_at) >= start && Date.parse(metric.observed_at) < start + 86_400_000
    : Date.parse(metric?.period_start ?? "") === start && Date.parse(metric?.period_end ?? "") === start + 86_400_000;
  // 单个图的单位固定；不把供应商异常或未采集日期绘成零。
  return { day, value: metric?.unit === metricUnit.value && windowMatches ? metric.value : null, periodStart: metric?.period_start ?? null, periodEnd: metric?.period_end ?? null, observedAt: metric?.observed_at ?? null };
}));
let lastReadAt = 0;
let lastCollectionAt = 0;
let readbackTimer: ReturnType<typeof setTimeout> | null = null;
function clearReadback(): void { if (readbackTimer) clearTimeout(readbackTimer); readbackTimer = null; }
function applyHistory(value: History): void {
  history.value = value;
  if (!metrics.value.some(metric => metric.value === metricKey.value)) metricKey.value = metrics.value[0]?.value ?? "d1_rows_read";
  if (!accountAvailable.value) scope.value = "instance";
}
function scheduleReadback(request: number, attempt = 0): void {
  if (disposed || request !== generation || attempt >= 3) return;
  clearReadback();
  readbackTimer = setTimeout(async () => {
    try {
      const value = await apiRequest<History>(`${base}?days=${days.value}`, controller ? { signal: controller.signal } : {});
      if (disposed || request !== generation) return;
      applyHistory(value); failed.value = false; collectionUncertain.value = false;
      clearPendingRequestIntents("POST", `${base}/collect`);
    } catch (error) {
      if (disposed || request !== generation) return;
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) { history.value = null; failed.value = true; collectionUncertain.value = false; }
      else scheduleReadback(request, attempt + 1);
    }
  }, [1000, 3000, 5000][attempt]);
}
async function load(collect = false): Promise<void> {
  const request = ++generation;
  clearReadback();
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  lastReadAt = Date.now();
  loading.value = true; failed.value = false;
  try {
    const value = await apiRequest<History>(`${base}?days=${days.value}`, { signal });
    if (disposed || request !== generation) return;
    applyHistory(value);
    const uncertainBeforeRead = collectionUncertain.value || hasUncertainWrite(`${base}/collect`);
    collectionUncertain.value = false;
    clearPendingRequestIntents("POST", `${base}/collect`);
    const missingDay = [...recentDays.value].reverse().find(day => value.missing_days.includes(day));
    if (!collect || !value.enabled || value.error === "not_configured" || !missingDay || uncertainBeforeRead || Date.now() - lastCollectionAt < 60_000) return;
    lastCollectionAt = Date.now();
    busy.value = true;
    try {
      await apiRequest<History>(`${base}/collect`, { method: "POST", body: { day: missingDay }, idempotencyKey: crypto.randomUUID(), signal });
      if (disposed || request !== generation) return;
      const updated = await apiRequest<History>(`${base}?days=${days.value}`, { signal });
      if (!disposed && request === generation) applyHistory(updated);
    } catch (error) {
      if (disposed || request !== generation) return;
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) { history.value = null; failed.value = true; return; }
      collectionUncertain.value = hasUncertainWrite(`${base}/collect`);
      scheduleReadback(request);
    }
  } catch (error) {
    if (!disposed && request === generation) {
      failed.value = true;
      if (error instanceof ApiProblem && (error.status === 401 || error.status === 403)) history.value = null;
      else scheduleReadback(request);
    }
  } finally { if (!disposed && request === generation) { loading.value = false; busy.value = false; } }
}
function onFocus(): void { if (!loading.value && Date.now() - lastReadAt >= 60_000) void load(true); }
watch(days, () => { void load(); });
watch(() => props.refreshGeneration, () => { void load(true); });
watch(scope, () => { if (!metrics.value.some(metric => metric.value === metricKey.value)) metricKey.value = metrics.value[0]?.value ?? "d1_rows_read"; });
onMounted(() => { void load(true); if (typeof window !== "undefined") window.addEventListener("focus", onFocus); });
onUnmounted(() => { disposed = true; generation++; clearReadback(); controller?.abort(); if (typeof window !== "undefined") window.removeEventListener("focus", onFocus); });
</script>

<template>
  <section class="owner-section usage-history" aria-labelledby="usage-history-heading" :aria-busy="loading || busy">
    <div class="section-heading-row"><div><h2 id="usage-history-heading">{{ ui('Daily history', '每日用量历史') }}</h2><p class="muted-copy">{{ ui('Completed UTC days · Up to 90 days', '完整 UTC 日 · 最多保留 90 天') }}</p></div></div>
    <p v-if="failed" class="warning-panel" role="status">{{ ui('History is temporarily unavailable. Existing data is kept and will be checked again automatically.', '暂时无法更新历史，已保留现有数据，系统会自动重试。') }}</p>
    <p v-if="loading && !history" class="muted-copy" role="status">{{ ui('Loading history…', '正在加载历史…') }}</p>
    <template v-if="history">
      <div v-if="!history.enabled" class="history-empty"><p>{{ ui('Daily records are off. Enable them in Usage & access settings above to see usage trends.', '每日记录已关闭，可在上方「用量与访问设置」中开启，查看用量变化趋势。') }}</p></div>
      <template v-else>
        <p v-if="history.error === 'not_configured'" class="muted-copy">{{ ui('Daily history will become available after Cloudflare is connected above.', '在上方连接 Cloudflare 后即可记录每日用量。') }}</p>
        <p v-else-if="busy || collectionUncertain" class="muted-copy" role="status">{{ ui('Updating recent history…', '正在更新最近的历史…') }}</p>
        <p v-else-if="history.error" class="muted-copy">{{ ui('Some days are not available yet. Existing records are kept.', '部分日期暂时没有数据，已有记录已保留。') }}</p>
      </template>
      <template v-if="history.items.length">
        <div class="history-controls"><label>{{ ui('Period', '时间范围') }}<USelect v-model="days" :items="[{value:'7',label:ui('7 days','7 天')},{value:'30',label:ui('30 days','30 天')},{value:'90',label:ui('90 days','90 天')}]" /></label><label v-if="accountAvailable">{{ ui('Scope', '统计范围') }}<USelect v-model="scope" :items="[{value:'instance',label:ui('This instance','本实例')},{value:'account',label:ui('Whole account','整个账户')}]" /></label><label>{{ ui('Metric', '指标') }}<USelect v-model="metricKey" :items="metrics" :disabled="!metrics.length" /></label></div>
        <UsageHistoryChart v-if="metrics.length" :label="names[metricKey] ?? metricKey" :unit="unitLabel" :points="points" />
        <p class="muted-copy history-note">{{ ui('Gaps mean no data, not zero usage. Today is shown above while it is still in progress.', '缺口表示暂无数据，并非用量为零；尚未结束的今天在上方单独展示。') }}</p>
      </template>
      <p v-else-if="history.enabled && !busy" class="history-empty">{{ ui('Daily records will appear here when data becomes available.', '取得数据后，每日记录会显示在这里。') }}</p>
    </template>
  </section>
</template>

<style scoped>
.history-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-top: 20px; }
.history-controls label { display: grid; gap: 8px; min-width: 160px; }
.history-empty { padding: 8px 0; color: var(--color-text-muted); }
.history-note { margin-bottom: 0; font-size: 13px; }
@media (max-width: 600px) { .history-controls label { width: 100%; } }
</style>
