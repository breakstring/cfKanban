<script lang="ts">
interface RecoverableTokenSave { key: string; operationId: string | null }
const recoverableTokenSaves = new Map<string, RecoverableTokenSave>();
if (typeof window !== "undefined") {
  const clearRecovery = () => recoverableTokenSaves.clear();
  window.addEventListener("cfkanban:session-invalid", clearRecovery);
  window.addEventListener("cfkanban:session-exchanged", clearRecovery);
}
</script>

<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import CloudflareTokenForm from "./CloudflareTokenForm.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { ApiProblem, apiRequest, clearPendingRequestIntents, errorText, hasUncertainWrite } from "../lib/api";
import { locale } from "../lib/i18n";
import type { RateLimitSettings, WebSessionView, WriteResult } from "../types";

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
const operationKinds = new Set(["configuration_secret", "control_secret", "analytics_secret", "configuration", "rate_limit"]);
const operationStatuses = new Set(["pending", "verified", "failed", "unknown"]);
const capabilityStates = new Set(["missing", "unverified", "verified", "permission_denied", "unavailable", "target_mismatch", "unsupported_contract"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nullableText(value: unknown): boolean { return value === null || typeof value === "string"; }
function isOperation(value: unknown): value is Operation {
  return record(value) && typeof value.operation_id === "string" && uuidPattern.test(value.operation_id)
    && typeof value.kind === "string" && operationKinds.has(value.kind) && typeof value.status === "string" && operationStatuses.has(value.status)
    && Number.isSafeInteger(value.version) && (value.version as number) >= 1
    && [value.baseline_version_id, value.result_version_id, value.deployment_id].every(nullableText)
    && nullableText(value.failure_class) && (value.failure_class === null || (value.failure_class as string).length <= 128)
    && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at))
    && typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at));
}
function isOperationWrite(value: unknown, expectedId?: string, secretOnly = false): boolean {
  return record(value) && isOperation(value.resource) && typeof value.event_cursor === "string" && typeof value.idempotent_replay === "boolean"
    && (!expectedId || value.resource.operation_id === expectedId) && (!secretOnly || value.resource.kind === "configuration_secret");
}
function isConnection(value: unknown): value is Connection {
  return record(value) && Number.isSafeInteger(value.version) && (value.version as number) >= 1
    && record(value.target) && ["account_id", "worker_name", "database_id", "zone_id", "hostname"].every(key => nullableText((value.target as Record<string, unknown>)[key]))
    && record(value.configured) && ["connection", "configuration", "control", "analytics"].every(key => typeof (value.configured as Record<string, unknown>)[key] === "boolean")
    && record(value.capabilities) && ["configuration", "analytics", "billing", "notifications", "waf"].every(key => capabilityStates.has(String((value.capabilities as Record<string, unknown>)[key])))
    && (value.latest_operation === null || isOperation(value.latest_operation)) && record(value.configuration) && record(value.budget);
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
const props = withDefaults(defineProps<{ mode?: "overview" | "usage"; initialSetting?: ConfigurationField | null; settingRequest?: number; session?: Pick<WebSessionView, "session_id" | "principal"> }>(), { mode: "overview", initialSetting: null, settingRequest: 0 });
const emit = defineEmits<{ applied: []; rates: [value: RateLimitSettings] }>();
const base = "/api/v1/admin/cloudflare";
const recoveryPartition = () => props.session ? `${window.location.origin}\n${props.session.principal.id}\n${props.session.session_id}` : null;
const restoredTokenSave = recoveryPartition() ? recoverableTokenSaves.get(recoveryPartition()!) ?? null : null;
let contextGeneration = 0;
const isCurrent = (generation: number) => !disposed && contextGeneration === generation;
const connection = ref<Connection | null>(null);
const operation = ref<Operation | null>(null);
const tokenOperation = ref<Operation | null>(null);
const notifications = ref<Notifications | null>(null);
const waf = ref<Waf | null>(null);
const rateSettings = ref<RateLimitSettings | null>(null);
const plan = ref<Plan | null>(null);
const loading = ref(false);
const busy = ref(false);
const failed = ref(false);
const uncertain = ref(Boolean(restoredTokenSave));
type TokenFeedback = "saved" | "rejected" | "failed" | "pending" | "unknown" | "capabilities_unavailable" | "readback_unavailable";
const tokenFeedback = ref<TokenFeedback | null>(restoredTokenSave ? "unknown" : null);
const tokenProblem = ref<ApiProblem | null>(null);
const tokenWrite = ref<RecoverableTokenSave | null>(restoredTokenSave);
const tokenLookupMissing = ref(false);
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
let readController = new AbortController();
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
  if (unresolved.value) return ui("Save awaiting confirmation", "保存待确认");
  if (connectionAction.value === "connect") return connection.value?.capabilities.analytics === "verified"
    ? ui("Usage is available; settings cannot be changed yet", "统计可用，尚不能修改设置")
    : hasAnalyticsAuthorization.value ? ui("Usage authorization is saved; settings are not connected", "已保存统计授权，尚不能修改设置") : ui("Not connected", "尚未连接");
  const capability = connection.value?.capabilities.configuration;
  if (capability === "unverified") return ui("Connection not checked", "连接尚未检查");
  if (capability === "permission_denied") return ui("Check Token permissions", "请检查 Token 权限");
  if (capability === "target_mismatch") return ui("Check the selected Worker", "请检查所选 Worker");
  if (capability === "unavailable") return ui("Connection temporarily unavailable", "暂时无法检查连接");
  return connection.value?.configured.connection ? ui("Connected", "已连接") : ui("Using existing authorization", "正在使用现有授权");
});
const connectionNextStep = computed(() => {
  if (unresolved.value) return "";
  if (connectionAction.value === "connect") return props.mode === "usage"
    ? ui("To change settings, create and enter a Token with settings permissions in Overview.", "要修改设置，请先在概览中创建并输入具有设置修改权限的 Token。")
    : ui("To change settings, create a Token with settings permissions and enter it below.", "要修改设置，请先创建具有设置修改权限的 Token，并在下方输入保存。");
  if (connectionAction.value === "replace") return props.mode === "usage"
    ? ui("Review or replace the connection Token in Overview before changing settings.", "修改设置前，请先在概览中检查或替换连接 Token。")
    : ui("This Token cannot change the current settings. Check the permissions in the creation guide or enter a replacement Token below.", "当前 Token 无法修改设置。请按创建指南检查权限，或在下方输入具有所需权限的替代 Token。");
  if (connection.value?.capabilities.configuration === "unverified") return ui("The Token is saved. Check the connection before changing settings.", "Token 已保存，请先检查连接，再修改设置。");
  if (!hasConfiguration.value) return ui("The connection cannot be checked right now. Try again before changing settings.", "暂时无法检查连接，请重新检查后再修改设置。");
  return "";
});
type CapabilityKey = keyof Connection["capabilities"];
const expandedCapabilities = ref(new Set<CapabilityKey>());
const previewCapability = ref<CapabilityKey | null>(null);
function toggleCapabilityDetails(key: CapabilityKey): void {
  const next = new Set(expandedCapabilities.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedCapabilities.value = next; previewCapability.value = null;
}
function enterCapability(key: CapabilityKey, event: PointerEvent): void {
  if (event.pointerType !== "touch") previewCapability.value = key;
}
function leaveCapabilityFocus(event: FocusEvent): void {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) previewCapability.value = null;
}
const capabilities = computed(() => [
  { key: "configuration" as const, label: ui("Change Worker settings", "修改 Worker 设置"), required: true,
    permissions: "Individual Workers · Editor", path: "Developer Platform → Individual Workers → Editor",
    scope: ui(`Current Worker: ${connection.value?.target.worker_name ?? "Unknown"}`, `当前 Worker：${connection.value?.target.worker_name ?? "未知"}`),
    explanation: ui("Checks this instance’s active Worker configuration and D1 binding. Editor also grants code, deployment, Secret and configuration changes; this check does not probe every write operation.", "核验当前实例的已生效 Worker 配置及 D1 绑定。Editor 同时包含代码、部署、Secret 与配置修改权；当前核验不会探测全部写操作。") },
  { key: "analytics" as const, label: ui("Read usage", "读取用量"), required: true,
    permissions: "Account Analytics · Read", path: "Analytics & Logs → Account Analytics → Read",
    scope: ui(`Target account: ${connection.value?.target.account_id ?? "Unknown"}`, `目标账户：${connection.value?.target.account_id ?? "未知"}`),
    explanation: ui("Verified means a query for the specified D1 database passed. Workers, R2 and other metrics depend on their actual queries; this is not an invoice or a complete permission inventory.", "核验通过表示指定 D1 数据库的查询通过。Workers、R2 与其他指标以实际查询为准；这不是账单，也不是 Token 全部权限的清单。") },
  { key: "billing" as const, label: ui("View billing", "查看账务"), required: false,
    permissions: "Billing · Read", path: "Account & Billing → Billing → Read",
    scope: ui(`Target account: ${connection.value?.target.account_id ?? "Unknown"}`, `目标账户：${connection.value?.target.account_id ?? "未知"}`),
    explanation: ui("Checks billing and plan information reads. It does not verify USD budget editing or cap charges.", "核验账务与方案信息读取；不表示已具备美元预算编辑能力，也不会封顶费用。") },
  { key: "notifications" as const, label: ui("Read notifications", "读取通知"), required: false,
    permissions: "Notifications · Read", path: "Account & Billing → Notifications → Read",
    scope: ui(`Target account: ${connection.value?.target.account_id ?? "Unknown"}`, `目标账户：${connection.value?.target.account_id ?? "未知"}`),
    explanation: ui("Check on request to read existing notification policies. A denied read does not mean no budget emails are configured; account-owned Token compatibility depends on the actual read.", "主动检查时读取已有通知策略。读取被拒绝不表示未配置预算邮件；account-owned Token 兼容性以实际读取为准。") },
  { key: "waf" as const, label: ui("View domain protection", "查看域名防护"), required: false,
    permissions: "Zone · Read + Zone WAF Rules · Read", path: "DNS & Zones → Zone → Read · App Security → Zone WAF Rules → Read",
    scope: ui(`Specified Zone: ${connection.value?.target.zone_id ?? "Not selected"} · ${connection.value?.target.hostname ?? "Hostname unknown"}`, `指定 Zone：${connection.value?.target.zone_id ?? "尚未选择"} · ${connection.value?.target.hostname ?? "域名未知"}`),
    explanation: ui("One check verifies the selected Zone’s account and domain, then reads its WAF rules. Permission does not prove protection is enabled; the tool’s ownership receipt is a separate requirement.", "一次检查先核验所选 Zone 的账户和域名，再读取 WAF 规则。具备读取权限不表示防护已启用；本工具归属回执是独立条件。") },
]);
function capabilityState(key: CapabilityKey): string {
  if (key === "waf" && !connection.value?.target.zone_id) return "missing";
  if (key === "notifications" && notifications.value) return notifications.value.status;
  if (key === "waf" && waf.value) return waf.value.status;
  return connection.value?.capabilities[key] ?? "unverified";
}
function capabilityStatus(key: CapabilityKey): string {
  return key === "waf" && !connection.value?.target.zone_id ? ui("Zone not selected", "尚未选择 Zone") : status(capabilityState(key));
}
function capabilityTone(key: CapabilityKey): "verified" | "denied" | "neutral" {
  const value = capabilityState(key);
  return value === "verified" ? "verified" : value === "permission_denied" || value === "target_mismatch" ? "denied" : "neutral";
}
function capabilitySource(key: CapabilityKey): string {
  let source: string;
  if (connection.value?.configured.connection) source = tokenWrite.value && unresolved.value ? ui("Previously saved Token", "此前保存的 Token") : ui("Saved Token", "已保存的 Token");
  else if (key === "analytics" && connection.value?.configured.analytics) source = ui("Existing analytics authorization", "现有统计授权");
  else if (key === "configuration" && connection.value?.configured.configuration) source = ui("Existing settings authorization", "现有配置授权");
  else if (!["configuration", "analytics"].includes(key) && connection.value?.configured.control) source = ui("Existing control authorization", "现有管理授权");
  else return ui("No authorization saved", "尚未保存授权");
  return tokenWrite.value && unresolved.value ? `${source}${ui(" (this save awaits confirmation)", "（本次保存待确认）")}` : source;
}
const requiredCapabilitySummary = computed(() => capabilities.value.filter(entry => entry.required).map(entry => `${entry.label} · ${capabilityStatus(entry.key)}`).join(" · "));
const visibleCapabilities = computed(() => props.mode === "overview" ? capabilities.value : capabilities.value.filter(entry => entry.required && capabilityState(entry.key) !== "verified"));
const compactConnection = computed(() => props.mode === "overview" && hasConfigurationAuthorization.value && !connectionManagementOpen.value && !unresolved.value);
function operationFailureExplanation(value: string | null | undefined): string {
  if (value === "permission_denied") return ui("Cloudflare denied the save permission. Check the current Worker’s Editor permission and enter a replacement Token.", "Cloudflare 拒绝了保存权限，请核对当前 Worker 的 Editor 权限后重新输入 Token。");
  if (value === "target_mismatch") return ui("The Cloudflare target or active deployment did not match. Verify this instance before saving again.", "Cloudflare 目标或已生效部署不一致，请先核对当前实例再保存。");
  if (value === "preflight_changed") return ui("The active configuration changed during the safety check. Refresh its state and decide again.", "安全核对期间已生效配置发生变化，请刷新当前状态后重新决定。");
  return ui("Cloudflare confirmed the save failed. Check the connection and permissions before entering the Token again.", "Cloudflare 已确认保存失败，请检查连接与权限后重新输入 Token。");
}
function providerFailureFacts(problem: ApiProblem | null): string {
  if (!problem) return "";
  const provider = problem.body.details;
  const operations: Record<string, string> = {
    deployments: ui("Read Worker deployment", "读取 Worker 部署"), versions: ui("Read Worker versions", "读取 Worker 版本"),
    settings: ui("Read Worker settings", "读取 Worker 设置"), version_details: ui("Read active Worker version", "读取生效 Worker 版本"),
    secret_write: ui("Save Worker Secret", "保存 Worker Secret"),
  };
  if (problem.body.source === "cloudflare_platform" && typeof provider.provider_operation === "string" && Object.hasOwn(operations, provider.provider_operation)
    && typeof provider.provider_method === "string" && ["GET", "PUT", "POST", "PATCH", "DELETE"].includes(provider.provider_method)
    && typeof provider.provider_status === "number" && Number.isInteger(provider.provider_status) && provider.provider_status >= 100 && provider.provider_status <= 599) {
    return `${ui("Failed step", "失败步骤")}: ${operations[provider.provider_operation]} · ${provider.provider_method} · Cloudflare HTTP ${provider.provider_status}`;
  }
  return "";
}
function rejectedTokenMessage(problem: ApiProblem | null): string {
  const heading = ui("Token was not saved.", "Token 未保存。");
  if (!problem) return `${heading} ${ui("Check the Token and try again.", "请检查 Token 后重新输入。")}`;
  const presented = errorText(problem);
  const [message, ...diagnostics] = presented.split("\n");
  let reason = message;
  if (problem.body.source === "cloudflare_platform" && problem.body.details.failure_class === "permission_denied") reason = ui("Cloudflare rejected this Token. Check that it has Editor permission for this Worker.", "Cloudflare 拒绝了当前 Token，请检查是否授予此 Worker 的 Editor 权限。");
  else if (problem.status === 409) reason = ui("The current settings changed before saving. Check the status and decide again.", "保存前状态发生变化，请重新检查后再决定是否保存。");
  else if (problem.status === 400) reason = ui("The Token or settings did not pass the check. Review the Token and its required permissions.", "Token 或设置未通过检查，请核对 Token 内容与所需权限。");
  const providerFacts = providerFailureFacts(problem);
  if (providerFacts) diagnostics.unshift(providerFacts);
  return `${heading} ${reason}${diagnostics.length ? `\n${diagnostics.join("\n")}` : ""}`;
}
const tokenFeedbackMessage = computed(() => {
  if (tokenFeedback.value === "unknown" && tokenLookupMissing.value) return ui("This save record is not available yet. Check again shortly; the cleared Token will not be sent again.", "暂未找到本次保存记录，请稍后检查；已清空的 Token 不会再次发送。");
  if (tokenFeedback.value === "unknown") {
    const message = ui("The save result is unknown. The Token input has been cleared. Verify this save before making another change.", "保存结果尚未确认，Token 输入已清空。请先检查保存结果，再进行其他变更。");
    const facts = providerFailureFacts(tokenProblem.value);
    return facts ? `${message}\n${facts} · ${ui("Request ID", "请求 ID")}: ${tokenProblem.value!.body.request_id}` : message;
  }
  if (tokenFeedback.value === "pending") return ui("The Token save is still being verified. The input has been cleared; verify this save before making another change.", "Token 保存正在核验中，输入已清空；请先检查保存结果，再进行其他变更。");
  if (tokenFeedback.value === "failed") return `${ui("Token save failed.", "Token 保存失败。")} ${operationFailureExplanation(tokenOperation.value?.failure_class)}`;
  if (tokenFeedback.value === "rejected") return rejectedTokenMessage(tokenProblem.value);
  if (tokenFeedback.value === "capabilities_unavailable") return ui("Token saved. Some functions could not be confirmed yet. Check the connection again.", "Token 已保存，部分功能暂未确认，请重新检查连接。");
  if (tokenFeedback.value === "readback_unavailable") return ui("Token saved. The latest status is temporarily unavailable. Check the connection before changing settings.", "Token 已保存，暂时无法读取最新状态。修改设置前请重新检查连接。");
  return "";
});
const rateUnavailableReason = computed(() => {
  if (!fixedTargetReady.value) return ui("This instance’s Cloudflare setup is incomplete. Ask your deployment Agent to check it.", "此实例的 Cloudflare 配置不完整，请让部署 Agent 检查。");
  if (unresolved.value) return ui("The last save is not confirmed yet. Check its result in Overview before changing limits.", "上次保存尚未确认，请先在概览检查保存结果，再修改限制。");
  if (!hasConfigurationAuthorization.value || connection.value?.capabilities.configuration === "missing") return ui("To change limits, first save a Token with settings permissions in Overview.", "要修改限制，请先在概览保存具有设置权限的 Token。");
  if (connection.value?.capabilities.configuration === "unverified") return ui("The Token is saved but has not been checked. Check the connection in Overview first.", "Token 已保存但尚未检查，请先在概览检查连接。");
  if (["permission_denied", "target_mismatch"].includes(connection.value?.capabilities.configuration ?? "")) return ui("The current Token cannot change these limits. Check its permissions or replace it in Overview.", "当前 Token 无法修改限制，请在概览检查权限或更换 Token。");
  if (!hasConfiguration.value || failed.value) return ui("The connection is temporarily unavailable. Check it in Overview before changing limits.", "暂时无法检查连接，请先在概览重新检查，再修改限制。");
  return "";
});
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
    missing: ["Not configured", "未配置"], unverified: ["Not checked", "未检查"], verified: ["Available", "可用"],
    permission_denied: ["Cloudflare permission denied", "Cloudflare 权限不足"], unavailable: ["Currently unavailable", "暂不可用"],
    target_mismatch: ["Target does not match this instance", "目标与本实例不一致"], unsupported_contract: ["Not available to check", "暂不能检查"],
    pending: ["In progress; check the result", "处理中，请检查结果"], unknown: ["Result unknown; check before another change", "结果未确认，请先检查"],
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
  const requestContext = contextGeneration;
  loading.value = true; failed.value = false;
  try {
    const result = await apiRequest<Connection>(base, { validateResponse: isConnection, authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal });
    if (!isCurrent(requestContext)) return;
    connection.value = result;
    if (!tokenWrite.value || result.latest_operation?.operation_id === tokenWrite.value.operationId) operation.value = result.latest_operation;
    zone.value = result.target.zone_id ?? ""; configurationDraft();
  } catch { if (isCurrent(requestContext)) failed.value = true; }
  finally { if (isCurrent(requestContext)) loading.value = false; }
}
function invalidateFeatureReads(): void {
  featureGeneration++; notifications.value = null; waf.value = null; featureLoading.value = false;
}
async function inspectFeatures(): Promise<void> {
  const requestContext = contextGeneration;
  const request = ++featureGeneration;
  const readNotifications = showNotifications.value;
  const readWaf = showWaf.value;
  if (!readNotifications && !readWaf) return;
  featureLoading.value = true;
  const results = await Promise.allSettled([
    readNotifications ? apiRequest<Notifications>(`${base}/notifications`, { authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal }) : Promise.resolve(null),
    readWaf ? apiRequest<Waf>(`${base}/waf`, { authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal }) : Promise.resolve(null),
  ]);
  if (!isCurrent(requestContext) || request !== featureGeneration) return;
  if (readNotifications) notifications.value = results[0].status === "fulfilled" ? results[0].value : { status: results[0].reason instanceof ApiProblem && results[0].reason.status === 403 ? "permission_denied" : "unavailable", available_alerts: [], policies: [] };
  if (readWaf) waf.value = results[1].status === "fulfilled" ? results[1].value : { status: results[1].reason instanceof ApiProblem && results[1].reason.status === 403 ? "permission_denied" : "unavailable", zone_id: null, hostname: null, owned_rule: null, other_rule_count: null, protected: false };
  featureLoading.value = false;
}
async function loadRates(): Promise<void> {
  const requestContext = contextGeneration;
  try {
    const result = await apiRequest<RateLimitSettings>("/api/v1/admin/rate-limit-settings", { authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal });
    if (!isCurrent(requestContext)) return;
    rateSettings.value = result; rateDraft(); emit("rates", result);
  } catch { if (isCurrent(requestContext)) rateSettings.value = null; }
}
function toggleFeature(kind: "notifications" | "waf", event: Event): void {
  const opened = (event.target as HTMLDetailsElement).open;
  if (kind === "notifications") showNotifications.value = opened; else showWaf.value = opened;
  if (opened) void inspectFeatures();
}
async function verifyCapabilities(includeOptional = false): Promise<void> {
  const requestContext = contextGeneration;
  if (includeOptional) invalidateFeatureReads();
  const result = await apiRequest<WriteResult<Connection>>(`${base}/verify`, { validateResponse: value => record(value) && isConnection(value.resource), authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: includeOptional ? { include_optional: true } : {}, idempotencyKey: crypto.randomUUID() });
  if (!isCurrent(requestContext)) return;
  connection.value = result.resource; operation.value = result.resource.latest_operation; zone.value = result.resource.target.zone_id ?? ""; configurationDraft();
  if (includeOptional) { notifications.value = null; waf.value = null; }
  if (!tokenWrite.value) uncertain.value = false;
  readbackGeneration.value += 1;
}
function setTokenWrite(value: RecoverableTokenSave | null): void {
  tokenWrite.value = value;
  const partition = recoveryPartition();
  if (!partition) return;
  if (value) recoverableTokenSaves.set(partition, value);
  else recoverableTokenSaves.delete(partition);
}
function recordTokenOperation(value: Operation): void {
  tokenOperation.value = value; operation.value = value;
  if (tokenWrite.value) tokenWrite.value.operationId = value.operation_id;
  uncertain.value = false;
  if (value.status === "pending" || value.status === "unknown") {
    tokenFeedback.value = value.status;
    return;
  }
  clearPendingRequestIntents("POST", `${base}/secrets`);
  setTokenWrite(null);
  tokenFeedback.value = value.status === "verified" ? "saved" : "failed";
  if (value.status === "verified" && connection.value) {
    connection.value.configured.connection = true;
    for (const key of Object.keys(connection.value.capabilities) as CapabilityKey[]) connection.value.capabilities[key] = "unverified";
    invalidateFeatureReads();
  }
}
async function refreshAfterTokenSave(): Promise<void> {
  const requestContext = contextGeneration;
  await load();
  if (!isCurrent(requestContext)) return;
  if (failed.value) {
    if (tokenFeedback.value === "saved") tokenFeedback.value = "readback_unavailable";
    return;
  }
  if (tokenFeedback.value !== "saved" || unresolved.value) return;
  try {
    await verifyCapabilities();
    if (!isCurrent(requestContext)) return;
    if (props.mode === "usage") await loadRates(); await inspectFeatures();
    if (isCurrent(requestContext) && !unresolved.value) emit("applied");
  } catch {
    if (isCurrent(requestContext)) tokenFeedback.value = "capabilities_unavailable";
  }
}
async function verify(): Promise<void> {
  const requestContext = contextGeneration;
  if (busy.value || loading.value) return;
  busy.value = true; failed.value = false; plan.value = null; planGeneration++;
  try {
    const save = tokenWrite.value;
    if (save) {
      if (!save.operationId) {
        // 只按原保存键找回记录；最近变更可能属于另一设备。
        tokenLookupMissing.value = false;
        let recovered: Operation;
        try { recovered = await apiRequest<Operation>(`${base}/secret-operations/${encodeURIComponent(save.key)}`, { validateResponse: value => isOperation(value) && value.kind === "configuration_secret", authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal }); }
        catch (error) {
          if (!isCurrent(requestContext)) return;
          if (error instanceof ApiProblem && error.status === 404 && error.body.details.normalized_by !== "client") tokenLookupMissing.value = true;
          return;
        }
        if (!isCurrent(requestContext)) return;
        recordTokenOperation(recovered);
        if (!tokenWrite.value) { await refreshAfterTokenSave(); return; }
      }
      const operationId = tokenWrite.value?.operationId ?? save.operationId!;
      const result = await apiRequest<WriteResult<Operation>>(`${base}/operations/${encodeURIComponent(operationId)}/verify`, { validateResponse: value => isOperationWrite(value, operationId, true), authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
      if (!isCurrent(requestContext)) return;
      recordTokenOperation(result.resource);
      if (!unresolved.value) await refreshAfterTokenSave();
      return;
    }
    await load();
    if (!isCurrent(requestContext) || failed.value || !connection.value) return;
    if (operation.value && ["pending", "unknown"].includes(operation.value.status)) {
      const result = await apiRequest<WriteResult<Operation>>(`${base}/operations/${encodeURIComponent(operation.value.operation_id)}/verify`, { validateResponse: value => isOperationWrite(value, operation.value?.operation_id), authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
      if (!isCurrent(requestContext)) return; operation.value = result.resource;
      if (["pending", "unknown"].includes(result.resource.status)) return;
    }
    await verifyCapabilities();
    if (!isCurrent(requestContext)) return;
    if (["capabilities_unavailable", "readback_unavailable"].includes(tokenFeedback.value ?? "")) tokenFeedback.value = "saved";
    if (props.mode === "usage") await loadRates(); await inspectFeatures();
    if (isCurrent(requestContext) && !unresolved.value) emit("applied");
  } catch {
    if (isCurrent(requestContext)) {
      if (tokenWrite.value) tokenFeedback.value = operation.value?.status === "pending" ? "pending" : "unknown";
      else if (["saved", "capabilities_unavailable", "readback_unavailable"].includes(tokenFeedback.value ?? "")) tokenFeedback.value = "capabilities_unavailable";
      else failed.value = true;
    }
  }
  finally { if (isCurrent(requestContext)) busy.value = false; }
}
async function saveToken(kind: string, token: string): Promise<void> {
  const requestContext = contextGeneration;
  if (!writable.value || !connection.value) return;
  const key = crypto.randomUUID();
  const savePartition = recoveryPartition();
  clearPendingRequestIntents("POST", `${base}/secrets`);
  setTokenWrite({ key, operationId: null });
  tokenLookupMissing.value = false;
  invalidateFeatureReads();
  busy.value = true; failed.value = false; tokenProblem.value = null; tokenFeedback.value = null; plan.value = null;
  try {
    // 显式键使通用客户端不以含秘密的 body 生成待恢复签名。
    const result = await apiRequest<WriteResult<Operation>>(`${base}/secrets`, { validateResponse: value => isOperationWrite(value, undefined, true), authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: { kind, token, expected_version: connection.value.version }, idempotencyKey: key });
    if (!isCurrent(requestContext)) {
      if (savePartition && recoverableTokenSaves.get(savePartition)?.key === key) {
        if (["verified", "failed"].includes(result.resource.status)) recoverableTokenSaves.delete(savePartition);
        else recoverableTokenSaves.set(savePartition, { key, operationId: result.resource.operation_id });
      }
      return;
    }
    recordTokenOperation(result.resource);
  } catch (error) {
    if (!isCurrent(requestContext)) {
      if (savePartition && recoverableTokenSaves.get(savePartition)?.key === key && error instanceof ApiProblem && error.status >= 400 && error.status < 500 && error.body.details.normalized_by !== "client") recoverableTokenSaves.delete(savePartition);
      return;
    }
    if (hasUncertainWrite(`${base}/secrets`)) {
      operation.value = null; uncertain.value = true; tokenFeedback.value = "unknown"; tokenProblem.value = error instanceof ApiProblem ? error : null;
    } else {
      setTokenWrite(null); tokenFeedback.value = "rejected";
      tokenProblem.value = error instanceof ApiProblem ? error : null;
      if (error instanceof ApiProblem && error.status === 409) await load();
    }
  } finally { if (isCurrent(requestContext)) busy.value = false; }
  if (!isCurrent(requestContext) || tokenWrite.value || tokenFeedback.value === "rejected") return;
  busy.value = true;
  try { await refreshAfterTokenSave(); }
  finally { if (isCurrent(requestContext)) busy.value = false; }
}
async function checkOptional(): Promise<void> {
  const requestContext = contextGeneration;
  if (busy.value || featureLoading.value || loading.value || unresolved.value) return;
  busy.value = true;
  try { await verifyCapabilities(true); }
  catch {
    if (isCurrent(requestContext) && connection.value) {
      for (const key of ["billing", "notifications", "waf"] as const) connection.value.capabilities[key] = "unavailable";
    }
  }
  finally { if (isCurrent(requestContext)) busy.value = false; }
}
async function saveZone(): Promise<void> {
  const requestContext = contextGeneration;
  if (!writable.value || !connection.value) return;
  tokenFeedback.value = null; tokenProblem.value = null;
  busy.value = true; failed.value = false; plan.value = null;
  try {
    const result = await apiRequest<WriteResult<Connection>>(`${base}/settings`, { authorizationCurrent: () => isCurrent(requestContext), method: "PATCH", body: { zone_id: zone.value.trim() || null, expected_version: connection.value.version } });
    if (isCurrent(requestContext)) { invalidateFeatureReads(); connection.value = result.resource; operation.value = result.resource.latest_operation; await inspectFeatures(); }
  } catch { if (isCurrent(requestContext)) failed.value = true; }
  finally { if (isCurrent(requestContext)) busy.value = false; }
}
async function preview(kind: "rate_limit" | "configuration"): Promise<void> {
  const requestContext = contextGeneration;
  if (!writable.value || !hasConfiguration.value || !connection.value) return;
  tokenFeedback.value = null; tokenProblem.value = null;
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
    const result = await apiRequest<WriteResult<Plan>>(`${base}/${kind === "rate_limit" ? "rate-limits" : "configuration"}/plan`, { authorizationCurrent: () => isCurrent(requestContext), method: "POST", body });
    if (isCurrent(requestContext)) {
      if (connection.value) connection.value.version = result.resource.version;
      if (request === planGeneration) plan.value = result.resource;
    }
  } catch { if (isCurrent(requestContext)) failed.value = true; }
  finally { if (isCurrent(requestContext)) busy.value = false; }
}
async function apply(): Promise<void> {
  const requestContext = contextGeneration;
  const current = plan.value;
  if (!current || !writable.value || !hasConfiguration.value) return;
  tokenFeedback.value = null; tokenProblem.value = null;
  busy.value = true; failed.value = false; plan.value = null;
  try {
    const result = await apiRequest<WriteResult<Operation>>(`${base}/${current.kind === "rate_limit" ? "rate-limits" : "configuration"}/apply`, { authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: { plan_id: current.plan_id, expected_version: current.version } });
    if (!isCurrent(requestContext)) return; operation.value = result.resource; await load();
    if (isCurrent(requestContext) && !failed.value) { if (props.mode === "usage") await loadRates(); await inspectFeatures(); if (isCurrent(requestContext) && !unresolved.value) emit("applied"); }
  } catch { if (isCurrent(requestContext)) { failed.value = true; uncertain.value = true; } }
  finally { if (isCurrent(requestContext)) busy.value = false; }
}
function invalidateSessionContext(): void {
  contextGeneration++; featureGeneration++; planGeneration++;
  readController.abort(); readController = new AbortController();
  tokenWrite.value = null; uncertain.value = false; tokenFeedback.value = null;
  tokenProblem.value = null; tokenLookupMissing.value = false; connection.value = null; operation.value = null; tokenOperation.value = null;
  notifications.value = null; waf.value = null; rateSettings.value = null; plan.value = null;
  loading.value = false; busy.value = false; failed.value = false; featureLoading.value = false;
  expandedCapabilities.value = new Set(); previewCapability.value = null; readbackGeneration.value++;
}
function sessionBoundaryChanged(): void { invalidateSessionContext(); loading.value = true; }
watch([() => props.session?.session_id, () => props.session?.principal.id], () => {
  invalidateSessionContext();
  tokenWrite.value = recoveryPartition() ? recoverableTokenSaves.get(recoveryPartition()!) ?? null : null;
  uncertain.value = Boolean(tokenWrite.value); tokenFeedback.value = tokenWrite.value ? "unknown" : null;
  void load().then(() => { if (!disposed && connection.value && props.mode === "usage") void loadRates(); });
});
watch(configurationField, () => { configurationDraft(); validation.value = false; plan.value = null; planGeneration++; });
watch([hasConfigurationAuthorization, () => connection.value?.capabilities.configuration, unresolved], () => {
  connectionManagementOpen.value = unresolved.value || connectionAction.value === "connect" || connectionAction.value === "replace";
}, { immediate: true });
watch(() => props.initialSetting, value => { if (value) configurationField.value = value; });
watch(() => props.settingRequest, () => { if (props.initialSetting) configurationField.value = props.initialSetting; });
watch(rateScope, rateDraft);
watch([rateScope, rateLimit, ratePeriod, configurationValue], () => { plan.value = null; planGeneration++; });
watch(() => props.mode, mode => {
  plan.value = null; validation.value = false; planGeneration++; featureGeneration++;
  showNotifications.value = false; showWaf.value = false; featureLoading.value = false;
  if (mode === "usage" && connection.value) void loadRates();
});
onMounted(async () => {
  window.addEventListener("cfkanban:session-exchanged", sessionBoundaryChanged);
  window.addEventListener("cfkanban:session-invalid", sessionBoundaryChanged);
  await load(); if (!disposed && connection.value && props.mode === "usage") await loadRates(); });
onUnmounted(() => {
  disposed = true; readController.abort();
  window.removeEventListener("cfkanban:session-exchanged", sessionBoundaryChanged);
  window.removeEventListener("cfkanban:session-invalid", sessionBoundaryChanged);
});
</script>

<template>
  <section class="owner-section cloudflare-control" :class="{ 'connection-compact': compactConnection }" :aria-labelledby="mode === 'overview' ? 'cloudflare-connection-heading' : 'connection-configuration-heading'" :aria-busy="loading || busy">
    <div class="section-heading-row">
      <div><h2 v-if="mode === 'overview'" id="cloudflare-connection-heading">{{ ui('Cloudflare connection', 'Cloudflare 连接') }}</h2><h2 v-else id="connection-configuration-heading">{{ ui('Usage settings', '用量设置') }}</h2><p v-if="mode === 'usage'">{{ ui('Manage usage and access limits for this instance.', '管理此实例的用量与访问限制。') }}</p></div>
      <UButton v-if="!connection || (unresolved && !tokenFeedbackMessage) || (mode === 'usage' && connectionAction === 'verify')" color="neutral" variant="outline" type="button" :disabled="loading || busy" @click="verify">{{ ui('Check current status', '检查当前状态') }}</UButton>
      <a v-else-if="mode === 'usage'" href="/app/admin">{{ ui('Manage Token in Overview', '在概览管理 Token') }}</a>
    </div>
    <ErrorNotice v-if="failed && !tokenFeedbackMessage" :error="unresolved ? ui('The last change is not confirmed. Check its result before making another change.', '上次修改尚未确认，请先检查结果，再进行其他变更。') : ui('The current status is temporarily unavailable. Check it again before changing settings.', '暂时无法读取当前状态，请重新检查后再修改设置。')" />
    <div v-if="tokenFeedbackMessage" class="token-feedback" :data-state="tokenFeedback">
      <ErrorNotice v-if="tokenFeedback === 'rejected' || tokenFeedback === 'failed'" :error="tokenFeedbackMessage" />
      <p v-else :class="unresolved ? 'warning-panel' : 'muted-copy'" :role="unresolved ? 'alert' : 'status'">{{ tokenFeedbackMessage }}</p>
      <UButton v-if="unresolved" color="neutral" variant="outline" type="button" :disabled="loading || busy" @click="verify">{{ ui('Check save result', '检查保存结果') }}</UButton>
    </div>
    <p v-if="loading" role="status" class="muted-copy">{{ ui('Reading connection…', '正在读取连接…') }}</p>
    <template v-if="connection">
      <p v-if="mode === 'overview'" class="connection-summary" role="status"><strong>{{ connectionSummary }}</strong><span v-if="connection.target.worker_name"> · {{ connection.target.worker_name }}</span></p>
      <p v-if="mode === 'overview' && compactConnection" class="required-capability-summary">{{ requiredCapabilitySummary }}</p>
      <dl v-if="mode === 'usage' && visibleCapabilities.length" class="connection-capabilities"><div v-for="entry in visibleCapabilities" :key="entry.key"><dt>{{ entry.label }}</dt><dd>{{ capabilityStatus(entry.key) }}</dd></div></dl>
      <p v-if="connectionNextStep" class="muted-copy connection-next-step">{{ connectionNextStep }}</p>
      <p v-if="usageNextStep" class="muted-copy connection-next-step">{{ usageNextStep }}</p>
      <p v-if="!fixedTargetReady" class="warning-panel">{{ ui('The deployment target is incomplete. Ask the deployment Agent to verify this instance first.', '部署目标不完整，请先让部署 Agent 核对当前实例。') }}</p>
      <p v-if="mode === 'usage' && connectionAction === 'verify'" class="muted-copy"><a href="/app/admin">{{ ui('Manage Cloudflare connection in Overview', '在概览中管理 Cloudflare 连接') }}</a></p>
      <details v-if="mode === 'overview'" class="connection-management" :open="connectionManagementOpen" @toggle="connectionManagementOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ compactConnection ? ui('Change Token or view details', '更换 Token 或查看详情') : ui('Token and function details', 'Token 与功能详情') }}</summary>
        <section aria-labelledby="connection-tokens-heading">
          <h3 id="connection-tokens-heading" class="sr-only">{{ ui('Token settings', 'Token 设置') }}</h3>
          <p v-if="hasConfigurationAuthorization && !connection.configured.connection" class="muted-copy">{{ ui('Existing authorization remains available. Saving one connection Token replaces it for these settings and statistics.', '现有授权仍可使用；保存统一连接 Token 后，这些设置与统计将共用新连接。') }}</p>
          <CloudflareTokenForm :key="`connection:${readbackGeneration}`" kind="connection" :label="ui('Cloudflare API Token', 'Cloudflare API Token')" :description="ui('Saved securely in Cloudflare. Saving updates this instance and clears the input; the Token will not be shown again.', 'Token 安全保存在 Cloudflare。保存会更新此实例并清空输入，Token 不会再次显示。')" :disabled="!writable" :save="saveToken" />
          <div class="capability-heading"><h3>{{ ui('Available functions', '可用功能') }}</h3><div class="capability-check-actions"><UButton v-if="!unresolved" color="neutral" variant="outline" size="sm" type="button" :disabled="loading || busy" @click="verify">{{ ui('Check again', '重新检查') }}</UButton><UButton v-if="!unresolved" color="neutral" variant="outline" size="sm" type="button" :disabled="loading || busy" @click="checkOptional">{{ ui('Check other functions', '检查其他功能') }}</UButton></div></div>
          <p class="muted-copy capability-explanation">{{ ui('Checks apply to the functions below. Open a row for permissions and details; optional functions are checked only when requested.', '检查结果对应以下功能。展开可查看权限和详情，可选功能仅在主动检查时读取。') }}</p>
          <div class="capability-list">
            <details v-for="entry in capabilities" :key="entry.key" class="capability-item" :data-state="capabilityTone(entry.key)" :open="expandedCapabilities.has(entry.key) || previewCapability === entry.key" :data-preview="!expandedCapabilities.has(entry.key) && previewCapability === entry.key" @pointerenter="enterCapability(entry.key, $event)" @pointerleave="previewCapability = null" @focusin="previewCapability = entry.key" @focusout="leaveCapabilityFocus">
              <summary class="capability-summary" @click.prevent="toggleCapabilityDetails(entry.key)">
                <UIcon :name="capabilityTone(entry.key) === 'verified' ? 'i-lucide-circle-check' : capabilityTone(entry.key) === 'denied' ? 'i-lucide-circle-x' : 'i-lucide-circle-minus'" class="capability-icon" aria-hidden="true" />
                <span class="capability-label">{{ entry.label }}<span v-if="!entry.required" class="capability-optional">{{ ui('Optional', '可选') }}</span></span>
                <span class="capability-result">{{ capabilityStatus(entry.key) }}<small>{{ capabilitySource(entry.key) }}</small></span>
                <UIcon name="i-lucide-chevron-down" class="capability-chevron" aria-hidden="true" />
              </summary>
              <div class="capability-info">
                <dl><div><dt>{{ ui('Permissions', '所需权限') }}</dt><dd>{{ entry.permissions }}</dd></div><div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ entry.scope }}</dd></div><div><dt>{{ ui('Where to select', 'Cloudflare 选择路径') }}</dt><dd>{{ entry.path }}</dd></div></dl>
                <p>{{ entry.explanation }}</p>
                <p class="muted-copy">{{ ui('Checked authorization', '检查的授权') }}：{{ capabilitySource(entry.key) }}</p>
                <p v-if="entry.key === 'waf' && !connection.target.zone_id" class="muted-copy">{{ ui('Select this domain’s Zone in Usage & limits before checking.', '请先在“用量与限额”选择此域名的 Zone，再检查此功能。') }}</p>
              </div>
            </details>
          </div>
          <details class="connection-guide">
            <summary>{{ ui('Create a Token and check permissions', '创建 Token 与核对权限') }}</summary>
            <p>{{ ui('In Manage Account → Account API Tokens → Create Token, select the target account shown below and create one account-owned Token with these permissions.', '在 Manage Account（管理账户）→ Account API Tokens（账户 API Token）→ Create Token（创建 Token）中，选择下方目标账户，为同一个 account-owned Token 添加以下权限。') }}</p>
            <section class="token-permission-group" aria-labelledby="token-required-permissions-heading">
              <h4 id="token-required-permissions-heading">{{ ui('Required permissions', '必需权限') }}</h4>
              <ul class="token-permission-list">
                <li>
                  <strong>{{ ui('Current Worker · Editor', '当前 Worker · Editor') }}</strong>
                  <dl>
                    <div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ ui('Specified Workers → select this existing Worker:', 'Specified Workers（指定的 Workers）→ 选择当前已存在的 Worker：') }} <span>{{ connection.target.worker_name ?? ui('Unknown', '未知') }}</span></dd></div>
                    <div><dt>{{ ui('Cloudflare selection', 'Cloudflare 选择路径') }}</dt><dd>{{ ui('Developer Platform → Individual Workers → Editor', 'Developer Platform（开发者平台）→ Individual Workers → Editor') }}</dd></div>
                    <div><dt>{{ ui('Use', '用途') }}</dt><dd>{{ ui('Save the connection and change request-rate or usage settings. Editor also grants this Worker’s code, deployment, Secret, and configuration modification authority.', '保存连接、修改访问频率与用量设置。Editor 同时包含该 Worker 的代码修改、部署、Secret 与配置修改权。') }}</dd></div>
                  </dl>
                  <p class="muted-copy">{{ ui('Do not select account-wide Workers Editor or Admin.', '不要选择全账户的 Workers Editor 或 Admin。') }}</p>
                </li>
                <li>
                  <strong>Account Analytics · Read</strong>
                  <dl>
                    <div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ ui('Target account only:', '仅目标账户：') }} {{ connection.target.account_id ?? ui('Unknown', '未知') }}</dd></div>
                    <div><dt>{{ ui('Cloudflare selection', 'Cloudflare 选择路径') }}</dt><dd>{{ ui('Analytics & Logs → Account Analytics → Read', 'Analytics & Logs（分析和日志）→ Account Analytics（账户分析）→ Read') }}</dd></div>
                    <div><dt>{{ ui('Use', '用途') }}</dt><dd>{{ ui('Read Workers, D1, and R2 usage. D1 SQL and R2 object editing permissions are not required.', '读取 Workers、D1 与 R2 用量，无需 D1 SQL 或 R2 对象编辑权。') }}</dd></div>
                  </dl>
                </li>
              </ul>
            </section>
            <section class="token-permission-group" aria-labelledby="token-optional-permissions-heading">
              <h4 id="token-optional-permissions-heading">{{ ui('Optional read permissions', '可选读取权限') }}</h4>
              <ul class="token-permission-list">
                <li>
                  <strong>Billing · Read</strong>
                  <dl>
                    <div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ ui('Target account only:', '仅目标账户：') }} {{ connection.target.account_id ?? ui('Unknown', '未知') }}</dd></div>
                    <div><dt>{{ ui('Cloudflare selection', 'Cloudflare 选择路径') }}</dt><dd>{{ ui('Account & Billing → Billing → Read', 'Account & Billing（账户与账务）→ Billing → Read') }}</dd></div>
                    <div><dt>{{ ui('Use', '用途') }}</dt><dd>{{ ui('Read billing and plan information.', '读取账务与方案信息。') }}</dd></div>
                  </dl>
                </li>
                <li>
                  <strong>Notifications · Read</strong>
                  <dl>
                    <div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ ui('Target account only:', '仅目标账户：') }} {{ connection.target.account_id ?? ui('Unknown', '未知') }}</dd></div>
                    <div><dt>{{ ui('Cloudflare selection', 'Cloudflare 选择路径') }}</dt><dd>{{ ui('Account & Billing → Notifications → Read', 'Account & Billing（账户与账务）→ Notifications → Read') }}</dd></div>
                    <div><dt>{{ ui('Use', '用途') }}</dt><dd>{{ ui('Read existing notification policies. Account-owned Token compatibility is checked through actual reads.', '读取已有通知策略；account-owned Token 兼容性以实际读取核验为准。') }}</dd></div>
                  </dl>
                </li>
                <li>
                  <strong>Zone · Read</strong>
                  <dl>
                    <div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ ui('Specified Zone for this domain only:', '仅指定当前域名所属的 Zone：') }} {{ connection.target.hostname ?? ui('Hostname unknown', '域名未知') }} · {{ connection.target.zone_id ?? ui('Zone not selected', '尚未选择 Zone') }}</dd></div>
                    <div><dt>{{ ui('Cloudflare selection', 'Cloudflare 选择路径') }}</dt><dd>{{ ui('DNS & Zones → Zone → Read', 'DNS & Zones（DNS 和区域）→ Zone → Read') }}</dd></div>
                    <div><dt>{{ ui('Use', '用途') }}</dt><dd>{{ ui('Verify the selected Zone belongs to the target account and domain.', '核验所选 Zone 属于目标账户与当前域名。') }}</dd></div>
                  </dl>
                </li>
                <li>
                  <strong>Zone WAF Rules · Read</strong>
                  <dl>
                    <div><dt>{{ ui('Scope', '范围') }}</dt><dd>{{ ui('The same specified Zone for this domain; not Account WAF.', '当前域名的同一个指定 Zone；不是 Account WAF。') }}</dd></div>
                    <div><dt>{{ ui('Cloudflare selection', 'Cloudflare 选择路径') }}</dt><dd>{{ ui('App Security → Zone WAF Rules → Read', 'App Security（应用安全）→ Zone WAF Rules → Read') }}</dd></div>
                    <div><dt>{{ ui('Use', '用途') }}</dt><dd>{{ ui('Read existing WAF rules for this Zone.', '读取该 Zone 已有的 WAF 规则。') }}</dd></div>
                  </dl>
                </li>
              </ul>
              <p class="muted-copy">{{ ui('No optional Edit permissions are required. Missing permissions or unsupported Token compatibility affect only the corresponding capability; other verified capabilities remain available.', '可选能力无需 Edit 权限。缺少权限或 Token 兼容性未确认，只影响对应能力，其他已核验能力仍可用。') }}</p>
            </section>
            <p class="muted-copy">{{ ui('The creator needs account Super Administrator or API Token Provisioning authority. Do not add API Tokens Write or other Token-management permissions to the connection Token. Verify a replacement before revoking the old Token.', '创建者需要账户 Super Administrator 或 API Token Provisioning 授权；连接 Token 无需 API Tokens Write 或其他 Token 管理权限。轮换时先核验新连接，再撤销旧 Token。') }}</p>
            <p><a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noopener noreferrer">{{ ui('Open Account API Tokens', '打开 Account API Tokens') }}</a> · <a href="https://developers.cloudflare.com/workers/authorization/workers/" target="_blank" rel="noopener noreferrer">{{ ui('Official permissions guide', '官方权限说明') }}</a> · <a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Permissions and recovery guide', '权限与恢复指南') }}</a></p>
            <dl class="connection-target"><div><dt>{{ ui('Target account', '目标账户') }}</dt><dd>{{ connection.target.account_id ?? ui('Unknown', '未知') }}</dd></div><div><dt>{{ ui('Target Worker', '目标 Worker') }}</dt><dd>{{ connection.target.worker_name ?? ui('Unknown', '未知') }}</dd></div><div><dt>{{ ui('Database', '数据库') }}</dt><dd>{{ connection.target.database_id ?? ui('Unknown', '未知') }}</dd></div></dl>
            <p class="muted-copy">{{ ui('These targets belong to this instance and cannot be changed on this page. A saved Secret alone does not confirm active deployment.', '这些目标属于当前实例，不能在此页面更改；仅保存 Secret 不表示部署已核验生效。') }}</p>
          </details>
        </section>
      </details>
      <section v-if="operation && operation.status !== 'verified' && !tokenFeedbackMessage" class="connection-section" aria-labelledby="connection-operation-heading">
        <h3 id="connection-operation-heading">{{ ui('Last change', '最近修改') }}</h3><p role="status">{{ status(operation.status) }}</p>
        <p class="muted-copy">{{ operation.status === 'failed' ? operationFailureExplanation(operation.failure_class) : ui('The change is not confirmed active. Check its result before saving again.', '修改尚未确认生效，请先检查结果，再进行保存。') }}</p>
        <details><summary>{{ ui('View details', '查看详情') }}</summary><dl class="connection-target"><div><dt>{{ ui('Record', '记录') }}</dt><dd>{{ operation.operation_id }}</dd></div><div v-if="operation.result_version_id"><dt>{{ ui('Saved version', '保存版本') }}</dt><dd>{{ operation.result_version_id }}</dd></div></dl></details>
      </section>
      <details v-else-if="operation && !compactConnection" class="connection-section" aria-labelledby="connection-operation-heading"><summary id="connection-operation-heading">{{ ui('Change record', '修改记录') }}</summary><p role="status">{{ status(operation.status) }}</p><dl class="connection-target"><div><dt>{{ ui('Record', '记录') }}</dt><dd>{{ operation.operation_id }}</dd></div><div v-if="operation.result_version_id"><dt>{{ ui('Saved version', '保存版本') }}</dt><dd>{{ operation.result_version_id }}</dd></div></dl></details>
      <section v-if="mode === 'usage'" class="connection-section usage-setting-editor" aria-labelledby="usage-setting-heading">
        <h3 id="usage-setting-heading">{{ ui('Change a usage setting', '修改用量设置') }}</h3><p class="muted-copy">{{ ui('Check your actual Workers/D1 plan and UTC billing start day in Cloudflare Billing before declaring them here. Account totals are optional; reminders do not cap charges. Review each change before confirming the save.', '请先在 Cloudflare 账单中核对实际 Workers/D1 方案和 UTC 账期起始日，再在此声明。账户汇总为可选项，提醒不会封顶费用。每次修改先核对，再确认保存。') }}</p><p class="muted-copy">{{ ui('Current value', '当前值') }}: {{ configurationText(currentConfiguration) }}</p>
        <form class="control-form" @submit.prevent="preview('configuration')"><label>{{ ui('Setting', '设置项') }}<USelect :disabled="!writable || !hasConfiguration" v-model="configurationField" :items="configurationFields" /></label><label>{{ ui('New value', '新值') }}<USelect v-if="['history_enabled', 'analytics_enabled', 'account_totals'].includes(configurationField)" :disabled="!writable || !hasConfiguration" v-model="configurationSelection" :items="booleanOptions" :placeholder="ui('Choose…', '请选择…')" /><USelect v-else-if="configurationField === 'billing_plan'" :disabled="!writable || !hasConfiguration" v-model="configurationSelection" :placeholder="ui('Choose…','请选择…')" :items="[{value:'unknown',label:ui('Unknown','未知')},{value:'free',label:'Free'},{value:'paid',label:'Paid'}]" /><UInput v-else :disabled="!writable || !hasConfiguration" v-model="configurationValue" type="number" min="1" :max="configurationField === 'billing_cycle_day' ? 31 : 100" step="1" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable || !hasConfiguration">{{ ui('Review change', '检查修改') }}</UButton></form>
      </section>
      <section v-if="mode === 'usage'" class="connection-section" aria-labelledby="connection-rate-heading">
        <h3 id="connection-rate-heading">{{ ui('Request frequency limits', '访问频率限制') }}</h3><p class="muted-copy">{{ ui('Choose a scope and enter the new limit. Review the change before confirming. Limits can have brief discrepancies and do not cap charges.', '选择范围并输入新限制，核对修改后再确认保存。限制可能存在短时误差，不能封顶费用。') }}</p><p class="muted-copy">{{ ui('Current limit', '当前限制') }}: {{ currentRate ? `${currentRate.limit} / ${currentRate.period_seconds} ${ui('seconds', '秒')}` : ui('Unknown', '未知') }}</p>
        <p v-if="rateUnavailableReason" class="warning-panel rate-unavailable" role="status">{{ rateUnavailableReason }} <a href="/app/admin">{{ ui('Open Overview', '前往概览') }}</a></p>
        <form v-if="!rateUnavailableReason" class="control-form" @submit.prevent="preview('rate_limit')"><label>{{ ui('Scope', '范围') }}<USelect :disabled="!writable || !hasConfiguration" v-model="rateScope" :items="rateScopes" /></label><label>{{ ui('Maximum requests', '最多请求数') }}<UInput :disabled="!writable || !hasConfiguration" v-model="rateLimit" type="number" min="1" step="1" /></label><label>{{ ui('Duration', '统计时长') }}<USelect :disabled="!writable || !hasConfiguration" v-model="ratePeriod" :placeholder="ui('Choose…','请选择…')" :items="[{value:'10',label:ui('10 seconds','10 秒')},{value:'60',label:ui('60 seconds','60 秒')}]" /></label><UButton color="neutral" variant="outline" type="submit" :disabled="!writable || !hasConfiguration">{{ ui('Change limit', '修改限制') }}</UButton></form>
      </section>
      <p v-if="validation" class="warning-panel" role="alert">{{ ui('Choose a value within the displayed range. Maximum requests must be a positive integer and the duration must be 10 or 60 seconds.', '请选择显示范围内的值；最多请求数必须为正整数，统计时长只能为 10 或 60 秒。') }}</p>
      <section v-if="plan" class="connection-section configuration-plan" aria-labelledby="connection-plan-heading">
        <h3 id="connection-plan-heading">{{ ui('Review your change', '核对修改') }}</h3><p>{{ plan.target.worker_name }}</p>
        <table class="plan-comparison"><thead><tr><th>{{ ui('Setting', '设置项') }}</th><th>{{ ui('Before', '变更前') }}</th><th>{{ ui('After', '变更后') }}</th></tr></thead><tbody><tr v-for="row in planRows" :key="row.label"><th scope="row">{{ row.label }}</th><td>{{ row.before }}</td><td>{{ row.after }}</td></tr></tbody></table>
        <p class="muted-copy">{{ plan.kind === 'rate_limit' ? ui('Confirming saves the access limit for this instance.', '确认后会更新此实例的访问限制。') : ui('Confirming saves this setting for the current instance.', '确认后会更新此实例的设置。') }}</p>
        <details class="connection-guide"><summary>{{ ui('More details', '详细信息') }}</summary><p>{{ plan.target.account_id }} · {{ plan.target.database_id }}</p><p>{{ ui('Current version', '当前版本') }}: {{ plan.baseline_version_id ?? ui('Unknown', '未知') }} · {{ ui('Deployment', '部署') }}: {{ plan.baseline_deployment_id ?? ui('Unknown', '未知') }}</p><pre>{{ JSON.stringify({ before: plan.before, after: plan.after }, null, 2) }}</pre></details>
        <UButton color="primary" variant="solid" type="button" :disabled="!writable || !hasConfiguration" @click="apply">{{ ui('Confirm save', '确认保存') }}</UButton>
      </section>
      <template v-if="mode === 'usage'">
        <h3 class="connection-section">{{ ui('Budget & optional reads', '预算与可选读取') }}</h3>
        <details class="connection-section" aria-labelledby="connection-budget-heading"><summary id="connection-budget-heading">{{ ui('Cloudflare USD budget alerts', 'Cloudflare USD 预算警报') }}</summary><p>{{ status(connection.budget.status) }}</p><p class="muted-copy">{{ ui('Cloudflare Budget Alerts notify selected email recipients about cumulative usage-based account charges. They are separate from cfKanban’s percentage-based allowance reminders and do not stop usage or cap charges. Manage USD thresholds and recipients in Cloudflare.', 'Cloudflare Budget Alerts 将账户累计按量费用提醒发送到指定邮件，与 cfKanban 按百分比计算的额度提醒独立，不会停止用量或封顶费用。请在 Cloudflare 管理美元预算与收件人。') }}</p><a :href="safeLink(connection.budget.dashboard_url, 'https://dash.cloudflare.com/')" target="_blank" rel="noopener noreferrer">{{ ui('Manage budgets in Cloudflare', '在 Cloudflare 管理预算') }}</a> · <a :href="safeLink(connection.budget.docs_url, 'https://developers.cloudflare.com/billing/manage/budget-alerts/')" target="_blank" rel="noopener noreferrer">{{ ui('Budget Alerts guide', '预算警报指南') }}</a></details>
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
.token-permission-group { margin: 24px 0; }
.token-permission-group h4 { margin: 0 0 12px; font-size: 15px; }
.token-permission-list { margin: 0; padding-left: 20px; }
.token-permission-list li { padding: 12px 0; }
.token-permission-list li + li { border-top: 1px solid var(--color-border); }
.token-permission-list dl { margin: 8px 0 0; }
.token-permission-list dl > div { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; margin-top: 8px; }
.token-permission-list dt { color: var(--color-text-muted); font-size: 13px; }
.token-permission-list dd { margin: 0; overflow-wrap: anywhere; }
.token-permission-list p { margin: 8px 0 0; }
.connection-summary { margin: 16px 0 12px; }
.connection-capabilities { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 12px 0 20px; }
.connection-capabilities > div { display: flex; flex-wrap: wrap; gap: 8px; }
.connection-capabilities dt { color: var(--color-text-muted); }
.connection-capabilities dd { margin: 0; }
.connection-management, .connection-guide { margin: 16px 0; }
.connection-compact .connection-summary { margin: 10px 0 4px; }
.connection-compact .connection-management { margin: 8px 0 0; }
.required-capability-summary { margin: 0; font-size: 13px; color: var(--color-text-muted); overflow-wrap: anywhere; }
.token-feedback { margin: 12px 0; }
.token-feedback > button { margin-top: 8px; }
.token-feedback p { margin-bottom: 0; }
.capability-heading { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-top: 16px; }
.capability-heading h3 { margin: 0; }
.capability-check-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.capability-explanation { margin: 8px 0 12px; font-size: 13px; }
.capability-list { display: grid; gap: 4px; margin: 12px 0 20px; }
.capability-item { position: relative; min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.capability-summary { display: flex; gap: 10px; align-items: center; padding: 10px 12px; list-style: none; font-weight: 500; }
.capability-summary::-webkit-details-marker { display: none; }
.capability-summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: var(--radius-control); }
.capability-icon { flex: 0 0 20px; width: 20px; height: 20px; color: var(--color-text-muted); }
.capability-item[data-state="verified"] .capability-icon { color: var(--color-success); }
.capability-item[data-state="denied"] .capability-icon { color: var(--color-danger); }
.capability-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.capability-optional { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--color-text-muted); }
.capability-result { flex: 0 1 40%; min-width: 0; font-size: 13px; text-align: right; overflow-wrap: anywhere; }
.capability-chevron { flex: 0 0 14px; width: 14px; height: 14px; color: var(--color-text-muted); }
.capability-item[open] .capability-chevron { transform: rotate(180deg); }
.capability-result small { display: block; font-size: 12px; color: var(--color-text-muted); }
.capability-info { padding: 12px; background: var(--color-surface); border-top: 1px solid var(--color-border); font-size: 13px; overflow-wrap: anywhere; }
.capability-info dl { display: grid; gap: 8px; margin: 0; }
.capability-info dl > div { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; }
.capability-info dt { color: var(--color-text-muted); }
.capability-info dd { margin: 0; }
.capability-info p { margin: 12px 0; }
.capability-item[open] .capability-info { display: block; }
@media (hover: hover) and (min-width: 601px) {
  .capability-item[data-preview="true"] .capability-info { display: block; position: absolute; inset: 100% -1px auto; z-index: 20; border: 1px solid var(--color-border); border-radius: var(--radius-card); box-shadow: var(--shadow-overlay); }
}
@media (max-width: 600px) { .capability-summary { align-items: start; padding: 10px; } .capability-result { flex-basis: 42%; } .capability-info dl > div { grid-template-columns: 1fr; gap: 3px; } }
summary { cursor: pointer; font-weight: 600; }
.connection-guide pre { overflow-x: auto; padding: 12px; background: var(--color-surface-muted); font-size: 13px; }
.plan-comparison { width: 100%; border-collapse: collapse; margin: 16px 0; }
.plan-comparison th, .plan-comparison td { padding: 12px 8px; border-bottom: 1px solid var(--color-border); text-align: left; overflow-wrap: anywhere; }
.plan-comparison thead th { color: var(--color-text-muted); font-size: 13px; }
.configuration-plan > button { margin-top: 12px; }
.notification-policies { padding-left: 20px; }
.notification-policies li { padding: 8px 0; }
.notification-policies p { margin: 4px 0; overflow-wrap: anywhere; }
@media (max-width: 600px) { .connection-target { grid-template-columns: 1fr; } .control-form label { width: 100%; } .token-permission-list dl > div { grid-template-columns: 1fr; gap: 4px; } }
</style>
