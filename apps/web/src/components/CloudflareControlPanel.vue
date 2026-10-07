<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import CloudflareTokenForm from "./CloudflareTokenForm.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import type { RateLimitSettings, WriteResult } from "../types";

type Capability = "missing" | "unverified" | "verified" | "permission_denied" | "unavailable" | "target_mismatch" | "unsupported_contract";
type TokenKind = "configuration" | "control" | "analytics";
interface Target { account_id: string | null; worker_name: string | null; database_id: string | null; zone_id: string | null; hostname: string | null }
interface Operation {
  operation_id: string; kind: string; status: "pending" | "verified" | "failed" | "unknown"; version: number;
  baseline_version_id: string | null; result_version_id: string | null; deployment_id: string | null;
  failure_class: string | null; created_at: string; updated_at: string;
}
interface Connection {
  version: number; target: Target; configured: Record<TokenKind, boolean>;
  capabilities: Record<"configuration" | "notifications" | "waf" | "billing" | "analytics", Capability>;
  verified_at: string | null; budget: { status: "unsupported_contract"; dashboard_url: string; docs_url: string };
  latest_operation: Operation | null;
  configuration: Partial<Record<ConfigurationField, boolean | string | number | null>>;
}
interface Plan {
  plan_id: string; kind: "configuration" | "rate_limit"; version: number; baseline_version_id: string | null;
  baseline_deployment_id: string | null; target: Pick<Target, "account_id" | "worker_name" | "database_id">;
  before: Record<string, unknown>; after: Record<string, unknown>; created_at: string;
}
interface Notifications {
  status: string; available_alerts: { type: string; display_name: string; description: string }[];
  policies: { id: string; name: string; alert_type: string; enabled: boolean; emails: string[]; filters: Record<string, unknown> }[];
}
interface Waf {
  status: string; zone_id: string | null; hostname: string | null;
  owned_rule: { id: string; enabled: boolean; action: string; expression: string } | null;
  other_rule_count: number | null; protected: boolean;
}
type ConfigurationField = "history_enabled" | "analytics_enabled" | "billing_plan" | "billing_cycle_day" | "account_totals" | "warning_percent";
const props = withDefaults(defineProps<{ initialSetting?: ConfigurationField | null }>(), { initialSetting: null });
const base = "/api/v1/admin/cloudflare";
const connection = ref<Connection | null>(null);
const operation = ref<Operation | null>(null);
const notifications = ref<Notifications | null>(null);
const waf = ref<Waf | null>(null);
const rateSettings = ref<RateLimitSettings | null>(null);
const plan = ref<Plan | null>(null);
const loading = ref(false);
const busy = ref(false);
const failed = ref(false);
const uncertain = ref(false);
const readbackGeneration = ref(0);
const zone = ref("");
const rateScope = ref("instance");
const rateLimit = ref<string | number>("");
const ratePeriod = ref("");
const configurationField = ref<ConfigurationField>(props.initialSetting ?? "history_enabled");
const configurationValue = ref<string | number>("");
const configurationSelection = computed({ get: () => String(configurationValue.value), set: (value: string) => { configurationValue.value = value; } });
const validation = ref(false);
const readController = new AbortController();
let disposed = false;
let featureGeneration = 0;
let planGeneration = 0;
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const unresolved = computed(() => uncertain.value || operation.value?.status === "pending" || operation.value?.status === "unknown");
const fixedTargetReady = computed(() => Boolean(connection.value?.target.account_id && connection.value?.target.worker_name && connection.value?.target.database_id));
const writable = computed(() => fixedTargetReady.value && !loading.value && !busy.value && !failed.value && !unresolved.value);
const hasConfiguration = computed(() => connection.value?.capabilities.configuration === "verified");
const tokenKinds = computed(() => [
  { kind: "configuration" as const, label: ui("Worker configuration Token", "Worker 配置 Token"),
    description: ui("Use an account-owned Token for the displayed Account. Select Specified Workers → this existing Worker → Editor only; Editor includes code, deployment, and Secret management.", "使用页面目标账户的 account-owned Token；只选择 Specified Workers → 当前已存在的 Worker → Editor。Editor 包含代码修改、部署与 Secret 管理权。"),
    creationPath: ui("Manage Account → Account API Tokens → Create Token → Specified Workers → this Worker → Editor", "Manage Account → Account API Tokens → Create Token → Specified Workers → 当前 Worker → Editor"),
    creationUrl: "https://dash.cloudflare.com/?to=/:account/api-tokens", guideUrl: "https://developers.cloudflare.com/workers/authorization/workers/",
    note: ui("The creator needs account Super Administrator or API Token Provisioning authority. Do not add Token-management permissions to this Token.", "创建者需要账户 Super Administrator 或 API Token Provisioning 授权；不要因此给此业务 Token 添加 Token 管理权限。") },
  { kind: "control" as const, label: ui("Cloudflare feature Token", "Cloudflare 功能 Token"),
    description: ui("For notifications and billing, select Account → Notifications → Read and Billing → Read, restricted to the displayed Account. For WAF, add Zone → Zone → Read and Zone WAF → Read for this domain's verified Zone only, not all Zones. No Edit is needed.", "读取通知与账务时选择 Account → Notifications → Read、Billing → Read，Account Resources 只选页面目标账户。读取 WAF 时再选择 Zone → Zone → Read、Zone WAF → Read，Zone Resources 只选已核对的当前域名 Zone，不选全部 Zone；本页不需要 Edit。"),
    creationPath: "My Profile → API Tokens → Create Token → Create Custom Token",
    creationUrl: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/", guideUrl: "https://developers.cloudflare.com/fundamentals/api/reference/permissions/", note: "" },
  { kind: "analytics" as const, label: ui("Analytics Token", "统计 Token"),
    description: ui("Select Account → Account Analytics → Read and restrict Account Resources to the displayed Account. Saving first verifies the D1 analytics interface; other configured datasets are checked through subsequent usage reads.", "选择 Account → Account Analytics → Read，Account Resources 只选页面目标账户。保存时先核验 D1 统计接口；其他已配置数据集是否可用，以后续实际统计读取结果为准。"),
    creationPath: "Manage Account → Account API Tokens → Create Token → Custom token",
    creationUrl: "https://dash.cloudflare.com/?to=/:account/api-tokens", guideUrl: "https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/", note: "" },
]);
const rateScopes = computed(() => [
  { value: "instance", label: ui("Instance API", "实例 API") }, { value: "principal", label: ui("Single identity", "单一身份") },
  { value: "unauthenticated_sensitive", label: ui("Unauthenticated sensitive actions", "未认证敏感操作") },
  { value: "anonymous_login", label: ui("Anonymous login", "匿名登录") }, { value: "expensive_reads", label: ui("Counts & title search", "计数与标题搜索") },
]);
const configurationFields = computed(() => [
  { value: "history_enabled", label: ui("Daily usage history", "每日用量历史") }, { value: "analytics_enabled", label: ui("Analytics collection", "统计采集") },
  { value: "billing_plan", label: ui("Verified Workers/D1 plan", "已核实的 Workers/D1 方案") }, { value: "billing_cycle_day", label: ui("Billing start day (UTC)", "账期起始日（UTC）") },
  { value: "account_totals", label: ui("Account totals", "账户总量") }, { value: "warning_percent", label: ui("Usage reminder threshold (%)", "用量提醒阈值（%）") },
]);
const booleanOptions = computed(() => [{ value: "true", label: ui("Enable", "启用") }, { value: "false", label: ui("Disable", "停用") }]);
const currentConfiguration = computed(() => connection.value?.configuration?.[configurationField.value]);
const currentRate = computed(() => {
  const settings = rateSettings.value;
  if (!settings) return null;
  const value = rateScope.value === "anonymous_login" || rateScope.value === "expensive_reads"
    ? settings.cost_protection?.[rateScope.value]?.policy : settings.policies?.[rateScope.value as keyof RateLimitSettings["policies"]];
  return value && Number.isSafeInteger(value.limit) && value.limit > 0 && [10, 60].includes(value.period_seconds) ? value : null;
});
function configurationDraft(): void {
  const value = currentConfiguration.value;
  configurationValue.value = value === undefined ? "" : value === null ? (configurationField.value === "billing_plan" ? "unknown" : "") : String(value);
}
function rateDraft(): void {
  rateLimit.value = currentRate.value ? String(currentRate.value.limit) : "";
  ratePeriod.value = currentRate.value ? String(currentRate.value.period_seconds) : "";
}
function configurationText(value: boolean | string | number | null | undefined): string {
  return value === undefined || value === null ? ui("Unknown", "未知") : typeof value === "boolean" ? (value ? ui("Enabled", "启用") : ui("Disabled", "停用")) : String(value);
}
function status(value: string | undefined): string {
  const labels: Record<string, [string, string]> = {
    missing: ["Not configured", "未配置"], unverified: ["Not verified", "尚未核验"], verified: ["Verified", "核验通过"],
    permission_denied: ["Cloudflare permission denied", "Cloudflare 权限不足"], unavailable: ["Currently unavailable", "暂不可用"],
    target_mismatch: ["Target does not match this instance", "目标与本实例不一致"], unsupported_contract: ["Public API contract unconfirmed", "公开 API 合同尚未确认"],
    pending: ["Pending; verify the result", "处理中；请核验结果"], unknown: ["Result unknown; verify before another change", "结果未知；再次变更前请核验"],
    failed: ["Failed", "失败"], missing_receipt: ["Tool ownership receipt is missing", "缺少本工具归属回执"], ownership_missing: ["Tool ownership receipt is missing", "缺少本工具归属回执"],
  };
  const label = value ? labels[value] : null;
  return label ? ui(...label) : ui("Unknown", "未知");
}
function safeLink(value: string | undefined, fallback: string): string {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && ["dash.cloudflare.com", "developers.cloudflare.com"].includes(url.hostname) ? url.href : fallback; }
  catch { return fallback; }
}
async function load(): Promise<void> {
  loading.value = true; failed.value = false;
  try {
    const result = await apiRequest<Connection>(base, { signal: readController.signal });
    if (disposed) return;
    connection.value = result; operation.value = result.latest_operation; zone.value = result.target.zone_id ?? ""; configurationDraft();
  } catch { if (!disposed) failed.value = true; }
  finally { if (!disposed) loading.value = false; }
}
async function inspectFeatures(): Promise<void> {
  const request = ++featureGeneration;
  notifications.value = null; waf.value = null;
  const results = await Promise.allSettled([
    apiRequest<Notifications>(`${base}/notifications`, { signal: readController.signal }),
    apiRequest<Waf>(`${base}/waf`, { signal: readController.signal }),
    apiRequest<RateLimitSettings>("/api/v1/admin/rate-limit-settings", { signal: readController.signal }),
  ]);
  if (disposed || request !== featureGeneration) return;
  notifications.value = results[0].status === "fulfilled" ? results[0].value : { status: results[0].reason instanceof ApiProblem && results[0].reason.status === 403 ? "permission_denied" : "unavailable", available_alerts: [], policies: [] };
  waf.value = results[1].status === "fulfilled" ? results[1].value : { status: results[1].reason instanceof ApiProblem && results[1].reason.status === 403 ? "permission_denied" : "unavailable", zone_id: null, hostname: null, owned_rule: null, other_rule_count: null, protected: false };
  rateSettings.value = results[2].status === "fulfilled" ? results[2].value : null;
  if (results[2].status === "fulfilled") rateDraft();
}
async function verify(): Promise<void> {
  if (busy.value || loading.value) return;
  busy.value = true; failed.value = false; plan.value = null; planGeneration++;
  try {
    await load();
    if (disposed || failed.value || !connection.value) return;
    if (operation.value && ["pending", "unknown"].includes(operation.value.status)) {
      const result = await apiRequest<WriteResult<Operation>>(`${base}/operations/${encodeURIComponent(operation.value.operation_id)}/verify`, { method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
      if (disposed) return; operation.value = result.resource;
      if (["pending", "unknown"].includes(result.resource.status)) return;
    }
    const result = await apiRequest<WriteResult<Connection>>(`${base}/verify`, { method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
    if (disposed) return;
    connection.value = result.resource; operation.value = result.resource.latest_operation; zone.value = result.resource.target.zone_id ?? ""; configurationDraft();
    uncertain.value = false; readbackGeneration.value += 1;
    await inspectFeatures();
  } catch { if (!disposed) failed.value = true; }
  finally { if (!disposed) busy.value = false; }
}
async function saveToken(kind: string, token: string): Promise<void> {
  if (!writable.value || !connection.value) throw new Error("Readback required");
  busy.value = true; failed.value = false; plan.value = null;
  try {
    // 显式键使通用客户端不以含秘密的 body 生成待恢复签名。
    const result = await apiRequest<WriteResult<Operation>>(`${base}/secrets`, { method: "POST", body: { kind, token, expected_version: connection.value.version }, idempotencyKey: crypto.randomUUID() });
    if (disposed) return; operation.value = result.resource;
    await load();
    if (!disposed && !failed.value) await inspectFeatures();
  } catch { if (!disposed) { failed.value = true; uncertain.value = true; } throw new Error("Verification required"); }
  finally { if (!disposed) busy.value = false; }
}
async function saveZone(): Promise<void> {
  if (!writable.value || !connection.value) return;
  busy.value = true; failed.value = false; plan.value = null;
  try {
    const result = await apiRequest<WriteResult<Connection>>(`${base}/settings`, { method: "PATCH", body: { zone_id: zone.value.trim() || null, expected_version: connection.value.version } });
    if (!disposed) { connection.value = result.resource; operation.value = result.resource.latest_operation; await inspectFeatures(); }
  } catch { if (!disposed) failed.value = true; }
  finally { if (!disposed) busy.value = false; }
}
async function preview(kind: "rate_limit" | "configuration"): Promise<void> {
  if (!writable.value || !hasConfiguration.value || !connection.value) return;
  validation.value = false; plan.value = null;
  let body: Record<string, unknown>;
  if (kind === "rate_limit") {
    const limit = Number(rateLimit.value); const period = Number(ratePeriod.value);
    if (!String(rateLimit.value).trim() || !Number.isSafeInteger(limit) || limit < 1 || ![10, 60].includes(period)) { validation.value = true; return; }
    body = { scope: rateScope.value, limit, period_seconds: period, expected_version: connection.value.version };
  } else {
    const input = String(configurationValue.value);
    let value: boolean | string | number | null;
    if (["history_enabled", "analytics_enabled", "account_totals"].includes(configurationField.value)) {
      if (!["true", "false"].includes(input)) { validation.value = true; return; }
      value = input === "true";
    } else if (configurationField.value === "billing_plan") {
      if (!["unknown", "free", "paid"].includes(input)) { validation.value = true; return; }
      value = input === "unknown" ? null : input;
    } else {
      value = input.trim() === "" && configurationField.value === "billing_cycle_day" ? null : Number(input);
      if (value !== null && (!input.trim() || !Number.isSafeInteger(value) || value < 1 || value > (configurationField.value === "billing_cycle_day" ? 31 : 100))) { validation.value = true; return; }
    }
    body = { settings: { [configurationField.value]: value }, expected_version: connection.value.version };
  }
  const request = ++planGeneration;
  busy.value = true; failed.value = false;
  try {
    const result = await apiRequest<WriteResult<Plan>>(`${base}/${kind === "rate_limit" ? "rate-limits" : "configuration"}/plan`, { method: "POST", body });
    if (!disposed) {
      if (connection.value) connection.value.version = result.resource.version;
      if (request === planGeneration) plan.value = result.resource;
    }
  } catch { if (!disposed) failed.value = true; }
  finally { if (!disposed) busy.value = false; }
}
async function apply(): Promise<void> {
  const current = plan.value;
  if (!current || !writable.value || !hasConfiguration.value) return;
  busy.value = true; failed.value = false; plan.value = null;
  try {
    const result = await apiRequest<WriteResult<Operation>>(`${base}/${current.kind === "rate_limit" ? "rate-limits" : "configuration"}/apply`, { method: "POST", body: { plan_id: current.plan_id, expected_version: current.version } });
    if (disposed) return; operation.value = result.resource; await load();
    if (!disposed && !failed.value) await inspectFeatures();
  } catch { if (!disposed) { failed.value = true; uncertain.value = true; } }
  finally { if (!disposed) busy.value = false; }
}
watch(configurationField, () => { configurationDraft(); validation.value = false; plan.value = null; planGeneration++; });
watch(rateScope, rateDraft);
watch([rateScope, rateLimit, ratePeriod, configurationValue], () => { plan.value = null; planGeneration++; });
onMounted(async () => { await load(); if (!disposed && connection.value) await inspectFeatures(); });
onUnmounted(() => { disposed = true; readController.abort(); });
</script>

<template>
  <section class="owner-section cloudflare-control" aria-labelledby="cloudflare-connection-heading" :aria-busy="loading || busy">
    <div class="section-heading-row"><div><h2 id="cloudflare-connection-heading">{{ ui('Cloudflare connection', 'Cloudflare 连接') }}</h2><p>{{ ui('Connect this instance and verify the current Cloudflare state.', '为本实例配置连接，并核验当前 Cloudflare 状态。') }}</p></div><UButton color="neutral" variant="outline" type="button" :disabled="loading || busy" @click="verify">{{ ui('Verify current state', '核验当前状态') }}</UButton></div>
    <ErrorNotice v-if="failed" :error="ui('The request could not be confirmed. Verify the current state before making another change. Token inputs are not restored.', '请求尚未确认。请先核验当前状态，再进行其他变更；Token 输入不会恢复。')" />
    <p v-if="loading" role="status" class="muted-copy">{{ ui('Reading connection…', '正在读取连接…') }}</p>
    <template v-if="connection">
      <dl class="connection-target"><div><dt>{{ ui('Target account', '目标账户') }}</dt><dd>{{ connection.target.account_id ?? ui('Unknown', '未知') }}</dd></div><div><dt>{{ ui('Target Worker', '目标 Worker') }}</dt><dd>{{ connection.target.worker_name ?? ui('Unknown', '未知') }}</dd></div><div><dt>{{ ui('Database', '数据库') }}</dt><dd>{{ connection.target.database_id ?? ui('Unknown', '未知') }}</dd></div></dl>
      <p class="muted-copy">{{ ui('These targets belong to this instance and cannot be changed on this page.', '这些目标属于当前实例，不能在此页面更改。') }}</p>
      <p v-if="!fixedTargetReady" class="warning-panel">{{ ui('The deployment target is incomplete. Ask the deployment Agent to verify this instance first.', '部署目标不完整，请先让部署 Agent 核对当前实例。') }}</p>
      <section class="connection-section" aria-labelledby="connection-tokens-heading">
        <h3 id="connection-tokens-heading">{{ ui('Tokens stored in Worker Secrets', '保存到 Worker Secret 的 Token') }}</h3>
        <p class="muted-copy">{{ ui('Inputs are cleared after submission. Tokens are not shown again or saved in this browser. A saved Secret is not proof that its deployment is active.', '提交后输入会清空；Token 不会再次显示，也不会保存在此浏览器中。已保存 Secret 不等于部署已生效。') }}</p>
        <p class="muted-copy">{{ ui('These are authorization purposes. A compatible Token can serve multiple purposes; each is verified separately.', '这些是授权用途；兼容的同一 Token 可用于多个用途，每项分别核验。') }}</p>
        <p class="muted-copy">{{ ui('Start with the configuration Token and verify it, then save each feature or analytics Token separately. Select the exact Account shown above in Cloudflare.', '先保存并核验配置 Token，再分别保存功能或统计 Token；在 Cloudflare 选择上方显示的准确账户。') }}</p>
        <div v-for="entry in tokenKinds" :key="entry.kind">
          <p class="token-current">{{ entry.label }}: {{ connection.configured[entry.kind] ? ui('Secret configured', '已配置 Secret') : ui('Not configured', '未配置') }} · {{ status(connection.capabilities[entry.kind === 'control' ? 'notifications' : entry.kind]) }}</p>
          <p class="token-creation-path">{{ entry.creationPath }} · <a :href="entry.creationUrl" target="_blank" rel="noopener noreferrer">{{ entry.kind === 'control' ? ui('Token creation guide', 'Token 创建指南') : ui('Open Account API Tokens', '打开 Account API Tokens') }}</a> · <a :href="entry.guideUrl" target="_blank" rel="noopener noreferrer">{{ ui('Official permissions guide', '官方权限说明') }}</a></p>
          <p v-if="entry.note" class="muted-copy">{{ entry.note }}</p>
          <CloudflareTokenForm :key="`${entry.kind}:${readbackGeneration}`" :kind="entry.kind" :label="entry.label" :description="entry.description" :disabled="!writable || (entry.kind !== 'configuration' && !hasConfiguration)" :save="saveToken" @verify="verify" />
        </div>
        <p class="muted-copy">{{ ui('For rotation, verify the replacement before revoking the old Token in Cloudflare. If configuration authorization is lost, use the deployment recovery guide.', '轮换时应先核验替代 Token，再到 Cloudflare 撤销旧 Token。配置授权失效时，请按部署恢复指南处理。') }} <a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Permissions and recovery guide', '权限与恢复指南') }}</a></p>
      </section>
      <section v-if="operation" class="connection-section" aria-labelledby="connection-operation-heading"><h3 id="connection-operation-heading">{{ ui('Latest configuration operation', '最近配置操作') }}</h3><p role="status">{{ status(operation.status) }}</p><dl class="connection-target"><div><dt>{{ ui('Operation', '操作') }}</dt><dd>{{ operation.operation_id }}</dd></div><div v-if="operation.result_version_id"><dt>{{ ui('Result version', '结果版本') }}</dt><dd>{{ operation.result_version_id }}</dd></div></dl><p v-if="operation.status !== 'verified'" class="muted-copy">{{ ui('The configuration is not confirmed active. Use Verify current state; do not replay the change blindly.', '尚未确认配置生效。请核验当前状态，不要盲目重发变更。') }}</p></section>
      <section class="connection-section" aria-labelledby="connection-configuration-heading">
        <h3 id="connection-configuration-heading">{{ ui('Usage configuration', '用量统计配置') }}</h3><p class="muted-copy">{{ ui('Choose one setting, preview its change, then apply the displayed Worker deployment plan.', '选择一项设置，预览变更后再应用所显示的 Worker 部署计划。') }}</p><p class="muted-copy">{{ ui('Current value', '当前值') }}: {{ configurationText(currentConfiguration) }}</p>
        <form class="control-form" @submit.prevent="preview('configuration')"><label>{{ ui('Setting', '设置项') }}<USelect :disabled="!writable || !hasConfiguration" v-model="configurationField" :items="configurationFields" /></label><label>{{ ui('New value', '新值') }}<USelect v-if="['history_enabled', 'analytics_enabled', 'account_totals'].includes(configurationField)" :disabled="!writable || !hasConfiguration" v-model="configurationSelection" :items="booleanOptions" :placeholder="ui('Choose…', '请选择…')" /><USelect v-else-if="configurationField === 'billing_plan'" :disabled="!writable || !hasConfiguration" v-model="configurationSelection" :placeholder="ui('Choose…','请选择…')" :items="[{value:'unknown',label:ui('Unknown','未知')},{value:'free',label:'Free'},{value:'paid',label:'Paid'}]" /><UInput v-else :disabled="!writable || !hasConfiguration" v-model="configurationValue" type="number" min="1" :max="configurationField === 'billing_cycle_day' ? 31 : 100" step="1" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable || !hasConfiguration">{{ ui('Preview configuration plan', '预览配置计划') }}</UButton></form>
      </section>
      <section class="connection-section" aria-labelledby="connection-rate-heading">
        <h3 id="connection-rate-heading">{{ ui('Native request limits', '原生访问频率限制') }}</h3><p class="muted-copy">{{ ui('Bindings and their displayed settings are updated together. Limits are best-effort and do not cap charges.', '实际 binding 与显示设置会一起更新。限流按最佳努力执行，不封顶费用。') }}</p><p class="muted-copy">{{ ui('Current Worker configuration', '当前 Worker 配置') }}: {{ currentRate ? `${currentRate.limit} / ${currentRate.period_seconds} ${ui('seconds', '秒')}` : ui('Unknown', '未知') }}. {{ ui('The plan also checks the live native binding.', '计划还会核对实际原生 binding。') }}</p>
        <form class="control-form" @submit.prevent="preview('rate_limit')"><label>{{ ui('Scope', '范围') }}<USelect :disabled="!writable || !hasConfiguration" v-model="rateScope" :items="rateScopes" /></label><label>{{ ui('Positive integer limit', '正整数次数') }}<UInput :disabled="!writable || !hasConfiguration" v-model="rateLimit" type="number" min="1" step="1" /></label><label>{{ ui('Window', '窗口') }}<USelect :disabled="!writable || !hasConfiguration" v-model="ratePeriod" :placeholder="ui('Choose…','请选择…')" :items="[{value:'10',label:ui('10 seconds','10 秒')},{value:'60',label:ui('60 seconds','60 秒')}]" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable || !hasConfiguration">{{ ui('Preview rate-limit plan', '预览限流计划') }}</UButton></form>
      </section>
      <p v-if="validation" class="warning-panel" role="alert">{{ ui('Choose a value within the displayed range. Request limits require a positive integer and a 10- or 60-second window.', '请选择显示范围内的值；访问限制必须为正整数，窗口只能为 10 或 60 秒。') }}</p>
      <section v-if="plan" class="connection-section configuration-plan" aria-labelledby="connection-plan-heading"><h3 id="connection-plan-heading">{{ ui('Review the deployment plan', '核对部署计划') }}</h3><p>{{ plan.target.worker_name }} · {{ plan.target.account_id }}</p><div class="plan-comparison"><div><h4>{{ ui('Before', '变更前') }}</h4><pre>{{ JSON.stringify(plan.before, null, 2) }}</pre></div><div><h4>{{ ui('After', '变更后') }}</h4><pre>{{ JSON.stringify(plan.after, null, 2) }}</pre></div></div><p class="muted-copy">{{ ui('Applying publishes a Worker version. The server rechecks the target and baseline; success requires verified readback.', '应用会发布 Worker 版本；服务端重新核对目标与基线，核验读回成功才确认生效。') }}</p><UButton color="primary" variant="solid" type="button" :disabled="!writable || !hasConfiguration" @click="apply">{{ ui('Apply this plan', '应用此计划') }}</UButton></section>
      <section class="connection-section" aria-labelledby="connection-budget-heading"><h3 id="connection-budget-heading">{{ ui('Cloudflare USD budget alerts', 'Cloudflare USD 预算警报') }}</h3><p>{{ status(connection.budget.status) }}</p><p class="muted-copy">{{ ui('The public API contract does not confirm USD budget thresholds or recipient editing. This page cannot manage those budgets. Notification policy fields must not be interpreted as a USD budget.', '公开 API 合同尚未确认 USD 预算阈值或收件人编辑能力，本页不能管理此类预算。通知策略字段不能被解释为 USD 预算。') }}</p><a :href="safeLink(connection.budget.dashboard_url, 'https://dash.cloudflare.com/')" target="_blank" rel="noopener noreferrer">{{ ui('Manage budgets in Cloudflare', '在 Cloudflare 管理预算') }}</a> · <a :href="safeLink(connection.budget.docs_url, 'https://developers.cloudflare.com/billing/manage/budget-alerts/')" target="_blank" rel="noopener noreferrer">{{ ui('Budget Alerts guide', '预算警报指南') }}</a></section>
      <section class="connection-section" aria-labelledby="connection-notifications-heading"><h3 id="connection-notifications-heading">{{ ui('Cloudflare notification policies', 'Cloudflare 通知策略') }}</h3><p role="status">{{ status(notifications?.status) }}</p><p class="muted-copy">{{ ui('Live read-only policies and email recipients are visible only to the Owner. They do not confirm a USD budget configuration.', '仅 Owner 可查看实时只读策略及收件邮件；这些数据不代表已核实 USD 预算配置。') }}</p><ul v-if="notifications?.policies.length" class="notification-policies"><li v-for="policy in notifications.policies" :key="policy.id"><strong>{{ policy.name }}</strong> · {{ policy.enabled ? ui('Enabled','启用') : ui('Disabled','停用') }}<p>{{ policy.alert_type }}</p><p>{{ policy.emails.join(', ') || ui('No email recipient reported','未返回收件邮件') }}</p></li></ul><p v-else-if="notifications?.status === 'verified'" class="muted-copy">{{ ui('No notification policies returned.', '未返回通知策略。') }}</p></section>
      <section class="connection-section" aria-labelledby="connection-waf-heading"><h3 id="connection-waf-heading">{{ ui('Domain & access protection', '域名与访问防护') }}</h3><form class="control-form" @submit.prevent="saveZone"><label>{{ ui('Zone ID for this domain', '此域名的 Zone ID') }}<UInput :disabled="!writable" v-model="zone" autocomplete="off" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable">{{ ui('Save Zone selection', '保存 Zone 选择') }}</UButton></form><p role="status">{{ status(waf?.status) }}</p><p>{{ waf?.hostname ?? connection.target.hostname ?? ui('Hostname unknown', '域名未知') }}</p><p v-if="waf?.protected">{{ ui('The tool-owned exact-hostname blocking rule is verified active.', '已核验本工具拥有的准确域名阻止规则生效。') }}</p><p v-else class="muted-copy">{{ ui('No active tool-owned blocking rule is confirmed. Other Cloudflare protection may exist. Token permission and a domain ownership receipt are separate requirements.', '尚未确认本工具拥有的阻止规则生效；Cloudflare 可能另有防护。Token 权限与域名归属回执是独立条件。') }}</p><dl v-if="waf?.owned_rule" class="connection-target"><div><dt>{{ ui('Tool-owned custom rule', '本工具自有自定义规则') }}</dt><dd>{{ waf.owned_rule.id }} · {{ waf.owned_rule.enabled ? ui('Enabled', '启用') : ui('Disabled', '停用') }}</dd></div><div><dt>{{ ui('Action', '动作') }}</dt><dd>{{ waf.owned_rule.action }}</dd></div></dl><p class="muted-copy">{{ ui('A legacy domain without a tool ownership receipt needs an explicit connection plan. Keep the domain; do not delete and recreate it. Zone rules do not protect workers.dev.', '旧域名缺少本工具归属回执时，需明确接入计划；保留现有域名，无需删除重建。Zone 规则不保护 workers.dev。') }}</p><a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Domain and protection guide', '域名与防护指南') }}</a></section>
    </template>
  </section>
</template>

<style scoped>
.connection-target { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 16px 0; }
.connection-target dt { color: var(--color-text-muted); font-size: 13px; }
.connection-target dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.connection-section { padding-top: 24px; margin-top: 24px; border-top: 1px solid var(--color-border); }
.connection-section h3 { margin: 0 0 12px; }
.control-form { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.control-form label { display: grid; gap: 8px; min-width: 180px; }
.token-current { margin: 16px 0 0; }
.token-creation-path { overflow-wrap: anywhere; }
.plan-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.plan-comparison pre { overflow-x: auto; padding: 12px; background: var(--color-surface-muted); font-size: 13px; }
.notification-policies { padding-left: 20px; }
.notification-policies li { padding: 8px 0; }
.notification-policies p { margin: 4px 0; overflow-wrap: anywhere; }
@media (max-width: 600px) { .connection-target, .plan-comparison { grid-template-columns: 1fr; } .control-form label { width: 100%; } }
</style>
