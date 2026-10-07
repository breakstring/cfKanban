<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import CloudflareTokenForm from "./CloudflareTokenForm.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import type { RateLimitSettings, WriteResult } from "../types";

type Capability = "missing" | "unverified" | "verified" | "permission_denied" | "unavailable" | "target_mismatch" | "unsupported_contract";
type TokenKind = "connection" | "configuration" | "control" | "analytics";
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
const props = withDefaults(defineProps<{ mode?: "overview" | "usage"; initialSetting?: ConfigurationField | null; settingRequest?: number }>(), { mode: "overview", initialSetting: null, settingRequest: 0 });
const emit = defineEmits<{ applied: []; rates: [value: RateLimitSettings] }>();
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
const showNotifications = ref(false);
const showWaf = ref(false);
const featureLoading = ref(false);
const connectionManagementOpen = ref(false);
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
const hasConfigurationAuthorization = computed(() => Boolean(connection.value?.configured.connection || connection.value?.configured.configuration));
const hasAnalyticsAuthorization = computed(() => Boolean(connection.value?.configured.connection || connection.value?.configured.analytics));
const connectionAction = computed(() => {
  if (!connection.value || unresolved.value) return "verify";
  if (!hasConfigurationAuthorization.value || connection.value?.capabilities.configuration === "missing") return "connect";
  return ["permission_denied", "target_mismatch"].includes(connection.value?.capabilities.configuration ?? "") ? "replace" : "verify";
});
const connectionSummary = computed(() => {
  if (unresolved.value) return ui("Connection change awaiting verification", "连接变更待核验");
  if (connectionAction.value === "connect") return connection.value?.capabilities.analytics === "verified"
    ? ui("Usage is available; settings cannot be changed yet", "统计可用，尚不能修改设置")
    : hasAnalyticsAuthorization.value ? ui("Usage authorization is saved; settings are not connected", "已保存统计授权，尚不能修改设置") : ui("Not connected", "尚未连接");
  const capability = connection.value?.capabilities.configuration;
  if (capability === "unverified") return ui("Connection awaiting verification", "连接待核验");
  if (capability === "permission_denied") return ui("Connection permission denied", "连接权限不足");
  if (capability === "target_mismatch") return ui("Connection target does not match", "连接目标不一致");
  if (capability === "unavailable") return ui("Connection temporarily unavailable", "连接暂不可用");
  return connection.value?.configured.connection ? ui("Connection saved", "连接已保存") : ui("Using existing authorization", "正在使用现有授权");
});
const connectionNextStep = computed(() => {
  if (unresolved.value) return "";
  if (connectionAction.value === "connect") return props.mode === "usage"
    ? ui("To change settings, create and enter a Token with settings permissions in Overview.", "要修改设置，请先在概览中创建并输入具有设置修改权限的 Token。")
    : ui("To change settings, create a Token with settings permissions and enter it below.", "要修改设置，请先创建具有设置修改权限的 Token，并在下方输入以连接 Cloudflare。");
  if (connectionAction.value === "replace") return props.mode === "usage"
    ? ui("Review or replace the connection Token in Overview before changing settings.", "修改设置前，请先在概览中检查或替换连接 Token。")
    : ui("This Token cannot change the current settings. Check the permissions in the creation guide or enter a replacement Token below.", "当前 Token 无法修改设置。请按创建指南检查权限，或在下方输入具有所需权限的替代 Token。");
  if (connection.value?.capabilities.configuration === "unverified") return ui("The connection is saved. Verify it before changing settings.", "连接已保存，请先核验连接；核验通过后才能修改设置。");
  if (!hasConfiguration.value) return ui("The connection cannot be verified right now. Check it again before changing settings.", "暂时无法核验连接，请重新核验后再修改设置。");
  return "";
});
const capabilities = computed(() => [
  { key: "configuration" as const, label: ui("Change settings", "修改设置") },
  { key: "analytics" as const, label: ui("View usage", "查看用量") },
]);
const visibleCapabilities = computed(() => props.mode === "overview" ? capabilities.value
  : capabilities.value.filter(entry => connection.value?.capabilities[entry.key] !== "verified"));
const usageNextStep = computed(() => {
  if (props.mode !== "usage" || !hasConfiguration.value || unresolved.value) return "";
  const capability = connection.value?.capabilities.analytics;
  if (capability === "missing") return ui("Usage access is not connected. Check the connection in Overview.", "用量读取尚未连接，请在概览中检查连接。");
  if (capability === "unverified") return ui("Usage access has not been verified. Verify the connection before reading usage.", "用量读取权限尚未核验，请先核验连接。");
  if (capability === "permission_denied" || capability === "target_mismatch") return ui("Usage access could not be authorized. Review or replace the connection Token in Overview.", "当前连接无法读取用量，请在概览中检查或替换连接 Token。");
  if (capability && capability !== "verified") return ui("Usage access is currently unavailable. Verify the connection again later.", "用量读取暂不可用，请稍后重新核验连接。");
  return "";
});
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
  return value === undefined || value === null ? ui("Unknown", "未知") : typeof value === "boolean" ? (value ? ui("Enabled", "启用") : ui("Disabled", "停用")) : value === "free" ? "Free" : value === "paid" ? "Paid" : String(value);
}
const planRows = computed(() => {
  const current = plan.value;
  if (!current) return [];
  if (current.kind === "rate_limit") {
    return [{ label: rateScopes.value.find(item => item.value === current.after.scope)?.label ?? rateScopes.value.find(item => item.value === rateScope.value)?.label ?? ui("Request frequency limit", "访问频率限制"),
      before: rateText(current.before), after: rateText(current.after) }];
  }
  return configurationFields.value.filter(field => Object.hasOwn(current.after, field.value))
    .map(field => ({ label: field.label, before: configurationText(current.before[field.value] as boolean | string | number | null), after: configurationText(current.after[field.value] as boolean | string | number | null) }));
});
function rateText(value: Record<string, unknown>): string {
  return typeof value.limit === "number" && typeof value.period_seconds === "number" ? `${value.limit} / ${value.period_seconds} ${ui("seconds", "秒")}` : ui("Unknown", "未知");
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
async function openConnectionForm(): Promise<void> {
  connectionManagementOpen.value = true;
  await nextTick();
  document.getElementById?.("cloudflare-token-connection")?.focus();
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
  const readNotifications = showNotifications.value;
  const readWaf = showWaf.value;
  if (!readNotifications && !readWaf) return;
  featureLoading.value = true;
  const results = await Promise.allSettled([
    readNotifications ? apiRequest<Notifications>(`${base}/notifications`, { signal: readController.signal }) : Promise.resolve(null),
    readWaf ? apiRequest<Waf>(`${base}/waf`, { signal: readController.signal }) : Promise.resolve(null),
  ]);
  if (disposed || request !== featureGeneration) return;
  if (readNotifications) notifications.value = results[0].status === "fulfilled" ? results[0].value : { status: results[0].reason instanceof ApiProblem && results[0].reason.status === 403 ? "permission_denied" : "unavailable", available_alerts: [], policies: [] };
  if (readWaf) waf.value = results[1].status === "fulfilled" ? results[1].value : { status: results[1].reason instanceof ApiProblem && results[1].reason.status === 403 ? "permission_denied" : "unavailable", zone_id: null, hostname: null, owned_rule: null, other_rule_count: null, protected: false };
  featureLoading.value = false;
}
async function loadRates(): Promise<void> {
  try {
    const result = await apiRequest<RateLimitSettings>("/api/v1/admin/rate-limit-settings", { signal: readController.signal });
    if (disposed) return;
    rateSettings.value = result; rateDraft(); emit("rates", result);
  } catch { if (!disposed) rateSettings.value = null; }
}
function toggleFeature(kind: "notifications" | "waf", event: Event): void {
  const opened = (event.target as HTMLDetailsElement).open;
  if (kind === "notifications") showNotifications.value = opened; else showWaf.value = opened;
  if (opened) void inspectFeatures();
}
async function verifyCapabilities(): Promise<void> {
  const result = await apiRequest<WriteResult<Connection>>(`${base}/verify`, { method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
  if (disposed) return;
  connection.value = result.resource; operation.value = result.resource.latest_operation; zone.value = result.resource.target.zone_id ?? ""; configurationDraft();
  uncertain.value = false; readbackGeneration.value += 1;
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
    await verifyCapabilities();
    if (disposed) return;
    if (props.mode === "overview") await loadRates();
    await inspectFeatures();
    if (!disposed && !unresolved.value) emit("applied");
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
    if (!disposed && !failed.value) {
      if (operation.value?.status === "verified") await verifyCapabilities();
      if (disposed) return;
      if (props.mode === "overview") await loadRates(); await inspectFeatures(); if (!disposed && !unresolved.value) emit("applied");
    }
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
    if (!disposed && !failed.value) { if (props.mode === "overview") await loadRates(); await inspectFeatures(); if (!disposed && !unresolved.value) emit("applied"); }
  } catch { if (!disposed) { failed.value = true; uncertain.value = true; } }
  finally { if (!disposed) busy.value = false; }
}
watch(configurationField, () => { configurationDraft(); validation.value = false; plan.value = null; planGeneration++; });
watch([hasConfigurationAuthorization, () => connection.value?.capabilities.configuration], () => {
  if (!unresolved.value) connectionManagementOpen.value = connectionAction.value === "connect" || connectionAction.value === "replace";
}, { immediate: true });
watch(() => props.initialSetting, value => { if (value) configurationField.value = value; });
watch(() => props.settingRequest, () => { if (props.initialSetting) configurationField.value = props.initialSetting; });
watch(rateScope, rateDraft);
watch([rateScope, rateLimit, ratePeriod, configurationValue], () => { plan.value = null; planGeneration++; });
watch(() => props.mode, mode => {
  plan.value = null; validation.value = false; planGeneration++; featureGeneration++;
  showNotifications.value = false; showWaf.value = false; featureLoading.value = false;
  if (mode === "overview" && connection.value) void loadRates();
});
onMounted(async () => { await load(); if (!disposed && connection.value && props.mode === "overview") await loadRates(); });
onUnmounted(() => { disposed = true; readController.abort(); });
</script>

<template>
  <section class="owner-section cloudflare-control" :aria-labelledby="mode === 'overview' ? 'cloudflare-connection-heading' : 'connection-configuration-heading'" :aria-busy="loading || busy">
    <div class="section-heading-row">
      <div><h2 v-if="mode === 'overview'" id="cloudflare-connection-heading">{{ ui('Cloudflare connection', 'Cloudflare 连接') }}</h2><h2 v-else id="connection-configuration-heading">{{ ui('Usage settings', '用量设置') }}</h2><p>{{ mode === 'overview' ? ui('Save one Token for settings changes and usage collection. Each capability is verified separately.', '保存一个 Token，供设置修改与用量采集共用；各项能力分别核验。') : ui('Usage collection uses the connection saved in Overview. Change one setting at a time.', '用量采集使用概览中保存的连接，每次修改一项设置。') }}</p></div>
      <UButton v-if="mode === 'overview' && connectionAction !== 'verify'" color="neutral" variant="outline" type="button" :disabled="loading || busy" @click="openConnectionForm">{{ connectionAction === 'connect' ? ui('Connect Cloudflare', '连接 Cloudflare') : ui('Check or replace Token', '检查或替换 Token') }}</UButton>
      <a v-else-if="mode === 'usage' && connectionAction !== 'verify'" href="/app/admin">{{ connectionAction === 'connect' ? ui('Connect in Overview', '在概览中连接') : ui('Review connection in Overview', '在概览中检查连接') }}</a>
      <UButton v-else color="neutral" variant="outline" type="button" :disabled="loading || busy" @click="verify">{{ !unresolved && connection?.capabilities.configuration === 'unverified' ? ui('Verify connection', '核验连接') : ui('Verify current state', '核验当前状态') }}</UButton>
    </div>
    <ErrorNotice v-if="failed" :error="ui('The request could not be confirmed. Verify the current state before making another change. Token inputs are not restored.', '请求尚未确认。请先核验当前状态，再进行其他变更；Token 输入不会恢复。')" />
    <p v-if="loading" role="status" class="muted-copy">{{ ui('Reading connection…', '正在读取连接…') }}</p>
    <template v-if="connection">
      <p v-if="mode === 'overview'" class="connection-summary" role="status"><strong>{{ connectionSummary }}</strong><span v-if="connection.target.worker_name"> · {{ connection.target.worker_name }}</span></p>
      <dl v-if="visibleCapabilities.length" class="connection-capabilities"><div v-for="entry in visibleCapabilities" :key="entry.key"><dt>{{ entry.label }}</dt><dd>{{ status(connection.capabilities[entry.key]) }}</dd></div></dl>
      <p v-if="connectionNextStep" class="muted-copy connection-next-step">{{ connectionNextStep }}</p>
      <p v-if="usageNextStep" class="muted-copy connection-next-step">{{ usageNextStep }}</p>
      <p v-if="!fixedTargetReady" class="warning-panel">{{ ui('The deployment target is incomplete. Ask the deployment Agent to verify this instance first.', '部署目标不完整，请先让部署 Agent 核对当前实例。') }}</p>
      <p v-if="mode === 'usage' && connectionAction === 'verify'" class="muted-copy"><a href="/app/admin">{{ ui('Manage Cloudflare connection in Overview', '在概览中管理 Cloudflare 连接') }}</a></p>
      <details v-if="mode === 'overview'" class="connection-management" :open="connectionManagementOpen" @toggle="connectionManagementOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ connectionAction === 'connect' ? ui('Connect Cloudflare', '连接 Cloudflare') : connectionAction === 'replace' ? ui('Check connection permissions', '检查连接权限') : ui('Manage connection', '管理连接') }}</summary>
        <section aria-labelledby="connection-tokens-heading">
          <h3 id="connection-tokens-heading">{{ ui('Cloudflare API Token', 'Cloudflare API Token') }}</h3>
          <p v-if="hasConfigurationAuthorization && !connection.configured.connection" class="muted-copy">{{ ui('Existing authorization remains available. Saving one connection Token replaces it for these settings and statistics.', '现有授权仍可使用；保存统一连接 Token 后，这些设置与统计将共用新连接。') }}</p>
          <CloudflareTokenForm :key="`connection:${readbackGeneration}`" kind="connection" :label="ui('Connection Token', '连接 Token')" :description="ui('Encrypted and saved in Cloudflare, not in this browser. Saving updates the current instance configuration and clears the input; the Token is never shown again.', 'Token 将加密保存到 Cloudflare，不保存在浏览器。保存会更新当前实例配置并清空输入，Token 不会再次显示。')" :disabled="!writable" :save="saveToken" @verify="verify" />
          <details class="connection-guide">
            <summary>{{ ui('Create a Token and check permissions', '创建 Token 与核对权限') }}</summary>
            <p>{{ ui('In Manage Account → Account API Tokens → Create Token, choose the target account shown below. Use an account-owned Token with Specified Workers → this existing Worker → Editor, plus Account → Account Analytics → Read for usage collection. Editor includes code, deployment, and Secret management. The Token is stored in a Worker Secret.', '在 Manage Account → Account API Tokens → Create Token 中选择下方目标账户。使用 account-owned Token，配置 Specified Workers → 当前已存在的 Worker → Editor，并为用量采集添加 Account → Account Analytics → Read。Editor 包含代码修改、部署与 Secret 管理权；Token 最终保存在 Worker Secret。') }}</p>
            <p>{{ ui('Notifications Read and Billing Read are optional. For WAF reads, select Zone Read and Zone WAF Read for this domain’s verified Zone only. Cloudflare Token support and actual permissions vary; optional capabilities may remain unavailable without blocking settings and statistics.', 'Notifications Read 与 Billing Read 是可选读取权限；读取 WAF 时，仅为当前域名已核对的 Zone 添加 Zone Read 和 Zone WAF Read。Cloudflare Token 支持范围及实际权限可能不同，可选能力不可用不影响设置与统计。') }}</p>
            <p class="muted-copy">{{ ui('The creator needs account Super Administrator or API Token Provisioning authority. Do not add Token-management permissions to the connection Token. Verify a replacement before revoking the old Token.', '创建者需要账户 Super Administrator 或 API Token Provisioning 授权；不要给连接 Token 添加 Token 管理权限。轮换时先核验新连接，再撤销旧 Token。') }}</p>
            <p><a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noopener noreferrer">{{ ui('Open Account API Tokens', '打开 Account API Tokens') }}</a> · <a href="https://developers.cloudflare.com/workers/authorization/workers/" target="_blank" rel="noopener noreferrer">{{ ui('Official permissions guide', '官方权限说明') }}</a> · <a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Permissions and recovery guide', '权限与恢复指南') }}</a></p>
            <dl class="connection-target"><div><dt>{{ ui('Target account', '目标账户') }}</dt><dd>{{ connection.target.account_id ?? ui('Unknown', '未知') }}</dd></div><div><dt>{{ ui('Target Worker', '目标 Worker') }}</dt><dd>{{ connection.target.worker_name ?? ui('Unknown', '未知') }}</dd></div><div><dt>{{ ui('Database', '数据库') }}</dt><dd>{{ connection.target.database_id ?? ui('Unknown', '未知') }}</dd></div></dl>
            <p class="muted-copy">{{ ui('These targets belong to this instance and cannot be changed on this page. A saved Secret alone does not confirm active deployment.', '这些目标属于当前实例，不能在此页面更改；仅保存 Secret 不表示部署已核验生效。') }}</p>
          </details>
        </section>
      </details>
      <section v-if="operation && (mode === 'overview' || operation.status !== 'verified')" class="connection-section" aria-labelledby="connection-operation-heading">
        <h3 id="connection-operation-heading">{{ ui('Latest settings change', '最近设置变更') }}</h3><p role="status">{{ status(operation.status) }}</p>
        <p v-if="operation.status !== 'verified'" class="muted-copy">{{ ui('The configuration is not confirmed active. Use Verify current state; do not replay the change blindly.', '尚未确认配置生效。请核验当前状态，不要盲目重发变更。') }}</p>
        <details><summary>{{ ui('Operation details', '操作详情') }}</summary><dl class="connection-target"><div><dt>{{ ui('Operation', '操作') }}</dt><dd>{{ operation.operation_id }}</dd></div><div v-if="operation.result_version_id"><dt>{{ ui('Result version', '结果版本') }}</dt><dd>{{ operation.result_version_id }}</dd></div></dl></details>
      </section>
      <details v-else-if="operation" class="connection-section" aria-labelledby="connection-operation-heading"><summary id="connection-operation-heading">{{ ui('Latest settings change details', '最近设置变更详情') }}</summary><p role="status">{{ status(operation.status) }}</p><dl class="connection-target"><div><dt>{{ ui('Operation', '操作') }}</dt><dd>{{ operation.operation_id }}</dd></div><div v-if="operation.result_version_id"><dt>{{ ui('Result version', '结果版本') }}</dt><dd>{{ operation.result_version_id }}</dd></div></dl></details>
      <section v-if="mode === 'usage'" class="connection-section usage-setting-editor" aria-labelledby="usage-setting-heading">
        <h3 id="usage-setting-heading">{{ ui('Change a usage setting', '修改用量设置') }}</h3><p class="muted-copy">{{ ui('Check your actual Workers/D1 plan and UTC billing start day in Cloudflare Billing before declaring them here. Account totals are optional; reminders do not cap charges. Preview each change; applying updates the current instance configuration in Cloudflare.', '请先在 Cloudflare 账单中核对实际 Workers/D1 方案和 UTC 账期起始日，再在此声明。账户汇总为可选项，提醒不会封顶费用。每次变更先预览，应用会在 Cloudflare 更新当前实例配置。') }}</p><p class="muted-copy">{{ ui('Current value', '当前值') }}: {{ configurationText(currentConfiguration) }}</p>
        <form class="control-form" @submit.prevent="preview('configuration')"><label>{{ ui('Setting', '设置项') }}<USelect :disabled="!writable || !hasConfiguration" v-model="configurationField" :items="configurationFields" /></label><label>{{ ui('New value', '新值') }}<USelect v-if="['history_enabled', 'analytics_enabled', 'account_totals'].includes(configurationField)" :disabled="!writable || !hasConfiguration" v-model="configurationSelection" :items="booleanOptions" :placeholder="ui('Choose…', '请选择…')" /><USelect v-else-if="configurationField === 'billing_plan'" :disabled="!writable || !hasConfiguration" v-model="configurationSelection" :placeholder="ui('Choose…','请选择…')" :items="[{value:'unknown',label:ui('Unknown','未知')},{value:'free',label:'Free'},{value:'paid',label:'Paid'}]" /><UInput v-else :disabled="!writable || !hasConfiguration" v-model="configurationValue" type="number" min="1" :max="configurationField === 'billing_cycle_day' ? 31 : 100" step="1" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable || !hasConfiguration">{{ ui('Preview configuration plan', '预览配置计划') }}</UButton></form>
      </section>
      <section v-if="mode === 'overview'" class="connection-section" aria-labelledby="connection-rate-heading">
        <h3 id="connection-rate-heading">{{ ui('Request frequency limits', '访问频率限制') }}</h3><p class="muted-copy">{{ ui('Choose one scope and preview the change. Applying updates the current instance configuration in Cloudflare. Limits may have brief discrepancies and do not cap charges.', '选择一个范围并预览变更；应用会在 Cloudflare 更新当前实例配置。限制可能存在短时误差，不能封顶费用。') }}</p><p class="muted-copy">{{ ui('Current limit', '当前限制') }}: {{ currentRate ? `${currentRate.limit} / ${currentRate.period_seconds} ${ui('seconds', '秒')}` : ui('Unknown', '未知') }}</p>
        <form class="control-form" @submit.prevent="preview('rate_limit')"><label>{{ ui('Scope', '范围') }}<USelect :disabled="!writable || !hasConfiguration" v-model="rateScope" :items="rateScopes" /></label><label>{{ ui('Maximum requests', '最多请求数') }}<UInput :disabled="!writable || !hasConfiguration" v-model="rateLimit" type="number" min="1" step="1" /></label><label>{{ ui('Duration', '统计时长') }}<USelect :disabled="!writable || !hasConfiguration" v-model="ratePeriod" :placeholder="ui('Choose…','请选择…')" :items="[{value:'10',label:ui('10 seconds','10 秒')},{value:'60',label:ui('60 seconds','60 秒')}]" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable || !hasConfiguration">{{ ui('Preview rate-limit plan', '预览限流计划') }}</UButton></form>
      </section>
      <p v-if="validation" class="warning-panel" role="alert">{{ ui('Choose a value within the displayed range. Maximum requests must be a positive integer and the duration must be 10 or 60 seconds.', '请选择显示范围内的值；最多请求数必须为正整数，统计时长只能为 10 或 60 秒。') }}</p>
      <section v-if="plan" class="connection-section configuration-plan" aria-labelledby="connection-plan-heading">
        <h3 id="connection-plan-heading">{{ ui('Review the change', '核对变更') }}</h3><p>{{ plan.target.worker_name }}</p>
        <table class="plan-comparison"><thead><tr><th>{{ ui('Setting', '设置项') }}</th><th>{{ ui('Before', '变更前') }}</th><th>{{ ui('After', '变更后') }}</th></tr></thead><tbody><tr v-for="row in planRows" :key="row.label"><th scope="row">{{ row.label }}</th><td>{{ row.before }}</td><td>{{ row.after }}</td></tr></tbody></table>
        <p class="muted-copy">{{ ui('Applying updates the current instance configuration in Cloudflare. The result must be verified before the change is confirmed active.', '应用会在 Cloudflare 更新当前实例配置，核验结果成功后才确认生效。') }}</p>
        <details class="connection-guide"><summary>{{ ui('Technical plan details', '计划技术详情') }}</summary><p>{{ plan.target.account_id }} · {{ plan.target.database_id }}</p><p>{{ ui('Baseline version', '基线版本') }}: {{ plan.baseline_version_id ?? ui('Unknown', '未知') }} · {{ ui('Deployment', '部署') }}: {{ plan.baseline_deployment_id ?? ui('Unknown', '未知') }}</p><pre>{{ JSON.stringify({ before: plan.before, after: plan.after }, null, 2) }}</pre></details>
        <UButton color="primary" variant="solid" type="button" :disabled="!writable || !hasConfiguration" @click="apply">{{ ui('Apply this plan', '应用此计划') }}</UButton>
      </section>
      <template v-if="mode === 'usage'">
        <h3 class="connection-section">{{ ui('Budget & optional reads', '预算与可选读取') }}</h3>
        <details class="connection-section" aria-labelledby="connection-budget-heading"><summary id="connection-budget-heading">{{ ui('Cloudflare USD budget alerts', 'Cloudflare USD 预算警报') }}</summary><p>{{ status(connection.budget.status) }}</p><p class="muted-copy">{{ ui('Cloudflare Budget Alerts notify selected email recipients about cumulative usage-based account charges. They are separate from cfKanban’s percentage-based allowance reminders and do not stop usage or cap charges. The public API contract does not confirm USD thresholds or recipient editing, so manage budgets in Cloudflare.', 'Cloudflare Budget Alerts 将账户累计按量费用提醒发送到指定邮件，与 cfKanban 按百分比计算的额度提醒独立，不会停止用量或封顶费用。公开 API 合同尚未确认 USD 阈值或收件人编辑能力，请在 Cloudflare 管理预算。') }}</p><a :href="safeLink(connection.budget.dashboard_url, 'https://dash.cloudflare.com/')" target="_blank" rel="noopener noreferrer">{{ ui('Manage budgets in Cloudflare', '在 Cloudflare 管理预算') }}</a> · <a :href="safeLink(connection.budget.docs_url, 'https://developers.cloudflare.com/billing/manage/budget-alerts/')" target="_blank" rel="noopener noreferrer">{{ ui('Budget Alerts guide', '预算警报指南') }}</a></details>
        <details class="connection-section" aria-labelledby="connection-notifications-heading" :open="showNotifications" @toggle="toggleFeature('notifications', $event)"><summary id="connection-notifications-heading">{{ ui('Cloudflare notification policies', 'Cloudflare 通知策略') }}</summary><p role="status">{{ featureLoading ? ui('Reading…', '正在读取…') : status(notifications?.status ?? connection.capabilities.notifications) }}</p><p class="muted-copy">{{ ui('Live read-only policies and email recipients are visible only to the Owner. They do not confirm a USD budget configuration.', '仅 Owner 可查看实时只读策略及收件邮件；这些数据不代表已核实 USD 预算配置。') }}</p><ul v-if="notifications?.policies.length" class="notification-policies"><li v-for="policy in notifications.policies" :key="policy.id"><strong>{{ policy.name }}</strong> · {{ policy.enabled ? ui('Enabled','启用') : ui('Disabled','停用') }}<p>{{ policy.alert_type }}</p><p>{{ policy.emails.join(', ') || ui('No email recipient reported','未返回收件邮件') }}</p></li></ul><p v-else-if="notifications?.status === 'verified'" class="muted-copy">{{ ui('No notification policies returned.', '未返回通知策略。') }}</p></details>
        <details class="connection-section" aria-labelledby="connection-waf-heading" :open="showWaf" @toggle="toggleFeature('waf', $event)"><summary id="connection-waf-heading">{{ ui('Domain & access protection', '域名与访问防护') }}</summary><form class="control-form" @submit.prevent="saveZone"><label>{{ ui('Zone ID for this domain', '此域名的 Zone ID') }}<UInput :disabled="!writable" v-model="zone" autocomplete="off" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable">{{ ui('Save Zone selection', '保存 Zone 选择') }}</UButton></form><p role="status">{{ featureLoading ? ui('Reading…', '正在读取…') : status(waf?.status ?? connection.capabilities.waf) }}</p><p>{{ waf?.hostname ?? connection.target.hostname ?? ui('Hostname unknown', '域名未知') }}</p><p v-if="waf?.protected">{{ ui('The tool-owned exact-hostname blocking rule is verified active.', '已核验本工具拥有的准确域名阻止规则生效。') }}</p><p v-else class="muted-copy">{{ ui('No active tool-owned blocking rule is confirmed. Other Cloudflare protection may exist. Token permission and a domain ownership receipt are separate requirements.', '尚未确认本工具拥有的阻止规则生效；Cloudflare 可能另有防护。Token 权限与域名归属回执是独立条件。') }}</p><dl v-if="waf?.owned_rule" class="connection-target"><div><dt>{{ ui('Tool-owned custom rule', '本工具自有自定义规则') }}</dt><dd>{{ waf.owned_rule.id }} · {{ waf.owned_rule.enabled ? ui('Enabled', '启用') : ui('Disabled', '停用') }}</dd></div><div><dt>{{ ui('Action', '动作') }}</dt><dd>{{ waf.owned_rule.action }}</dd></div></dl><p class="muted-copy">{{ ui('A legacy domain without a tool ownership receipt needs an explicit connection plan. Keep the domain; do not delete and recreate it. Zone rules do not protect workers.dev.', '旧域名缺少本工具归属回执时，需明确接入计划；保留现有域名，无需删除重建。Zone 规则不保护 workers.dev。') }}</p><a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Domain and protection guide', '域名与防护指南') }}</a></details>
      </template>
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
.connection-summary { margin: 16px 0 12px; }
.connection-capabilities { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 12px 0 20px; }
.connection-capabilities > div { display: flex; flex-wrap: wrap; gap: 8px; }
.connection-capabilities dt { color: var(--color-text-muted); }
.connection-capabilities dd { margin: 0; }
.connection-management, .connection-guide { margin: 16px 0; }
summary { cursor: pointer; font-weight: 600; }
.connection-guide pre { overflow-x: auto; padding: 12px; background: var(--color-surface-muted); font-size: 13px; }
.plan-comparison { width: 100%; border-collapse: collapse; margin: 16px 0; }
.plan-comparison th, .plan-comparison td { padding: 12px 8px; border-bottom: 1px solid var(--color-border); text-align: left; overflow-wrap: anywhere; }
.plan-comparison thead th { color: var(--color-text-muted); font-size: 13px; }
.configuration-plan > button { margin-top: 12px; }
.notification-policies { padding-left: 20px; }
.notification-policies li { padding: 8px 0; }
.notification-policies p { margin: 4px 0; overflow-wrap: anywhere; }
@media (max-width: 600px) { .connection-target { grid-template-columns: 1fr; } .control-form label { width: 100%; } }
</style>
