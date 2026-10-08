<script lang="ts">
interface RecoverableTokenSave { key: string; operationId: string | null }
const recoverableTokenSaves = new Map<string, RecoverableTokenSave>();
interface RecoverableSettingsChange { key: string; operationId: string | null; verifyKey: string | null; path: string; draft: Record<string, string> }
const recoverableSettingsChanges = new Map<string, RecoverableSettingsChange>();
if (typeof window !== "undefined") {
  const clearRecovery = () => { recoverableTokenSaves.clear(); recoverableSettingsChanges.clear(); };
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
import { isWafOperation } from "../lib/cloudflare-waf";
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
const operationKinds = new Set(["configuration_secret", "control_secret", "analytics_secret", "configuration", "rate_limit", "waf"]);
const operationStatuses = new Set(["pending", "verified", "failed", "unknown"]);
const capabilityStates = new Set(["missing", "unverified", "verified", "permission_denied", "unavailable", "target_mismatch", "unsupported_contract"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nullableText(value: unknown): boolean { return value === null || typeof value === "string"; }
function isOperation(value: unknown): value is Operation {
  if (record(value) && value.kind === "waf") return isWafOperation(value);
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
type ConfigurationField = "history_enabled" | "analytics_enabled" | "billing_plan" | "billing_cycle_day" | "account_totals";
type RateScope = "instance" | "principal" | "unauthenticated_sensitive" | "anonymous_login" | "expensive_reads";
type RateValue = { limit: number; period_seconds: number };
const configurationKeys: ConfigurationField[] = ["analytics_enabled", "history_enabled", "account_totals", "billing_plan", "billing_cycle_day"];
const props = withDefaults(defineProps<{ mode?: "overview" | "usage"; session?: Pick<WebSessionView, "session_id" | "principal"> }>(), { mode: "usage" });
const emit = defineEmits<{ applied: []; rates: [value: RateLimitSettings] }>();
const base = "/api/v1/admin/cloudflare";
const recoveryPartition = () => props.session ? `${window.location.origin}\n${props.session.principal.id}\n${props.session.session_id}` : null;
const restoredTokenSave = recoveryPartition() ? recoverableTokenSaves.get(recoveryPartition()!) ?? null : null;
const restoredSettingsChange = recoveryPartition() ? recoverableSettingsChanges.get(recoveryPartition()!) ?? null : null;
let contextGeneration = 0;
const isCurrent = (generation: number) => !disposed && contextGeneration === generation;
const connection = ref<Connection | null>(null);
const operation = ref<Operation | null>(null);
const tokenOperation = ref<Operation | null>(null);
const rateSettings = ref<RateLimitSettings | null>(null);
const ratesFailed = ref(false);
const settingsOperation = ref<Operation | null>(null);
const editorProblem = ref<"preview_failed" | "changed" | "apply_rejected" | null>(null);
const editorRecovery = ref(false);
const loading = ref(false);
const busy = ref(false);
const settingsSaving = ref(false);
const capabilitiesChecking = ref(false);
const failed = ref(false);
const uncertain = ref(Boolean(restoredTokenSave || restoredSettingsChange));
const uncertainChangeBaseline = ref<RecoverableSettingsChange | null>(restoredSettingsChange);
type TokenFeedback = "saved" | "rejected" | "failed" | "pending" | "unknown" | "capabilities_unavailable" | "readback_unavailable";
const tokenFeedback = ref<TokenFeedback | null>(restoredTokenSave ? "unknown" : null);
const tokenProblem = ref<ApiProblem | null>(null);
const tokenWrite = ref<RecoverableTokenSave | null>(restoredTokenSave);
const confirmingTokenSave = computed(() => busy.value && Boolean(tokenWrite.value) && tokenOperation.value?.status === "unknown" && tokenOperation.value.failure_class === "secret_readback_pending");
const tokenLookupMissing = ref(false);
const optionalCheckFailed = ref(false);
const drafts = ref<Record<string, string>>({ ...restoredSettingsChange?.draft });
const validation = ref(false);
let readController = new AbortController();
let disposed = false;
let planGeneration = 0;
let controlReadGeneration = 0;
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const unresolved = computed(() => uncertain.value || operation.value?.status === "pending" || operation.value?.status === "unknown");
const fixedTargetReady = computed(() => Boolean(connection.value?.target.account_id && connection.value?.target.worker_name && connection.value?.target.database_id));
const writable = computed(() => fixedTargetReady.value && !loading.value && !busy.value && !failed.value && !unresolved.value);
const hasConfiguration = computed(() => connection.value?.capabilities.configuration === "verified");
const hasConfigurationAuthorization = computed(() => Boolean(connection.value?.configured.connection || connection.value?.configured.configuration));
const tokenSaved = computed(() => Boolean(connection.value?.configured.connection || connection.value?.configured.configuration || connection.value?.configured.analytics));
const needsTokenHelp = computed(() => !tokenSaved.value || connection.value?.capabilities.configuration === "missing" || tokenFeedback.value === "rejected" || tokenFeedback.value === "failed"
  || connection.value?.capabilities.configuration === "permission_denied" || connection.value?.capabilities.configuration === "target_mismatch");
type CapabilityKey = keyof Connection["capabilities"];
const capabilities = computed(() => [
  { key: "configuration" as const, label: ui("Instance settings", "实例设置"),
    permissions: "Developer Platform → Individual Workers → Editor",
    explanation: ui("The current check confirms configuration reads. Permission to save is checked when you save a change.", "当前检查确认配置可读取；保存权限会在实际保存时核验。") },
  { key: "analytics" as const, label: ui("Usage analytics", "用量统计"),
    permissions: "Analytics & Logs → Account Analytics → Read",
    explanation: ui("Checks usage access for this instance. Each metric reports its own availability.", "检查此实例的用量读取能力，各项指标会分别显示是否可用。") },
]);
function capabilityState(key: CapabilityKey): string { return connection.value?.capabilities[key] ?? "unverified"; }
function capabilityStatus(key: CapabilityKey): string {
  if (capabilitiesChecking.value) return ui("Checking…", "正在检查…");
  if (key === "configuration" && capabilityState(key) === "verified") return ui("Configuration readable", "配置可读取");
  return status(capabilityState(key));
}
function capabilityTone(key: CapabilityKey): "verified" | "denied" | "neutral" {
  const value = capabilityState(key);
  return value === "verified" ? "verified" : value === "permission_denied" || value === "target_mismatch" ? "denied" : "neutral";
}
function operationFailureExplanation(value: string | null | undefined): string {
  if (value === "permission_denied") return ui("Cloudflare denied the save permission. Check the current Worker’s Editor permission and enter a replacement Token.", "Cloudflare 拒绝了保存权限，请核对当前 Worker 的 Editor 权限后重新输入 Token。");
  if (value === "target_mismatch") return ui("The Cloudflare target or active deployment did not match. Verify this instance before saving again.", "Cloudflare 目标或已生效部署不一致，请先核对当前实例再保存。");
  if (value === "preflight_changed") return ui("The active configuration changed during the safety check. Refresh its state and decide again.", "安全核对期间已生效配置发生变化，请刷新当前状态后重新决定。");
  return ui("Cloudflare confirmed the save failed. Check the connection and permissions before entering the Token again.", "Cloudflare 已确认保存失败，请检查连接与权限后重新输入 Token。");
}
function settingsFailureExplanation(value: string | null | undefined): string {
  if (value === "permission_denied") return ui("Cloudflare denied permission to change these settings. Check the Token permissions above.", "Cloudflare 拒绝了设置修改权限，请核对上方 Token 的权限。");
  if (value === "preflight_changed") return ui("The active settings changed. Review the current values before trying again.", "已生效设置发生变化，请核对当前值后重新修改。");
  if (value === "target_mismatch") return ui("The Worker did not match the saved target. Ask your deployment Agent to check this instance.", "Worker 与保存的目标不一致，请让部署 Agent 核对当前实例。");
  return ui("Cloudflare confirmed that this change failed. Review the current settings before trying again.", "Cloudflare 已确认本次修改失败，请核对当前设置后重新修改。");
}
const settingsFeedbackMessage = computed(() => {
  if (editorProblem.value === "changed") return ui("Settings changed elsewhere. Your draft is kept; review the current values before saving again.", "设置已被其他操作修改，草稿已保留，请核对当前值后再次保存。");
  if (editorProblem.value === "preview_failed") return ui("Could not prepare this change. Your draft is kept while the current settings are updated automatically.", "暂时无法核对修改，草稿已保留，系统会自动更新当前设置。");
  if (editorProblem.value === "apply_rejected") return ui("The settings change was not saved. Your draft is kept; review the current values before trying again.", "本次设置未保存，草稿已保留，请核对当前值后重新修改。");
  if (settingsOperation.value?.status === "failed") return `${ui("The settings change failed.", "设置保存失败。")} ${settingsFailureExplanation(settingsOperation.value.failure_class)}`;
  if (settingsOperation.value?.status === "verified") return ui("Settings saved.", "设置已保存。");
  if (uncertainChangeBaseline.value || settingsOperation.value && ["pending", "unknown"].includes(settingsOperation.value.status)) return ui("The settings change is awaiting confirmation. It will be checked automatically.", "设置修改的结果暂未确认，系统会自动继续确认。");
  return "";
});
const settingsFeedbackFailed = computed(() => Boolean(editorProblem.value) || settingsOperation.value?.status === "failed");
function recordSettingsOperation(value: Operation | null): void {
  if (value && ["configuration", "rate_limit"].includes(value.kind)) settingsOperation.value = value;
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
  else if (problem.body.details.write_state === "not_dispatched") reason = ui("The check stopped before the Secret write. Check the current status, then enter the Token again.", "检查在写入 Secret 前停止。请检查当前状态后重新输入 Token。");
  const providerFacts = providerFailureFacts(problem);
  if (providerFacts) diagnostics.unshift(providerFacts);
  return `${heading} ${reason}${diagnostics.length ? `\n${diagnostics.join("\n")}` : ""}`;
}
const tokenFeedbackMessage = computed(() => {
  if (tokenFeedback.value === "unknown" && tokenLookupMissing.value) return ui("This save record is not available yet. It will be checked automatically when you return to this page.", "暂未找到本次保存记录，返回此页时会自动继续确认。");
  if (tokenFeedback.value === "unknown") {
    if (confirmingTokenSave.value) return ui("Token update accepted. Confirming activation…", "Token 更新已提交，正在确认生效…");
    const message = ui("The save result is not confirmed yet. We will check it automatically before allowing another change.", "保存结果暂未确认，系统会自动继续确认，确认前无法进行其他修改。");
    const facts = providerFailureFacts(tokenProblem.value);
    return facts ? `${message}\n${facts} · ${ui("Request ID", "请求 ID")}: ${tokenProblem.value!.body.request_id}` : message;
  }
  if (tokenFeedback.value === "pending") return ui("Confirming your saved Token…", "正在确认 Token 保存结果…");
  if (tokenFeedback.value === "failed") return `${ui("Token save failed.", "Token 保存失败。")} ${operationFailureExplanation(tokenOperation.value?.failure_class)}`;
  if (tokenFeedback.value === "rejected") return rejectedTokenMessage(tokenProblem.value);
  if (tokenFeedback.value === "capabilities_unavailable") return ui("Token saved. Some services are temporarily unavailable; they will be checked automatically.", "Token 已保存，部分服务暂不可用，系统会自动重试。");
  if (tokenFeedback.value === "readback_unavailable") return ui("Token saved. The latest status is temporarily unavailable; it will be checked automatically.", "Token 已保存，暂时无法读取最新状态，系统会自动重试。");
  if (tokenFeedback.value === "saved") return capabilitiesChecking.value
    ? ui("Token saved and confirmed active. Checking function permissions…", "Token 已保存并确认生效，正在检查各项权限…")
    : ui("Token saved.", "Token 已保存。");
  return "";
});
const rateUnavailableReason = computed(() => {
  if (capabilitiesChecking.value || confirmingTokenSave.value) return "";
  if (!fixedTargetReady.value) return ui("This instance’s setup is incomplete. Ask your deployment Agent to check it.", "此实例的配置不完整，请让部署 Agent 检查。");
  if (unresolved.value) return ui("The last change is being confirmed. Settings remain locked until its result is known.", "上次修改的结果正在确认，确认前暂不能修改设置。");
  if (!hasConfigurationAuthorization.value) return ui("Save a Token above to change these settings.", "请先在顶部保存 Token，再修改设置。");
  if (!hasConfiguration.value || failed.value) return ui("Settings are temporarily unavailable. Review the Token status above.", "设置暂不可修改，请查看顶部的 Token 状态。");
  return "";
});
const rateScopes = computed(() => [
  { value: "instance" as const, label: ui("Instance API", "实例 API") }, { value: "principal" as const, label: ui("Single identity", "单一身份") },
  { value: "unauthenticated_sensitive" as const, label: ui("Unauthenticated sensitive actions", "未认证敏感操作") },
  { value: "anonymous_login" as const, label: ui("Anonymous login", "匿名登录") }, { value: "expensive_reads" as const, label: ui("Counts & title search", "计数与标题搜索") },
]);
const configurationFields = computed(() => [
  { value: "analytics_enabled" as const, label: ui("Usage collection", "用量采集"), help: ui("Collect usage for this instance.", "采集当前实例的用量数据。") },
  { value: "history_enabled" as const, label: ui("Daily usage history", "每日用量记录"), help: ui("Keep completed daily records for up to 90 days.", "保留完整日记录，最多 90 天。") },
  { value: "account_totals" as const, label: ui("Account totals", "账户汇总"), help: ui("Also collect totals across the Cloudflare account.", "同时采集 Cloudflare 账户内的用量汇总。") },
  { value: "billing_plan" as const, label: ui("Declared Cloudflare plan", "当前套餐声明"), help: ui("Declare your existing plan. This does not buy or change a subscription.", "填写现有套餐，不会购买或切换 Cloudflare 订阅。") },
  { value: "billing_cycle_day" as const, label: ui("Billing start day (UTC)", "账期起始日（UTC）"), help: ui("Use day 1–31 for billing-period totals, or leave blank if unknown.", "填写 1–31 日用于账期汇总；不确定时留空。") },
]);
const booleanOptions = computed(() => [{ value: "true", label: ui("Enabled", "启用") }, { value: "false", label: ui("Disabled", "停用") }]);
function configurationText(value: unknown): string {
  return value === undefined ? ui("Not loaded", "尚未读取") : value === null ? ui("Not specified", "未声明") : typeof value === "boolean" ? (value ? ui("Enabled", "启用") : ui("Disabled", "停用")) : value === "free" ? "Free" : value === "paid" ? "Paid" : String(value);
}
function rateText(value: Record<string, unknown>): string {
  return typeof value.limit === "number" && typeof value.period_seconds === "number" ? `${value.limit} / ${value.period_seconds} ${ui("seconds", "秒")}` : ui("Not loaded", "尚未读取");
}
function rateFor(scope: RateScope): RateValue | null {
  const settings = rateSettings.value;
  const value = scope === "anonymous_login" || scope === "expensive_reads" ? settings?.cost_protection?.[scope]?.policy : settings?.policies?.[scope];
  return value && Number.isSafeInteger(value.limit) && value.limit > 0 && [10, 60].includes(value.period_seconds) ? value : null;
}
function currentInput(key: string): string {
  if (key.includes(".")) { const [scope, field] = key.split("."); return String(rateFor(scope as RateScope)?.[field as keyof RateValue] ?? ""); }
  const value = connection.value?.configuration[key as ConfigurationField];
  return value === undefined ? "" : value === null ? (key === "billing_plan" ? "unknown" : "") : String(value);
}
function draftInput(key: string): string { return drafts.value[key] ?? currentInput(key); }
function updateDraft(key: string, value: string | number): void {
  if (busy.value || unresolved.value) return;
  if (String(value) === currentInput(key)) delete drafts.value[key]; else drafts.value[key] = String(value);
  validation.value = false; editorProblem.value = null; settingsOperation.value = null; planGeneration++;
}
function draftChanged(key: string): boolean {
  const draft = drafts.value[key], current = currentInput(key);
  if ((key.includes(".") || key === "billing_cycle_day") && draft?.trim() && current.trim()
    && Number.isFinite(Number(draft)) && Number(draft) === Number(current)) return false;
  return draft !== current;
}
const changedKeys = computed(() => Object.keys(drafts.value).filter(draftChanged));
const settingsReady = computed(() => configurationKeys.every(key => {
  const value = connection.value?.configuration[key];
  return key === "billing_plan" ? value === null || value === "free" || value === "paid"
    : key === "billing_cycle_day" ? value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 31 : typeof value === "boolean";
}));
const settingsEditable = computed(() => writable.value && hasConfiguration.value && settingsReady.value);
const changedRatesReady = computed(() => rateScopes.value.every(({ value: scope }) => !changedKeys.value.some(key => key.startsWith(`${scope}.`)) || Boolean(rateFor(scope))));
const changeRows = computed(() => [
  ...configurationFields.value.filter(field => changedKeys.value.includes(field.value)).map(field => ({ key: field.value, label: field.label,
    before: configurationText(connection.value?.configuration[field.value]),
    after: configurationText(["analytics_enabled", "history_enabled", "account_totals"].includes(field.value) ? draftInput(field.value) === "true" : draftInput(field.value) === "unknown" || draftInput(field.value) === "" ? null : draftInput(field.value)) })),
  ...rateScopes.value.filter(scope => changedKeys.value.some(key => key.startsWith(`${scope.value}.`))).map(scope => ({ key: scope.value, label: scope.label,
    before: rateText(rateFor(scope.value) ?? {}), after: `${draftInput(`${scope.value}.limit`) || "—"} / ${draftInput(`${scope.value}.period_seconds`) || "—"} ${ui("seconds", "秒")}` })),
]);
function discardDraft(): void {
  if (busy.value || unresolved.value) return;
  drafts.value = {}; validation.value = false; editorProblem.value = null; settingsOperation.value = null; planGeneration++;
}
function settingsPatch(): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const key of configurationKeys) {
    if (!changedKeys.value.includes(key)) continue;
    const input = draftInput(key);
    if (["history_enabled", "analytics_enabled", "account_totals"].includes(key)) { if (!["true", "false"].includes(input)) return null; patch[key] = input === "true"; }
    else if (key === "billing_plan") { if (!["unknown", "free", "paid"].includes(input)) return null; patch[key] = input === "unknown" ? null : input; }
    else { const day = input.trim() === "" ? null : Number(input); if (day !== null && (!Number.isSafeInteger(day) || day < 1 || day > 31)) return null; patch[key] = day; }
  }
  const rates: Record<string, RateValue> = {};
  for (const { value: scope } of rateScopes.value) {
    if (!changedKeys.value.some(key => key.startsWith(`${scope}.`))) continue;
    const limit = Number(draftInput(`${scope}.limit`)), period = Number(draftInput(`${scope}.period_seconds`));
    if (!rateFor(scope) || !Number.isSafeInteger(limit) || limit < 1 || ![10, 60].includes(period)) return null;
    rates[scope] = { limit, period_seconds: period };
  }
  if (Object.keys(rates).length) patch.rate_limits = rates;
  return patch;
}
function equalValues(left: unknown, right: unknown): boolean {
  if (record(left) && record(right)) { const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalValues(left[key], right[key])); }
  return left === right;
}
function isPlanWrite(value: unknown): boolean {
  return record(value) && record(value.resource) && value.resource.kind === "configuration" && typeof value.resource.plan_id === "string" && uuidPattern.test(value.resource.plan_id)
    && Number.isSafeInteger(value.resource.version) && record(value.resource.before) && record(value.resource.after) && record(value.resource.target)
    && typeof value.event_cursor === "string" && typeof value.idempotent_replay === "boolean";
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
async function load(): Promise<void> {
  const requestContext = contextGeneration;
  const request = ++controlReadGeneration;
  const current = () => isCurrent(requestContext) && request === controlReadGeneration;
  loading.value = true; failed.value = false;
  try {
    const result = await apiRequest<Connection>(base, { validateResponse: isConnection, authorizationCurrent: current, signal: readController.signal });
    if (!current() || (connection.value && connection.value.version > result.version)) return;
    connection.value = result;
    if (!tokenWrite.value || result.latest_operation?.operation_id === tokenWrite.value.operationId) operation.value = result.latest_operation;
    if (!settingsOperation.value || settingsOperation.value.operation_id === result.latest_operation?.operation_id) recordSettingsOperation(result.latest_operation);
  } catch { if (current()) failed.value = true; }
  finally { if (current()) loading.value = false; }
}
async function loadRates(): Promise<void> {
  const requestContext = contextGeneration;
  try {
    const result = await apiRequest<RateLimitSettings>("/api/v1/admin/rate-limit-settings", { authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal });
    if (!isCurrent(requestContext)) return;
    rateSettings.value = result; ratesFailed.value = false; emit("rates", result);
  } catch { if (isCurrent(requestContext)) { rateSettings.value = null; ratesFailed.value = true; } }
}
async function verifyCapabilities(): Promise<void> {
  const requestContext = contextGeneration;
  capabilitiesChecking.value = true;
  try {
    const result = await apiRequest<WriteResult<Connection>>(`${base}/verify`, { validateResponse: value => record(value) && isConnection(value.resource), authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
    if (!isCurrent(requestContext)) return;
    connection.value = result.resource; operation.value = result.resource.latest_operation;
    if (!tokenWrite.value) uncertain.value = false;
  } finally { if (isCurrent(requestContext)) capabilitiesChecking.value = false; }
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
  if (connection.value && value.version > connection.value.version) connection.value.version = value.version;
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
  } catch {
    if (isCurrent(requestContext)) tokenFeedback.value = "capabilities_unavailable";
  }
  if (!isCurrent(requestContext)) return;
  await loadRates();
  if (isCurrent(requestContext) && !unresolved.value) emit("applied");
}
async function verify(): Promise<void> {
  const requestContext = contextGeneration;
  if (busy.value || loading.value) return;
  busy.value = true; failed.value = false; optionalCheckFailed.value = false;
  let checkingCapabilities = false;
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
    const pendingSettings = uncertainChangeBaseline.value;
    if (pendingSettings) {
      let recovered: Operation;
      if (pendingSettings.operationId) {
        const verifyKey = pendingSettings.verifyKey ?? crypto.randomUUID();
        setUncertainChange({ ...pendingSettings, verifyKey });
        const result = await apiRequest<WriteResult<Operation>>(`${base}/operations/${encodeURIComponent(pendingSettings.operationId)}/verify`, { validateResponse: value => isOperationWrite(value, pendingSettings.operationId!) && record(value) && record(value.resource) && value.resource.kind === "configuration", authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: {}, idempotencyKey: verifyKey });
        if (!isCurrent(requestContext)) return;
        setUncertainChange({ ...pendingSettings, verifyKey: null });
        recovered = result.resource;
      } else {
        recovered = await apiRequest<Operation>(`${base}/configuration/operations/${encodeURIComponent(pendingSettings.key)}`, { validateResponse: value => isOperation(value) && value.kind === "configuration", authorizationCurrent: () => isCurrent(requestContext), signal: readController.signal });
      }
      if (!isCurrent(requestContext)) return;
      recordSettingsResult(recovered);
      if (unresolved.value) return;
    }
    await Promise.all([load(), loadRates()]);
    if (!isCurrent(requestContext) || failed.value || !connection.value) return;
    if (operation.value && ["pending", "unknown"].includes(operation.value.status)) {
      const operationId = operation.value.operation_id;
      const result = await apiRequest<WriteResult<Operation>>(`${base}/operations/${encodeURIComponent(operationId)}/verify`, { validateResponse: value => isOperationWrite(value, operationId), authorizationCurrent: () => isCurrent(requestContext), method: "POST", body: {}, idempotencyKey: crypto.randomUUID() });
      if (!isCurrent(requestContext)) return; operation.value = result.resource; recordSettingsOperation(result.resource);
      if (["pending", "unknown"].includes(result.resource.status)) return;
    }
    checkingCapabilities = true;
    await verifyCapabilities();
    if (!isCurrent(requestContext)) return;
    if (uncertainChangeBaseline.value) clearPendingRequestIntents("POST", uncertainChangeBaseline.value.path);
    setUncertainChange(null);
    if (["capabilities_unavailable", "readback_unavailable"].includes(tokenFeedback.value ?? "")) tokenFeedback.value = "saved";
    if (isCurrent(requestContext) && !unresolved.value && settingsOperation.value?.status !== "failed") emit("applied");
  } catch {
    if (isCurrent(requestContext)) {
      if (tokenWrite.value) tokenFeedback.value = operation.value?.status === "pending" ? "pending" : "unknown";
      else if (checkingCapabilities) optionalCheckFailed.value = true;
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
  editorProblem.value = null; settingsOperation.value = null; editorRecovery.value = false;
  tokenLookupMissing.value = false;
  busy.value = true; failed.value = false; tokenProblem.value = null; tokenFeedback.value = null;
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
      if (savePartition && recoverableTokenSaves.get(savePartition)?.key === key && error instanceof ApiProblem && error.body.details.normalized_by !== "client"
        && ((error.status >= 400 && error.status < 500) || (error.status === 503 && error.body.source === "cloudflare_platform"
          && error.body.details.component === "cloudflare-control" && error.body.details.write_state === "not_dispatched"))) recoverableTokenSaves.delete(savePartition);
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
  if (!isCurrent(requestContext) || tokenFeedback.value === "rejected") return;
  if (tokenWrite.value) { await automaticCheck(true); return; }
  busy.value = true;
  try { await refreshAfterTokenSave(); }
  finally { if (isCurrent(requestContext)) { busy.value = false; if (needsAutomaticRetry()) void automaticCheck(true); } }
}
async function saveSettings(): Promise<void> {
  if (!settingsEditable.value || !changedRatesReady.value || !connection.value || !changeRows.value.length) return;
  const patch = settingsPatch();
  if (!patch) { validation.value = true; return; }
  const requestContext = contextGeneration, request = ++planGeneration, partition = recoveryPartition();
  const current = () => isCurrent(requestContext) && request === planGeneration && props.mode === "usage";
  const version = connection.value.version;
  const target = Object.fromEntries(["account_id", "worker_name", "database_id"].map(key => [key, connection.value!.target[key as keyof Target]]));
  const before: Record<string, unknown> = Object.fromEntries(configurationKeys.map(key => [key, connection.value!.configuration[key]]));
  if (record(patch.rate_limits)) before.rate_limits = Object.fromEntries(Object.keys(patch.rate_limits).map(scope => [scope, { ...rateFor(scope as RateScope)! }]));
  const after = { ...before, ...patch }, submittedDraft = { ...drafts.value };
  const path = `${base}/configuration/apply`;
  let dispatched = false;
  let submittedKey: string | null = null;
  busy.value = true; settingsSaving.value = true; failed.value = false; validation.value = false; editorProblem.value = null; settingsOperation.value = null;
  tokenFeedback.value = null; tokenProblem.value = null;
  try {
    const planned = await apiRequest<WriteResult<Plan>>(`${base}/configuration/plan`, { validateResponse: isPlanWrite, authorizationCurrent: current, method: "POST", body: { settings: patch, expected_version: version } });
    if (!current()) return;
    const approved = planned.resource;
    if (connection.value) connection.value.version = approved.version;
    // 同页差异就是本次保存授权；服务端冻结计划必须与用户已看到的基线和新值完全一致。
    if (approved.version !== version + 1 || !equalValues(approved.target, target) || !equalValues(approved.before, before) || !equalValues(approved.after, after)) {
      editorProblem.value = "changed"; await Promise.all([load(), loadRates()]); return;
    }
    const pending: RecoverableSettingsChange = { key: crypto.randomUUID(), operationId: null, verifyKey: null, path, draft: submittedDraft };
    setUncertainChange(pending); submittedKey = pending.key; dispatched = true;
    const result = await apiRequest<WriteResult<Operation>>(path, { validateResponse: value => isOperationWrite(value) && record(value) && record(value.resource) && value.resource.kind === "configuration", authorizationCurrent: current, method: "POST", body: { plan_id: approved.plan_id, expected_version: approved.version }, idempotencyKey: pending.key });
    if (!current()) {
      if (partition && recoverableSettingsChanges.get(partition)?.key === pending.key) {
        if (["verified", "failed"].includes(result.resource.status)) recoverableSettingsChanges.delete(partition);
        else recoverableSettingsChanges.set(partition, { ...pending, operationId: result.resource.operation_id });
      }
      return;
    }
    recordSettingsResult(result.resource);
    await Promise.all([load(), loadRates()]);
    if (current() && result.resource.status === "verified") emit("applied");
  } catch (error) {
    if (!current()) {
      if (partition && submittedKey && recoverableSettingsChanges.get(partition)?.key === submittedKey && error instanceof ApiProblem
        && error.body.details.normalized_by !== "client" && error.status >= 400 && error.status < 500) recoverableSettingsChanges.delete(partition);
      return;
    }
    if (dispatched && hasUncertainWrite(path)) { uncertain.value = true; operation.value = null; }
    else {
      if (dispatched) setUncertainChange(null);
      editorProblem.value = error instanceof ApiProblem && error.status === 409 ? "changed" : dispatched ? "apply_rejected" : "preview_failed";
      editorRecovery.value = true; await Promise.all([load(), loadRates()]);
    }
  } finally {
    if (isCurrent(requestContext)) {
      busy.value = false; settingsSaving.value = false;
      if (unresolved.value || failed.value || ratesFailed.value) void automaticCheck(true);
      else editorRecovery.value = false;
    }
  }
}
function recordSettingsResult(value: Operation): void {
  operation.value = value; recordSettingsOperation(value);
  if (connection.value && value.version > connection.value.version) connection.value.version = value.version;
  if (["pending", "unknown"].includes(value.status)) {
    if (uncertainChangeBaseline.value) setUncertainChange({ ...uncertainChangeBaseline.value, operationId: value.operation_id });
    uncertain.value = true;
  } else {
    clearPendingRequestIntents("POST", `${base}/configuration/apply`); setUncertainChange(null); uncertain.value = false;
    if (value.status === "verified") drafts.value = {};
  }
}
function setUncertainChange(value: RecoverableSettingsChange | null): void {
  uncertainChangeBaseline.value = value;
  const partition = recoveryPartition();
  if (!partition) return;
  if (value) recoverableSettingsChanges.set(partition, value); else recoverableSettingsChanges.delete(partition);
}
function invalidateSessionContext(): void {
  contextGeneration++; planGeneration++; clearAutomaticRetry(); lastAutomaticCheck = 0;
  readController.abort(); readController = new AbortController();
  tokenWrite.value = null; uncertain.value = false; uncertainChangeBaseline.value = null; tokenFeedback.value = null;
  tokenProblem.value = null; tokenLookupMissing.value = false; connection.value = null; operation.value = null; tokenOperation.value = null;
  rateSettings.value = null; ratesFailed.value = false; drafts.value = {};
  settingsOperation.value = null; editorProblem.value = null; editorRecovery.value = false;
  loading.value = false; busy.value = false; settingsSaving.value = false; capabilitiesChecking.value = false; failed.value = false;
  optionalCheckFailed.value = false;
}
function sessionBoundaryChanged(): void { invalidateSessionContext(); loading.value = true; }
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutomaticCheck = 0;
let automaticInFlight = false;
const AUTOMATIC_COOLDOWN = 60_000;
function clearAutomaticRetry(): void { if (retryTimer !== null) clearTimeout(retryTimer); retryTimer = null; }
function needsAutomaticRetry(): boolean {
  return unresolved.value || failed.value || ratesFailed.value || optionalCheckFailed.value
    || ["capabilities_unavailable", "readback_unavailable"].includes(tokenFeedback.value ?? "")
    || capabilities.value.some(entry => ["unavailable", "unverified"].includes(capabilityState(entry.key)));
}
async function automaticCheck(force = false, attempt = 0): Promise<void> {
  if (disposed || automaticInFlight || busy.value || loading.value
    || (!force && Date.now() - lastAutomaticCheck < AUTOMATIC_COOLDOWN)) return;
  clearAutomaticRetry(); automaticInFlight = true; lastAutomaticCheck = Date.now();
  const generation = contextGeneration;
  try { await verify(); }
  finally {
    if (isCurrent(generation)) { automaticInFlight = false; if (!failed.value && hasConfiguration.value) editorRecovery.value = false; }
    if (isCurrent(generation) && needsAutomaticRetry() && attempt < 3) {
      retryTimer = setTimeout(() => { retryTimer = null; void automaticCheck(true, attempt + 1); }, [2_000, 5_000, 15_000][attempt]);
    }
  }
}
function onFocus(): void {
  if (document.visibilityState === "hidden") return;
  const remaining = AUTOMATIC_COOLDOWN - (Date.now() - lastAutomaticCheck);
  if (remaining > 0) {
    if (retryTimer === null) retryTimer = setTimeout(() => { retryTimer = null; void automaticCheck(); }, remaining);
  } else void automaticCheck();
}
watch([() => props.session?.session_id, () => props.session?.principal.id], () => {
  invalidateSessionContext(); automaticInFlight = false;
  tokenWrite.value = recoveryPartition() ? recoverableTokenSaves.get(recoveryPartition()!) ?? null : null;
  uncertainChangeBaseline.value = recoveryPartition() ? recoverableSettingsChanges.get(recoveryPartition()!) ?? null : null;
  drafts.value = { ...uncertainChangeBaseline.value?.draft };
  uncertain.value = Boolean(tokenWrite.value || uncertainChangeBaseline.value); tokenFeedback.value = tokenWrite.value ? "unknown" : null;
  void automaticCheck(true);
});
watch(() => props.mode, () => { planGeneration++; if (props.mode === "usage") void automaticCheck(); });
onMounted(() => {
  window.addEventListener("cfkanban:session-exchanged", sessionBoundaryChanged);
  window.addEventListener("cfkanban:session-invalid", sessionBoundaryChanged);
  window.addEventListener("focus", onFocus);
  void automaticCheck(true);
});
onUnmounted(() => {
  disposed = true; readController.abort(); clearAutomaticRetry();
  window.removeEventListener("cfkanban:session-exchanged", sessionBoundaryChanged);
  window.removeEventListener("cfkanban:session-invalid", sessionBoundaryChanged);
  window.removeEventListener("focus", onFocus);
});
</script>

<template>
  <div class="cloudflare-control">
    <section class="owner-section connection-panel" aria-labelledby="cloudflare-connection-heading" :aria-busy="loading || busy">
      <div class="section-heading-row">
        <h2 id="cloudflare-connection-heading">{{ ui('Cloudflare API Token', 'Cloudflare API Token') }}</h2>
        <span v-if="tokenSaved" class="token-saved" role="status"><UIcon name="i-lucide-check" aria-hidden="true" />{{ ui('Token saved', 'Token 已保存') }}</span>
        <span v-else-if="!loading && connection" class="muted-copy">{{ ui('Not configured', '尚未配置') }}</span>
      </div>
      <CloudflareTokenForm :key="recoveryPartition() ?? 'connection'" kind="connection" :label="ui('Cloudflare API Token', 'Cloudflare API Token')" :saved="tokenSaved" :description="tokenSaved ? ui('Enter a new Token to replace it. Leave blank to keep the saved Token.', '输入新 Token 可替换，留空保持已保存的 Token。') : ui('Save a Token to load usage and manage this instance’s settings.', '保存 Token 后即可加载用量并管理实例设置。')" :disabled="!writable" :save="saveToken" />
      <p v-if="connection && !fixedTargetReady" class="warning-panel">{{ ui('This instance’s setup is incomplete. Ask your deployment Agent to check it.', '此实例的配置不完整，请让部署 Agent 检查。') }}</p>
      <div v-if="tokenFeedbackMessage" class="token-feedback" :data-state="tokenFeedback">
        <ErrorNotice v-if="tokenFeedback === 'rejected' || tokenFeedback === 'failed'" :error="tokenFeedbackMessage" />
        <p v-else class="muted-copy" role="status">{{ tokenFeedbackMessage }}</p>
      </div>
      <p v-else-if="loading || capabilitiesChecking" class="muted-copy" role="status">{{ ui('Updating connection status…', '正在更新连接状态…') }}</p>
      <p v-else-if="unresolved" class="warning-panel" role="status">{{ ui('The last change is awaiting confirmation. We will check it automatically before allowing another change.', '上次修改的结果暂未确认，系统会自动继续确认，确认前无法进行其他修改。') }}</p>
      <ErrorNotice v-else-if="failed || optionalCheckFailed" :error="ui('Connection status is temporarily unavailable. It will update automatically when you return to this page.', '暂时无法更新连接状态，返回此页时会自动重试。')" />
      <div v-if="connection" class="capability-list" :aria-label="ui('Token capabilities', 'Token 权限状态')">
        <details v-for="entry in capabilities" :key="entry.key" class="capability-item" :data-state="capabilityTone(entry.key)">
          <summary class="capability-summary"><UIcon :name="capabilityTone(entry.key) === 'verified' ? 'i-lucide-circle-check' : capabilityTone(entry.key) === 'denied' ? 'i-lucide-circle-x' : 'i-lucide-circle-minus'" class="capability-icon" aria-hidden="true" /><span>{{ entry.label }}</span><span class="capability-result">{{ capabilityStatus(entry.key) }}</span></summary>
          <div class="capability-info"><p>{{ entry.permissions }}</p><p>{{ entry.explanation }}</p></div>
        </details>
      </div>
      <details class="connection-guide" :open="needsTokenHelp">
        <summary>{{ ui('Token setup and recovery', 'Token 配置与恢复') }}</summary>
        <p>{{ ui('Create an Account API Token with Editor access to this Worker and Account Analytics Read access to its account.', '创建 Account API Token，为当前 Worker 授予 Editor，为所在账户授予 Account Analytics Read。') }}</p>
        <ul><li>Developer Platform → Individual Workers → Editor <span v-if="connection?.target.worker_name"> · {{ connection.target.worker_name }}</span></li><li>Analytics &amp; Logs → Account Analytics → Read <span v-if="connection?.target.account_id"> · {{ connection.target.account_id }}</span></li></ul>
        <p><a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noopener noreferrer">{{ ui('Create a Token in Cloudflare', '在 Cloudflare 创建 Token') }}</a></p>
        <p>{{ ui('If saving here is unavailable, open Cloudflare → Workers & Pages → this Worker → Settings → Variables and Secrets. Add or replace CFKANBAN_API_TOKEN as a Secret, then Deploy. Return here and the status will update automatically.', '若无法在此保存，请打开 Cloudflare → Workers & Pages → 当前 Worker → Settings → Variables and Secrets，将 CFKANBAN_API_TOKEN 添加或替换为 Secret 类型，然后 Deploy。返回此页后会自动更新状态。') }}</p>
        <p class="muted-copy">{{ ui('The replacement Token needs Editor access to this Worker to save future settings here.', '替换的 Token 需要具有当前 Worker 的 Editor 权限，之后才能在此保存设置。') }} <a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Detailed guide', '详细指南') }}</a></p>
      </details>
    </section>

    <section class="owner-section settings-panel" aria-labelledby="usage-settings-heading" :aria-busy="busy">
      <h2 id="usage-settings-heading">{{ ui('Usage & access settings', '用量与访问设置') }}</h2>
      <p class="muted-copy">{{ ui('Edit settings together, review the changes below, then save once.', '集中修改设置，在下方查看变更对比后一次保存。') }}</p>
      <p v-if="rateUnavailableReason" class="muted-copy rate-unavailable" role="status">{{ rateUnavailableReason }}</p>
      <p v-else-if="!settingsReady" class="muted-copy" role="status">{{ ui('Reading current settings…', '正在读取当前设置…') }}</p>
      <div v-if="settingsFeedbackMessage" class="settings-feedback" :data-state="settingsOperation?.status ?? editorProblem"><ErrorNotice v-if="settingsFeedbackFailed" :error="settingsFeedbackMessage" /><p v-else class="muted-copy" role="status">{{ settingsFeedbackMessage }}</p></div>
      <form class="unified-settings-form" @submit.prevent="saveSettings">
        <fieldset class="settings-group" :disabled="!settingsEditable">
          <legend>{{ ui('Statistics & history', '统计与历史') }}</legend>
          <div v-for="field in configurationFields" :key="field.value" class="setting-row">
            <div class="setting-description"><label :for="`usage-setting-${field.value}`">{{ field.label }}</label><p :id="`usage-help-${field.value}`">{{ field.help }}</p></div>
            <p class="setting-current"><span>{{ ui('Current', '当前值') }}</span>{{ configurationText(connection?.configuration[field.value]) }}</p>
            <div class="setting-input">
              <USelect v-if="['history_enabled', 'analytics_enabled', 'account_totals'].includes(field.value)" :id="`usage-setting-${field.value}`" :aria-describedby="`usage-help-${field.value}`" :disabled="!settingsEditable" :model-value="draftInput(field.value)" :items="booleanOptions" :placeholder="ui('Not loaded', '尚未读取')" @update:model-value="updateDraft(field.value, $event)" />
              <USelect v-else-if="field.value === 'billing_plan'" :id="`usage-setting-${field.value}`" :aria-describedby="`usage-help-${field.value}`" :disabled="!settingsEditable" :model-value="draftInput(field.value)" :items="[{value:'unknown',label:ui('Not specified','未声明')},{value:'free',label:'Free'},{value:'paid',label:'Paid'}]" @update:model-value="updateDraft(field.value, $event)" />
              <UInput v-else :id="`usage-setting-${field.value}`" :aria-describedby="`usage-help-${field.value}`" :disabled="!settingsEditable" :model-value="draftInput(field.value)" type="number" min="1" max="31" step="1" :placeholder="ui('Not specified', '未声明')" @update:model-value="updateDraft(field.value, $event)" />
            </div>
          </div>
        </fieldset>
        <fieldset class="settings-group" :disabled="!settingsEditable">
          <legend>{{ ui('Request frequency', '访问频率') }}</legend>
          <p class="muted-copy">{{ ui('Maximum requests allowed within each time window.', '设置每个时间窗口内允许的最多请求数。') }}</p>
          <p v-if="ratesFailed" class="muted-copy" role="status">{{ ui('Current request limits are temporarily unavailable. They will be read again automatically.', '暂时无法读取当前访问频率，系统会自动重试。') }}</p>
          <div v-for="scope in rateScopes" :key="scope.value" class="setting-row rate-row">
            <label :for="`usage-rate-${scope.value}`">{{ scope.label }}</label>
            <p class="setting-current"><span>{{ ui('Current', '当前值') }}</span>{{ rateText(rateFor(scope.value) ?? {}) }}</p>
            <div class="rate-inputs"><UInput :id="`usage-rate-${scope.value}`" :aria-label="`${scope.label} ${ui('maximum requests', '最多请求数')}`" :disabled="!settingsEditable || !rateFor(scope.value)" :model-value="draftInput(`${scope.value}.limit`)" type="number" min="1" step="1" @update:model-value="updateDraft(`${scope.value}.limit`, $event)" /><span aria-hidden="true">/</span><USelect :aria-label="`${scope.label} ${ui('duration', '统计时长')}`" :disabled="!settingsEditable || !rateFor(scope.value)" :model-value="draftInput(`${scope.value}.period_seconds`)" :items="[{value:'10',label:ui('10 seconds','10 秒')},{value:'60',label:ui('60 seconds','60 秒')}]" @update:model-value="updateDraft(`${scope.value}.period_seconds`, $event)" /></div>
          </div>
        </fieldset>
        <section v-if="changeRows.length" class="configuration-plan" aria-labelledby="connection-plan-heading">
          <h3 id="connection-plan-heading">{{ ui('Your changes', '变更对比') }}</h3>
          <table class="plan-comparison"><thead><tr><th>{{ ui('Setting', '设置项') }}</th><th>{{ ui('Current value', '当前值') }}</th><th>{{ ui('New value', '修改后') }}</th></tr></thead><tbody><tr v-for="row in changeRows" :key="row.key"><th scope="row">{{ row.label }}</th><td>{{ row.before }}</td><td>{{ row.after }}</td></tr></tbody></table>
        </section>
        <p v-if="validation" class="warning-panel" role="alert">{{ ui('Use whole numbers: billing day 1–31, request count at least 1, and duration 10 or 60 seconds.', '请输入整数：账期日为 1–31，请求数至少为 1，时长为 10 或 60 秒。') }}</p>
        <div class="settings-actions"><p class="muted-copy" role="status">{{ settingsSaving ? ui('Saving and confirming…', '正在保存并确认…') : changeRows.length ? ui(`${changeRows.length} unsaved changes`, `${changeRows.length} 项修改尚未保存`) : ui('No unsaved changes', '没有未保存的修改') }}</p><UButton color="neutral" variant="ghost" type="button" :disabled="busy || unresolved || !changeRows.length" @click="discardDraft">{{ ui('Discard changes', '放弃修改') }}</UButton><UButton color="primary" variant="solid" type="submit" :disabled="!settingsEditable || !changedRatesReady || !changeRows.length">{{ changeRows.length ? ui(`Save ${changeRows.length} ${changeRows.length === 1 ? 'change' : 'changes'}`, `保存 ${changeRows.length} 项修改`) : ui('Save settings', '保存设置') }}</UButton></div>
      </form>
    </section>

    <slot />
  </div>
</template>

<style scoped>
.cloudflare-control { display: grid; gap: 24px; }
.connection-panel, .settings-panel { margin: 0; }
.connection-panel h2 { margin: 0; font-size: 18px; }
.token-saved { display: inline-flex; gap: 6px; align-items: center; color: var(--color-success); font-size: 13px; }
.token-feedback { margin: 12px 0; }
.token-feedback p { margin: 0; }
.capability-list { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 16px 0; }
.capability-item { min-width: min(100%, 280px); max-width: 440px; }
.capability-summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; font-size: 14px; }
.capability-summary::-webkit-details-marker { display: none; }
.capability-summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 4px; border-radius: var(--radius-control); }
.capability-icon { width: 18px; height: 18px; color: var(--color-text-muted); flex-shrink: 0; }
.capability-item[data-state="verified"] .capability-icon { color: var(--color-success); }
.capability-item[data-state="denied"] .capability-icon { color: var(--color-danger); }
.capability-result { color: var(--color-text-muted); font-size: 13px; }
.capability-info { font-size: 13px; color: var(--color-text-muted); overflow-wrap: anywhere; }
.connection-guide { margin: 12px 0 0; font-size: 13px; color: var(--color-text-muted); }
.connection-guide summary { cursor: pointer; width: fit-content; }
.connection-guide p, .connection-guide li { max-width: 76em; overflow-wrap: anywhere; }
.settings-panel h2 { margin: 0; font-size: 18px; }
.settings-group { border: 0; padding: 0; margin: 24px 0; min-width: 0; }
.settings-group legend, .configuration-plan h3 { font-size: 15px; font-weight: 600; }
.setting-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(100px, .7fr) minmax(180px, 1fr); align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--color-border); }
.setting-row:last-child { border-bottom: 0; }
.setting-description label, .rate-row > label { font-weight: 500; }
.setting-description p { font-size: 13px; color: var(--color-text-muted); margin: 5px 0 0; }
.setting-current { display: grid; gap: 4px; margin: 0; font-variant-numeric: tabular-nums; font-size: 14px; }
.setting-current span { color: var(--color-text-muted); font-size: 12px; }
.setting-input > * { width: 100%; }
.rate-inputs { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rate-inputs > :first-child { min-width: 0; flex: 1; width: 80px; }
.settings-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; border-top: 1px solid var(--color-border); padding-top: 16px; }
.settings-actions p { margin: 0 auto 0 0; font-size: 13px; }
.plan-comparison { width: 100%; border-collapse: collapse; margin: 16px 0; }
.plan-comparison th, .plan-comparison td { padding: 12px 8px; border-bottom: 1px solid var(--color-border); text-align: left; overflow-wrap: anywhere; }
.plan-comparison thead th { color: var(--color-text-muted); font-size: 13px; }
@media (max-width: 700px) { .capability-list { display: grid; gap: 12px; } .setting-row { grid-template-columns: minmax(0, 1fr); gap: 10px; } .setting-current { display: flex; gap: 8px; } .setting-input, .rate-inputs { width: 100%; } .settings-actions p { flex-basis: 100%; } .plan-comparison th, .plan-comparison td { padding: 10px 4px; font-size: 13px; } }
</style>
