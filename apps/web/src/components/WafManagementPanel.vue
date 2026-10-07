<script lang="ts">
interface WafIntent { kind: "plan" | "target-binding" | "apply"; key: string; body: Record<string, unknown>; operationId: string | null }
const recovery = new Map<string, WafIntent>();
if (typeof window !== "undefined") {
  const clear = () => recovery.clear();
  window.addEventListener("cfkanban:session-invalid", clear);
  window.addEventListener("cfkanban:session-exchanged", clear);
}
</script>

<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import ErrorNotice from "./ErrorNotice.vue";
import { ApiProblem, apiRequest, clearPendingRequestIntents, errorText, hasUncertainWrite } from "../lib/api";
import { isWafOperation, isWafPlan, isWafView, isWafWrite, type WafConflict, type WafConflictChoice, type WafOperation, type WafPlan, type WafView } from "../lib/cloudflare-waf";
import { locale } from "../lib/i18n";
import type { WriteResult } from "../types";

const props = defineProps<{ value: WafView | null; loading: boolean; disabled: boolean; controlVersion: number; contextKey: string; recoveryPartition: string | null }>();
const emit = defineEmits<{ updated: []; operation: [value: WafOperation]; locked: [value: boolean] }>();
const base = "/api/v1/admin/cloudflare";
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const plan = ref<WafPlan | null>(null);
const operation = ref<WafOperation | null>(null);
const intent = ref<WafIntent | null>(props.recoveryPartition ? recovery.get(props.recoveryPartition) ?? null : null);
const busy = ref(false), problem = ref<string | null>(null), missing = ref(false), success = ref(false);
const conflictChoice = ref<WafConflictChoice | "">("");
const choiceOptions = computed(() => [{ value: "preserve_exemptions", label: ui("Keep existing exemptions", "保留已有豁免") }, { value: "before_conflicts", label: ui("Place our rule before the listed Skip rules", "将本工具规则放到所列 Skip 规则之前") }]);
const conflicts = computed(() => plan.value?.after.conflicts ?? props.value?.conflicts ?? []);
const canReposition = computed(() => conflicts.value.some(item => item.repositionable) && conflicts.value.every(item => item.repositionable));
const choices = computed(() => canReposition.value ? choiceOptions.value : choiceOptions.value.slice(0, 1));
const ready = computed(() => !props.disabled && !busy.value && !props.loading && !intent.value && Number.isSafeInteger(props.value?.version) && props.value?.status === "verified" && props.value?.target_binding?.status === "verified" && props.value?.inventory?.complete === true);
const targetMissing = computed(() => props.value?.version !== undefined && props.value.target_binding?.status !== "verified");
const readStatus = computed(() => {
  if (props.loading) return ui("Reading protection…", "正在读取防护…");
  const labels: Record<string, string> = { verified: ui("Rules read successfully", "规则读取已通过"), missing: ui("WAF authorization or Zone is missing", "缺少 WAF 授权或 Zone"), permission_denied: ui("Cloudflare WAF read permission denied", "Cloudflare WAF 读取权限不足"), target_mismatch: ui("WAF target does not match this instance", "WAF 目标与本实例不一致"), unavailable: ui("Protection state is temporarily unavailable", "防护状态暂不可用") };
  return labels[props.value?.status ?? ""] ?? ui("Protection state is not confirmed", "防护状态尚未确认");
});
let generation = 0, disposed = false;
const current = (request: number) => !disposed && generation === request;
function saveIntent(value: WafIntent | null): void {
  intent.value = value;
  if (props.recoveryPartition) { if (value) recovery.set(props.recoveryPartition, value); else recovery.delete(props.recoveryPartition); }
  emit("locked", Boolean(value));
}
function conflictLabel(value: WafConflict): string {
  const labels = { skip: ui("A Skip rule may bypass this filter", "Skip 规则可能跳过本工具过滤"), unowned_duplicate: ui("A similar rule is managed outside cfKanban", "相似规则由外部管理，不能接管"), expression_unverified: ui("An existing rule’s interaction cannot be established", "无法确定已有规则与本工具过滤的交集"), ip_access_allow: ui("IP Access Allow can bypass custom rules", "IP Access Allow 可绕过自定义规则"), ip_access_unverified: ui("IP Access exemptions could not be checked", "尚未核实 IP Access 豁免") };
  return labels[value.kind];
}
function strategyLabel(value: string): string {
  const labels: Record<string, string> = { create_entrypoint: ui("Create the Zone ruleset and add our rule", "创建 Zone 规则集并添加本工具规则"), append_rule: ui("Append our rule to the existing entrypoint", "在现有入口末尾追加本工具规则"), delete_owned_rule: ui("Delete only our verified rule", "仅删除已核验归属的本工具规则"), reposition_owned_rule: ui("Move only our rule before the approved Skip rules", "仅将本工具规则移到已批准的 Skip 规则之前"), none: ui("No rule change required", "无需修改规则") };
  return labels[value] ?? ui("Not checked", "未检查");
}
function recordOperation(value: WafOperation): void {
  operation.value = value; emit("operation", value);
  if (intent.value) intent.value.operationId = value.operation_id;
  if (["verified", "failed"].includes(value.status)) {
    clearPendingRequestIntents("POST", `${base}/waf/apply`); saveIntent(null);
    success.value = value.status === "verified";
    if (value.status === "failed") problem.value = ui("The WAF change failed. Read the current state and create a new plan.", "WAF 修改失败，请读取当前状态后重新生成计划。");
    emit("updated");
  }
}
async function execute(value: WafIntent, request: number): Promise<void> {
  const path = `${base}/waf/${value.kind}`;
  const validate = value.kind === "plan" ? (result: unknown) => isWafWrite(result, item => isWafPlan(item) && item.version === Number(value.body.expected_version) + 1)
    : value.kind === "apply" ? (result: unknown) => isWafWrite(result, isWafOperation)
      : (result: unknown) => isWafWrite(result, item => {
        if (!item || typeof item !== "object") return false;
        const resource = item as { version?: number; target_binding?: { status?: string; source?: string; domain_id?: string; verified_at?: string } };
        const binding = resource.target_binding;
        return resource.version === Number(value.body.expected_version) + 1 && binding?.status === "verified" && binding.source === "worker_domain_read"
          && typeof binding.domain_id === "string" && binding.domain_id.length > 0 && typeof binding.verified_at === "string" && Number.isFinite(Date.parse(binding.verified_at));
      });
  const result = await apiRequest<WriteResult<WafPlan | WafOperation>> (path, { method: "POST", body: value.body, idempotencyKey: value.key, validateResponse: validate, authorizationCurrent: () => current(request) });
  if (!current(request)) return;
  if (value.kind === "apply") { plan.value = null; recordOperation(result.resource as WafOperation); }
  else {
    saveIntent(null);
    if (value.kind === "plan") {
      const snapshot = result.resource as WafPlan;
      if (snapshot.version < props.controlVersion) { plan.value = null; problem.value = ui("The control state changed while this plan was loading. Review a new plan.", "计划读取期间控制状态已变化，请重新核对计划。"); }
      else plan.value = snapshot;
    }
    emit("updated");
  }
}
async function write(kind: WafIntent["kind"], body: Record<string, unknown>): Promise<void> {
  if (busy.value || intent.value) return;
  const request = generation, value: WafIntent = { kind, body, key: crypto.randomUUID(), operationId: null };
  saveIntent(value); busy.value = true; problem.value = null; missing.value = false; success.value = false;
  try { await execute(value, request); }
  catch (error) {
    if (!current(request)) return;
    const rejectedBeforeDispatch = error instanceof ApiProblem && error.body.details.normalized_by !== "client" && ["service", "cloudflare_platform"].includes(error.body.source) && error.body.details.write_state === "not_dispatched";
    if ((kind !== "apply" && !hasUncertainWrite(`${base}/waf/${kind}`)) || rejectedBeforeDispatch) { clearPendingRequestIntents("POST", `${base}/waf/${kind}`); saveIntent(null); }
    problem.value = errorText(error); if (!intent.value) { plan.value = null; emit("updated"); }
  } finally { if (current(request)) busy.value = false; }
}
async function preview(action: "enable" | "disable"): Promise<void> {
  if (!ready.value) return;
  plan.value = null;
  await write("plan", { action, expected_version: props.controlVersion, ...(action === "enable" && conflictChoice.value ? { conflict_choice: conflictChoice.value } : {}) });
}
async function connect(): Promise<void> {
  if (props.disabled || props.loading || !targetMissing.value) return;
  await write("target-binding", { expected_version: props.controlVersion });
}
async function apply(): Promise<void> {
  if (!ready.value || !plan.value?.after.apply_ready || plan.value.version !== props.controlVersion) return;
  await write("apply", { plan_id: plan.value.plan_id, expected_version: plan.value.version });
}
async function check(): Promise<void> {
  if (busy.value) return;
  const request = generation, value = intent.value;
  if (!value) { emit("updated"); return; }
  busy.value = true; problem.value = null; missing.value = false;
  try {
    if (value.kind !== "apply") { await execute(value, request); return; }
    if (!value.operationId) {
      const found = await apiRequest<WafOperation>(`${base}/waf/operations/${encodeURIComponent(value.key)}`, { validateResponse: isWafOperation, authorizationCurrent: () => current(request) });
      if (!current(request)) return; recordOperation(found);
      if (!intent.value) return;
    }
    const id = intent.value?.operationId ?? value.operationId!;
    const result = await apiRequest<WriteResult<WafOperation>>(`${base}/operations/${encodeURIComponent(id)}/verify`, { method: "POST", body: {}, idempotencyKey: crypto.randomUUID(), validateResponse: result => isWafWrite(result, item => isWafOperation(item) && item.operation_id === id), authorizationCurrent: () => current(request) });
    if (current(request)) recordOperation(result.resource);
  } catch (error) {
    if (!current(request)) return;
    missing.value = error instanceof ApiProblem && error.status === 404 && error.body.details.normalized_by !== "client";
    if (!missing.value) problem.value = errorText(error);
  } finally { if (current(request)) busy.value = false; }
}
watch(() => props.controlVersion, value => { if (plan.value && value !== plan.value.version) plan.value = null; });
watch(conflictChoice, () => { plan.value = null; });
watch(() => props.contextKey, () => {
  generation++; plan.value = null; problem.value = null; operation.value = null; success.value = false; missing.value = false; busy.value = false; conflictChoice.value = "";
  intent.value = props.recoveryPartition ? recovery.get(props.recoveryPartition) ?? null : null; emit("locked", Boolean(intent.value));
});
watch(() => props.value, value => { if (value && !isWafView(value)) problem.value = ui("The WAF state could not be validated.", "WAF 状态未通过核验。"); });
onUnmounted(() => { disposed = true; generation++; });
emit("locked", Boolean(intent.value));
</script>

<template>
  <div class="waf-management" :aria-busy="busy || loading">
    <p role="status">{{ readStatus }} · {{ value?.hostname || ui('Hostname unknown', '域名未知') }}</p>
    <p class="muted-copy">{{ ui('Filters private API requests without authentication material for this exact hostname. Passkey login, invites and normal Web/CLI/Agent use remain available. This does not replace application permissions or request limits.', '仅过滤此准确域名下没有认证材料的私有 API 请求；Passkey 登录、邀请及正常 Web／CLI／Agent 使用保持可用。此规则不替代应用权限或访问频率限制。') }}</p>
    <p class="muted-copy">{{ ui('Enabling or disabling requires Zone WAF Edit for this Zone. A successful read does not prove write permission; saving the Token never creates rules.', '启用或关闭需要此 Zone 的 Zone WAF Edit 权限。读取通过不证明具备写权限；保存 Token 不会创建规则。') }}</p>
    <ErrorNotice v-if="problem" :error="problem" />
    <p v-if="success" role="status">{{ ui('The planned rule change was read back and verified.', '已读回并核验计划中的规则变更。') }}</p>
    <div v-if="intent" class="warning-panel" role="status">
      <p>{{ ui('This change is awaiting confirmation. Check the original result before another change; rules will not be submitted again.', '本次修改待确认。请先检查原操作结果，再进行其他修改；不会重复提交规则写入。') }}</p>
      <p v-if="missing">{{ ui('The original intent has not been found yet. A request may still be in progress; another write remains blocked.', '暂未查到原操作记录，请求仍可能在途；继续锁定其他写入。') }}</p>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="check">{{ ui('Check WAF change result', '检查 WAF 修改结果') }}</UButton>
    </div>
    <p v-if="value?.owned_rule">{{ ui('Our rule configuration is verified', '本工具规则配置已核验') }} · {{ value.owned_rule.enabled ? ui('Enabled', '启用') : ui('Disabled', '停用') }}</p>
    <p v-else-if="value?.status === 'verified'">{{ ui('No verified tool-owned rule is enabled. Other Cloudflare protection may exist.', '没有已核验归属的本工具规则处于启用状态；Cloudflare 可能另有防护。') }}</p>
    <p v-if="value?.version !== undefined && value.protected">{{ ui('Current reads confirm this hostname’s filter and no detected exemptions.', '当前读取已核验此域名过滤配置，未发现豁免。') }}</p>
    <p v-else-if="value?.owned_rule || conflicts.length" class="warning-panel">{{ ui('Coverage is incomplete or unconfirmed. Existing exemptions, workers.dev or previews may bypass this rule. Configuration verification is not a live edge test.', '覆盖不完整或尚未确认。已有豁免、workers.dev 或 preview 可能绕过此规则；配置核验不是实网边缘测试。') }}</p>
    <div v-if="targetMissing" class="waf-target warning-panel">
      <p>{{ ui('Connect this existing hostname to the fixed Worker before changing rules. This does not create or replace a domain.', '修改规则前需将此现有域名接入固定 Worker；不会创建或替换域名。') }}</p>
      <UButton color="neutral" variant="outline" :disabled="disabled || busy || loading || Boolean(intent)" @click="connect">{{ ui('Verify and connect current domain', '核验并接入当前域名') }}</UButton>
      <p class="muted-copy">{{ ui('If this Token cannot read Workers Custom Domains, use the deploy tool’s WAF target connection plan with the existing Cloudflare authorization. Do not recreate the domain or broaden the saved Token automatically.', '若此 Token 不能读取 Workers Custom Domains，请用部署工具的 WAF 目标接入计划及既有 Cloudflare 授权。无需重建域名，也不会自动扩大已保存 Token 的权限。') }}</p>
    </div>
    <dl v-if="value?.inventory" class="waf-facts">
      <div><dt>{{ ui('Entrypoint', '规则集入口') }}</dt><dd>{{ value.entrypoint?.strategy === 'create_entrypoint' ? ui('Will be created when enabled', '启用时创建') : value.entrypoint?.id ?? ui('Not verified', '未核验') }}</dd></div>
      <div><dt>{{ ui('Existing custom rules', '已有自定义规则') }}</dt><dd>{{ value.inventory.complete ? `${value.inventory.total_rule_count} / ${value.inventory.free_rule_limit}` : ui('Inventory incomplete', '库存未完整核验') }}</dd></div>
      <div><dt>{{ ui('Other rules retained', '保留的其他规则') }}</dt><dd>{{ value.other_rule_count ?? ui('Unknown', '未知') }}</dd></div>
      <div><dt>{{ ui('Target evidence', '目标证据') }}</dt><dd>{{ value.target_binding?.service_proof ? ui('Registered deployment evidence; current service proof required', '部署登记证据；同时要求当前服务证明') : value.target_binding?.status === 'verified' ? ui('Cloudflare domain mapping verified', 'Cloudflare 域名映射已核验') : ui('Not verified', '未核验') }}</dd></div>
    </dl>
    <div v-if="conflicts.length" class="waf-conflicts">
      <h4>{{ ui('Existing rules and exemptions', '已有规则与豁免') }}</h4>
      <ul><li v-for="(item, index) in conflicts" :key="`${item.ruleset_id}:${item.rule_id}:${index}`">{{ conflictLabel(item) }}<span v-if="item.rule_id"> · {{ item.rule_id }}</span></li></ul>
      <label>{{ ui('Choose how to coexist', '选择共存方式') }}<USelect v-model="conflictChoice" :items="choices" :disabled="disabled || busy || Boolean(intent)" :placeholder="ui('Choose explicitly…', '请明确选择…')" /></label>
      <p class="muted-copy">{{ ui('Only our rule can move. Other rule bodies and their relative order are preserved. Unknown expressions and IP Access exemptions remain unresolved.', '仅能移动本工具规则；其他规则正文和相对顺序保持不变。未知表达式及 IP Access 豁免不会因此消除。') }}</p>
    </div>
    <div class="waf-actions">
      <UButton color="neutral" variant="outline" :disabled="!ready || value?.inventory?.capacity_available === false" @click="preview('enable')">{{ ui('Review enabling protection', '检查启用防护') }}</UButton>
      <UButton v-if="value?.owned_rule" color="neutral" variant="outline" :disabled="!ready" @click="preview('disable')">{{ ui('Review disabling our rule', '检查关闭本工具规则') }}</UButton>
      <UButton color="neutral" variant="ghost" :disabled="busy || loading" @click="check">{{ ui('Refresh protection state', '刷新防护状态') }}</UButton>
    </div>
    <p v-if="value?.version === undefined" class="muted-copy">{{ ui('Upgrade this instance to use Web WAF management.', '升级当前实例后可使用网页 WAF 管理。') }}</p>
    <section v-if="plan" class="waf-plan" aria-labelledby="waf-plan-heading">
      <h4 id="waf-plan-heading">{{ ui('Review WAF change', '核对 WAF 修改') }}</h4>
      <p>{{ plan.target.hostname }} · {{ plan.after.action === 'enable' ? ui('Enable our private API filter', '启用本工具私有 API 过滤') : ui('Remove only our private API filter', '仅移除本工具私有 API 过滤') }}</p>
      <p>{{ strategyLabel(plan.after.entrypoint_strategy) }}</p>
      <p>{{ ui('All other rules and the shared ruleset will be preserved. No domain change or plan purchase is included.', '保留所有其他规则及共享规则集；不变更域名、不购买或升级套餐。') }}</p>
      <p v-if="!plan.after.apply_ready" class="warning-panel">{{ ui('Choose how to handle the listed conflicts and create a new plan before confirming.', '请明确选择所列冲突的共存方式，并重新生成计划后再确认。') }}</p>
      <details><summary>{{ ui('Target and rule details', '目标与规则详情') }}</summary><pre>{{ JSON.stringify(plan, null, 2) }}</pre></details>
      <UButton color="primary" variant="solid" :disabled="!ready || !plan.after.apply_ready || plan.version !== controlVersion" @click="apply">{{ ui('Confirm WAF change', '确认 WAF 修改') }}</UButton>
    </section>
    <a :href="`/docs/${locale}/deployment/optional/`">{{ ui('Domain protection guide', '域名防护指南') }}</a>
  </div>
</template>

<style scoped>
.waf-facts { display: grid; gap: 8px; margin: 16px 0; }
.waf-facts > div { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; }
.waf-facts dt, .muted-copy { color: var(--color-text-muted); }
.waf-facts dd { margin: 0; overflow-wrap: anywhere; }
.waf-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.waf-plan { padding: 16px 0; border-top: 1px solid var(--color-border); }
.waf-plan pre { overflow: auto; max-height: 360px; padding: 12px; background: var(--color-surface-muted); }
.waf-plan > button { margin-top: 12px; }
.waf-conflicts label { display: grid; gap: 8px; max-width: 480px; }
.waf-target button { margin-bottom: 8px; }
@media (max-width: 600px) { .waf-facts > div { grid-template-columns: 1fr; gap: 3px; } }
</style>
