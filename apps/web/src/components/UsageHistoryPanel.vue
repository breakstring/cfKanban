<script setup lang="ts">
import USelect from "@nuxt/ui/components/Select.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import UsageHistoryChart, { type HistoryPointView } from "./UsageHistoryChart.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { apiRequest, clearPendingRequestIntents, hasUncertainWrite } from "../lib/api";
import { locale } from "../lib/i18n";

interface Metric { key: string; value: number | null; unit: string; scope: "instance" | "account"; period_start: string | null; period_end: string | null; observed_at: string | null }
interface History {
  enabled: boolean; retention_days: 90; generated_at: string;
  items: { day: string; collected_at: string; metrics: Metric[]; complete_day: true }[];
  missing_days: string[]; source: "cloudflare_analytics"; history_kind: "utc_daily"; error: string | null;
}
interface HistoryOperation { operation_id: string; status: "pending" | "verified" | "failed" | "unknown" }
const props = withDefaults(defineProps<{ refreshGeneration?: number }>(), { refreshGeneration: 0 });
const emit = defineEmits<{ settings: [field: "history_enabled"] }>();
const base = "/api/v1/admin/usage/history";
const controlBase = "/api/v1/admin/cloudflare";
const history = ref<History | null>(null);
const days = ref("30");
const scope = ref<"instance" | "account">("instance");
const metricKey = ref("d1_rows_read");
const backfillDay = ref("");
const operation = ref<HistoryOperation | null>(null);
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
const recentDays = computed(() => completeDays.value.slice(-7).map(day => ({ value: day, label: day })));
const points = computed<HistoryPointView[]>(() => completeDays.value.map(day => {
  const item = history.value?.items.find(item => item.day === day);
  const metric = item?.metrics.find(metric => metric.key === metricKey.value && metric.scope === scope.value);
  const start = Date.parse(`${day}T00:00:00Z`);
  const windowMatches = metric?.period_start === null && metric.period_end === null
    ? metric.observed_at !== null && Date.parse(metric.observed_at) >= start && Date.parse(metric.observed_at) < start + 86_400_000
    : Date.parse(metric?.period_start ?? "") === start && Date.parse(metric?.period_end ?? "") === start + 86_400_000;
  // 单个图的单位固定；不把供应商异常或未采集日期绘成零。
  return { day, value: metric?.unit === metricUnit.value && windowMatches ? metric.value : null, periodStart: metric?.period_start ?? null, periodEnd: metric?.period_end ?? null, observedAt: metric?.observed_at ?? null };
}));
const unresolved = computed(() => operation.value?.status === "pending" || operation.value?.status === "unknown");
async function load(): Promise<void> {
  const request = ++generation;
  controller?.abort(); controller = new AbortController();
  loading.value = true; failed.value = false;
  try {
    const value = await apiRequest<History>(`${base}?days=${days.value}`, { signal: controller.signal });
    if (disposed || request !== generation) return;
    history.value = value;
    collectionUncertain.value = false;
    clearPendingRequestIntents("POST", `${base}/collect`);
    if (!metrics.value.some(metric => metric.value === metricKey.value)) metricKey.value = metrics.value[0]?.value ?? "d1_rows_read";
    if (!recentDays.value.some(day => day.value === backfillDay.value)) backfillDay.value = recentDays.value.at(-1)?.value ?? "";
  } catch { if (!disposed && request === generation) failed.value = true; }
  finally { if (!disposed && request === generation) loading.value = false; }
}
async function backfill(): Promise<void> {
  if (busy.value || loading.value || unresolved.value || collectionUncertain.value || !history.value?.enabled || !recentDays.value.some(day => day.value === backfillDay.value)) return;
  busy.value = true; failed.value = false;
  let dispatched = false;
  try {
    const connection = await apiRequest<{ latest_operation: HistoryOperation | null }>(controlBase);
    if (disposed) return;
    if (connection.latest_operation && ["pending", "unknown"].includes(connection.latest_operation.status)) { operation.value = connection.latest_operation; return; }
    dispatched = true;
    const value = await apiRequest<History>(`${base}/collect`, { method: "POST", body: { day: backfillDay.value }, idempotencyKey: crypto.randomUUID() });
    if (disposed) return;
    if (days.value === "30") history.value = value; else await load();
  } catch { if (!disposed) { failed.value = true; collectionUncertain.value = dispatched && hasUncertainWrite(`${base}/collect`); } }
  finally { if (!disposed) busy.value = false; }
}
watch(days, () => { void load(); });
watch(() => props.refreshGeneration, () => { operation.value = null; void load(); });
watch(scope, () => { if (!metrics.value.some(metric => metric.value === metricKey.value)) metricKey.value = metrics.value[0]?.value ?? "d1_rows_read"; });
onMounted(load);
onUnmounted(() => { disposed = true; generation++; controller?.abort(); });
</script>

<template>
  <section class="owner-section usage-history" aria-labelledby="usage-history-heading" :aria-busy="loading || busy">
    <div class="section-heading-row"><div><h2 id="usage-history-heading">{{ ui('Daily usage history', '每日用量历史') }}</h2><p>{{ ui('Complete UTC days; instance figures and account totals remain separate.', '完整 UTC 日统计；实例贡献与账户总量分别查看。') }}</p></div><UButton color="neutral" variant="outline" type="button" :disabled="loading || busy" @click="load">{{ ui('Read history', '读取历史') }}</UButton></div>
    <ErrorNotice v-if="failed" :error="ui('History could not be confirmed. Displayed history may be out of date; read it again before collecting.', '历史尚未确认。显示的历史可能已过期，请重新读取后再采集。')" />
    <p v-if="loading" class="muted-copy" role="status">{{ ui('Reading history…', '正在读取历史…') }}</p>
    <template v-if="history">
      <div class="history-configuration"><p>{{ history.enabled ? ui('History collection enabled', '历史采集已启用') : ui('History collection disabled', '历史采集已关闭') }} · {{ ui('Retention: 90 days', '保留 90 天') }}</p><a href="#connection-configuration-heading" @click="emit('settings', 'history_enabled')">{{ ui('Change history setting', '修改历史设置') }}</a></div>
      <p class="muted-copy">{{ history.enabled ? ui('Reading charts does not start background polling.', '读取图表不会启动后台轮询。') : ui('Use Usage settings above to enable collection. Reading charts does not enable collection.', '请在上方用量设置中启用采集。读取图表不会启用采集。') }}</p>
      <p v-if="unresolved" class="warning-panel" role="status">{{ ui('Configuration is not confirmed active. Verify the result in Usage settings before collecting again.', '尚未确认配置生效，请先在用量设置中核验结果，再采集。') }}</p>
      <p v-if="history.error" class="warning-panel">{{ history.error === 'not_configured' ? ui('Analytics authorization or fixed resource configuration is incomplete. Check the connection in Overview before collecting history.', '统计授权或固定资源配置不完整，请先检查概览中的连接，再采集历史。') : ui('Some daily observations could not be collected. Missing values remain unknown.', '部分每日观测尚未采集成功，缺失值保持未知。') }}</p>
      <div class="history-controls"><label>{{ ui('Window', '窗口') }}<USelect :disabled="busy" v-model="days" :items="[{value:'7',label:ui('7 days','7 天')},{value:'30',label:ui('30 days','30 天')},{value:'90',label:ui('90 days','90 天')}]" /></label><label>{{ ui('Scope', '统计范围') }}<USelect v-model="scope" :items="[{value:'instance',label:ui('Instance contribution','实例贡献')},{value:'account',label:ui('Account totals','账户总量')}]" /></label><label>{{ ui('Metric', '指标') }}<USelect v-model="metricKey" :items="metrics" :disabled="!metrics.length" /></label></div>
      <UsageHistoryChart v-if="metrics.length" :label="names[metricKey] ?? metricKey" :unit="unitLabel" :points="points" />
      <p v-else class="muted-copy">{{ ui('No recorded metrics for this scope. Missing history is not zero usage.', '此统计范围暂无记录指标，缺少历史不代表用量为零。') }}</p>
      <p class="muted-copy">{{ ui('Daily cumulative metrics cover midnight to the next midnight in UTC. Storage and object counts retain their actual observation times; they are not daily consumption or GB-month billing. Charts do not show remaining allowances.', '日累计指标覆盖 UTC 零点至次日零点。容量与对象数保留实际观测时间，不表示每日消耗或 GB-month 计费；图表不表示剩余额度。') }}</p>
      <p v-if="collectionUncertain" class="warning-panel" role="status">{{ ui('Collection result is unknown. Read history to confirm the current data before collecting again.', '采集结果未知，请先读取历史核对当前数据，再决定是否采集。') }}</p><form v-if="history.enabled" class="history-backfill" @submit.prevent="backfill"><label>{{ ui('Collect one missing or updated day (last 7 complete UTC days)', '补采一天（最近 7 个完整 UTC 日）') }}<USelect :disabled="loading || busy" v-model="backfillDay" :items="recentDays" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="loading || busy || unresolved || collectionUncertain || !backfillDay">{{ ui('Collect selected day', '采集所选日期') }}</UButton></form>
    </template>
  </section>
</template>

<style scoped>
.history-configuration { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.history-controls, .history-backfill { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-top: 20px; }
.history-controls label, .history-backfill label { display: grid; gap: 8px; }
.history-controls label { min-width: 160px; }
@media (max-width: 600px) { .history-controls label, .history-backfill label { width: 100%; } }
</style>
