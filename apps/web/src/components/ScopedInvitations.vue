<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import CopyForAgentButton from "./CopyForAgentButton.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { ApiProblem, apiRequest, clearPendingRequestIntents } from "../lib/api";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import {
  canConfirmInvitationReview, InvitationRecoveryCoordinator,
  invitationOutcomeRequiresReview, invitationRecoveryCanRetry, isInvitationCreateWriteResult,
  type InvitationCreateWriteResult, type InvitationRecoveryRecord, type InvitationRequestBody,
} from "../lib/invitation-recovery";
import { continuationCursor } from "../lib/pagination";
import type { InvitationResource, ListResult, WebSessionView } from "../types";

const props = defineProps<{ projectId: string; session: WebSessionView }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const endpoint = "/api/v1/admin/invitations";
const items = ref<InvitationResource[]>([]);
const cursor = ref<string | null>(null);
const busy = ref(false);
const available = ref(false);
const reviewed = ref(false);
const reviewReady = ref(false);
const reviewStarted = ref<number | null>(null);
const record = ref<InvitationRecoveryRecord | null>(null);
const reviewRecord = ref<InvitationRecoveryRecord | null>(null);
const presented = ref<InvitationRecoveryRecord | null>(null);
const oneTimeText = ref("");
const role = ref<"reader" | "writer">("writer");
const { error, clearError, setError } = useLocalizedError();
let coordinator: InvitationRecoveryCoordinator | null = null;
let mounted = true;
let reviewGeneration = 0;
const belongsHere = computed(() => record.value === null || (record.value.body.kind === "project_grant" && record.value.body.grants[0].project_id === props.projectId));
const canConfirm = computed(() => belongsHere.value && canConfirmInvitationReview(reviewReady.value, cursor.value !== null, reviewRecord.value, reviewStarted.value, Date.now(), reviewRecord.value?.state === "committed_unavailable" && items.value.some(item => item.id === (reviewRecord.value as { invitation_id?: string })?.invitation_id && item.status !== "active")));

function invalidate(): void { reviewed.value = false; reviewReady.value = false; reviewStarted.value = null; reviewGeneration += 1; }
function syncRecord(): void { record.value = coordinator?.read() ?? null; }
async function list(reset = true): Promise<void> {
  if (reset) {
    invalidate();
    syncRecord();
    if (record.value && belongsHere.value && !invitationRecoveryCanRetry(record.value)) {
      reviewRecord.value = await coordinator!.prepareReview(record.value);
      record.value = reviewRecord.value;
      if (presented.value?.marker === record.value.marker) presented.value = record.value;
    } else { reviewRecord.value = record.value; }
    reviewStarted.value = Date.now();
    items.value = []; cursor.value = null;
  }
  const current = reviewGeneration;
  const query = new URLSearchParams({ project_id: props.projectId, limit: "100" });
  if (!reset && cursor.value) query.set("cursor", cursor.value);
  const result = await apiRequest<ListResult<InvitationResource>>(`${endpoint}?${query}`);
  if (!mounted || current !== reviewGeneration) return;
  items.value = reset ? result.items : [...items.value, ...result.items];
  cursor.value = continuationCursor(result);
  reviewReady.value = true;
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true; clearError();
  try { await action(); }
  catch (caught) { if (mounted) { invalidate(); setError(caught); try { syncRecord(); } catch { available.value = false; } } }
  finally { busy.value = false; }
}
async function confirmReview(): Promise<void> {
  if (!canConfirm.value || !coordinator) return;
  const previous = reviewRecord.value;
  if (previous && !await coordinator.settle(previous)) { invalidate(); syncRecord(); return; }
  clearPendingRequestIntents("POST", endpoint);
  syncRecord();
  reviewed.value = record.value === null;
}
async function finish(result: InvitationCreateWriteResult, committed: InvitationRecoveryRecord | null): Promise<void> {
  if (!committed) throw new Error("Invitation recovery record was not committed.");
  if (!mounted) return;
  record.value = committed;
  if (result.resource.secret_available) { oneTimeText.value = result.resource.copy_text; presented.value = committed; }
  await list();
}
async function create(): Promise<void> {
  if (!reviewed.value || !available.value || !coordinator) return;
  const body: InvitationRequestBody = { kind: "project_grant", grants: [{ project_id: props.projectId, role: role.value }] };
  let committed: InvitationRecoveryRecord | null = null;
  const result = await apiRequest<InvitationCreateWriteResult>(endpoint, {
    method: "POST", body,
    validateResponse: value => isInvitationCreateWriteResult(value, body),
    coordinateIdempotencyIntent: (acquire, execute) => coordinator!.runNewOperation(acquire, body, async (lease, intent) => {
      invalidate(); record.value = lease.record;
      try {
        const result = await execute(intent);
        committed = lease.markCommittedUnavailable(result.resource.id);
        if (!committed) throw new Error("Invitation recovery record was not committed.");
        return result;
      } catch (caught) {
        const failure = caught instanceof ApiProblem ? { status: caught.status, code: caught.body.code } : null;
        if (invitationOutcomeRequiresReview(failure)) lease.retainPendingAfterUncertainResult();
        else lease.settle();
        invalidate(); throw caught;
      }
    }),
  });
  await finish(result, committed);
}
async function recover(): Promise<void> {
  const pending = record.value;
  if (!pending || !coordinator || !belongsHere.value || !invitationRecoveryCanRetry(pending)) return;
  let committed: InvitationRecoveryRecord | null = null;
  const result = await coordinator.runExistingOperation(pending, async lease => {
    invalidate();
    try {
      const result = await apiRequest<InvitationCreateWriteResult>(endpoint, { method: "POST", body: pending.body, idempotencyKey: pending.idempotency_key, validateResponse: value => isInvitationCreateWriteResult(value, pending.body) });
      committed = lease.markCommittedUnavailable(result.resource.id);
      if (!committed) throw new Error("Invitation recovery record was not committed.");
      return result;
    } catch (caught) { lease.retainPendingAfterUncertainResult(); invalidate(); throw caught; }
  });
  await finish(result, committed);
}
async function acknowledge(): Promise<void> {
  if (!presented.value || !oneTimeText.value || !coordinator) return;
  if (!await coordinator.settle(presented.value)) { invalidate(); syncRecord(); return; }
  clearPendingRequestIntents("POST", endpoint);
  presented.value = null; oneTimeText.value = ""; syncRecord();
  reviewed.value = record.value === null;
}
async function revoke(item: InvitationResource): Promise<void> {
  invalidate();
  await apiRequest(`${endpoint}/${encodeURIComponent(item.id)}?expected_version=${item.version}`, { method: "DELETE" });
  await list();
}
function storageChanged(event: StorageEvent): void {
  if (event.key !== null && event.key !== coordinator?.storageKey) return;
  invalidate(); presented.value = null; oneTimeText.value = "";
  try { syncRecord(); } catch { available.value = false; }
}
onMounted(() => {
  try {
    if (!navigator.locks) throw new Error("Web Locks unavailable");
    const probe = `cfkanban.invitation-recovery.probe.${crypto.randomUUID()}`;
    localStorage.setItem(probe, "1"); localStorage.removeItem(probe);
    coordinator = new InvitationRecoveryCoordinator(props.session.principal.id, localStorage, (name, callback) => navigator.locks.request(name, { mode: "exclusive" }, callback));
    syncRecord(); available.value = true;
    window.addEventListener("storage", storageChanged);
  } catch { available.value = false; }
  void run(() => list());
});
onUnmounted(() => { mounted = false; reviewGeneration += 1; oneTimeText.value = ""; window.removeEventListener("storage", storageChanged); });
</script>

<template>
  <section class="scoped-invitations">
    <h3>{{ ui('Project invitations', '项目邀请') }}</h3>
    <p>{{ ui('Invitations grant only reader or writer access to this project. Losing the exact administrator grant used to issue an invitation invalidates it permanently.', '邀请仅授予本项目的 reader 或 writer。签发时使用的管理授权被撤销后，该邀请永久失效。') }}</p>
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="!available" class="warning-panel">{{ ui('Safe invitation recovery is unavailable in this browser. Use cfkanban-admin to create invitations.', '此浏览器无法维护安全邀请恢复状态，请使用 cfkanban-admin 创建邀请。') }}</p>
    <p v-if="!belongsHere" class="warning-panel">{{ ui('An earlier invitation operation belongs to another scope. Recover it in its original management page or with cfkanban-admin before creating another.', '有一项其他范围的邀请操作尚未处理，请回原管理页或使用 cfkanban-admin 恢复后再创建。') }}</p>
    <p v-if="record && belongsHere" class="warning-panel">{{ ui('An invitation operation still needs recovery. Retry that exact operation within its recovery window. If its URL is unavailable, revoke the committed invitation and review every page before confirming.', '有邀请操作尚待恢复。恢复窗口内请重试原操作；若一次性网址已不可用，请撤销已提交邀请，并读完全部列表后确认。') }}</p>
    <div v-if="oneTimeText">
      <label>{{ ui('One-time invitation instructions', '一次性邀请话术') }}<textarea :value="oneTimeText" readonly rows="5" /></label>
      <CopyForAgentButton :text="oneTimeText" />
      <button class="secondary-button" type="button" :disabled="busy" @click="run(acknowledge)">{{ ui('I saved the invitation', '我已保存邀请') }}</button>
    </div>
    <div class="form-actions">
      <button class="text-button" type="button" :disabled="busy" @click="run(() => list())">{{ ui('Refresh invitations', '刷新邀请') }}</button>
      <button v-if="belongsHere && record && invitationRecoveryCanRetry(record)" class="secondary-button" type="button" :disabled="busy" @click="run(recover)">{{ ui('Recover exact operation', '恢复原操作') }}</button>
      <button v-if="!reviewed && available" class="secondary-button" type="button" :disabled="busy || !canConfirm" @click="run(confirmReview)">{{ ui('I reviewed all invitations', '我已检查全部邀请') }}</button>
    </div>
    <form v-if="reviewed && available" class="form-actions" @submit.prevent="run(create)">
      <label>{{ ui('Role', '角色') }}<select v-model="role"><option value="reader">reader</option><option value="writer">writer</option></select></label>
      <button class="secondary-button" type="submit" :disabled="busy">{{ ui('Create invitation', '创建邀请') }}</button>
    </form>
    <div v-for="item in items" :key="item.id" class="invitation-row">
      <p><code>{{ item.id }}</code> · {{ locale === 'zh-CN' ? ({ active: '有效', expired: '已过期', redeemed: '已兑换', revoked: '已撤销' })[item.status] : item.status }} · {{ item.grants.map(grant => `${grant.display_name} · ${grant.role}`).join(' / ') }}</p>
      <button v-if="item.allowed_actions.includes('revoke')" class="text-button" type="button" :disabled="busy" @click="run(() => revoke(item))">{{ ui('Revoke invitation', '撤销邀请') }}</button>
    </div>
    <button v-if="cursor" class="secondary-button" type="button" :disabled="busy" @click="run(() => list(false))">{{ ui('Load more invitations', '加载更多邀请') }}</button>
  </section>
</template>

<style scoped>
.scoped-invitations { margin-block-start: 24px; }
.invitation-row { border-bottom: 1px solid var(--color-border); padding-block: 8px; overflow-wrap: anywhere; }
.invitation-row code { font-size: 12px; }
</style>
