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
const canCreate = computed(() => available.value && record.value === null);
const canConfirm = computed(() => record.value !== null && belongsHere.value && canConfirmInvitationReview(reviewReady.value, cursor.value !== null, reviewRecord.value, reviewStarted.value, Date.now(), reviewRecord.value?.state === "committed_unavailable" && items.value.some(item => item.id === (reviewRecord.value as { invitation_id?: string })?.invitation_id && item.status !== "active")));

function invalidate(): void { reviewReady.value = false; reviewStarted.value = null; reviewGeneration += 1; }
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
}
async function finish(result: InvitationCreateWriteResult, committed: InvitationRecoveryRecord | null): Promise<void> {
  if (!committed) throw new Error("Invitation recovery record was not committed.");
  if (!mounted) return;
  record.value = committed;
  if (result.resource.secret_available) { oneTimeText.value = result.resource.copy_text; presented.value = committed; }
  await list();
}
async function create(): Promise<void> {
  if (!canCreate.value || !coordinator) return;
  const body: InvitationRequestBody = { kind: "project_grant", grants: [{ project_id: props.projectId, role: role.value }] };
  let committed: InvitationRecoveryRecord | null = null;
  const result = await apiRequest<InvitationCreateWriteResult>(endpoint, {
    method: "POST", body,
    validateResponse: value => isInvitationCreateWriteResult(value, body),
    coordinateIdempotencyIntent: (acquire, execute) => coordinator!.runNewOperation(() => {
      // 只有持有共享锁且确认没有待恢复操作时，才能丢弃另一标签页已处理的旧请求键。
      clearPendingRequestIntents("POST", endpoint);
      return acquire();
    }, body, async (lease, intent) => {
      invalidate(); record.value = lease.record;
      try {
        const result = await execute(intent);
        committed = lease.markCommittedUnavailable(result.resource.id);
        if (!committed) throw new Error("Invitation recovery record was not committed.");
        return result;
      } catch (caught) {
        const failure = caught instanceof ApiProblem ? { status: caught.status, code: caught.body.code } : null;
        if (invitationOutcomeRequiresReview(failure)) lease.retainPendingAfterUncertainResult();
        else if (lease.settle()) clearPendingRequestIntents("POST", endpoint);
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
    <p>{{ ui('Invite someone to this project with read-only or editing access. Invitations become permanently invalid if the administrator permission used to create them is revoked.', '邀请他人加入本项目，可授予只读或编辑权限。签发邀请时使用的管理员权限被撤销后，该邀请永久失效。') }}</p>
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="!available" class="warning-panel">{{ ui('Safe invitation recovery is unavailable in this browser. Use cfkanban-admin to create invitations.', '此浏览器无法维护安全邀请恢复状态，请使用 cfkanban-admin 创建邀请。') }}</p>
    <p v-if="!belongsHere" class="warning-panel">{{ ui('An earlier invitation operation belongs to another scope. Recover it in its original management page or with cfkanban-admin before creating another.', '有一项其他范围的邀请操作尚未处理，请回原管理页或使用 cfkanban-admin 恢复后再创建。') }}</p>
    <div v-if="record && belongsHere && !oneTimeText" class="invitation-recovery">
      <p class="warning-panel">{{ ui('An invitation operation still needs recovery. Retry that exact operation within its recovery window. If its URL is unavailable, revoke the committed invitation and review every page before confirming.', '有邀请操作尚待恢复。恢复窗口内请重试原操作；若一次性网址已不可用，请撤销已提交邀请，并读完全部邀请记录后确认。') }}</p>
      <div class="invitation-actions">
        <button v-if="invitationRecoveryCanRetry(record)" class="secondary-button" type="button" :disabled="busy || !available" @click="run(recover)">{{ ui('Recover exact operation', '恢复原操作') }}</button>
        <button v-else-if="available" class="secondary-button" type="button" :disabled="busy || !canConfirm" @click="run(confirmReview)">{{ ui('I reviewed all invitations', '我已检查全部邀请') }}</button>
      </div>
    </div>
    <div v-if="oneTimeText" class="invitation-delivery">
      <label>{{ ui('One-time invitation instructions', '一次性邀请话术') }}<textarea :value="oneTimeText" readonly rows="5" /></label>
      <p class="muted">{{ ui('Copy these instructions and send them to the person you want to invite. They are only shown this once.', '复制话术并发送给要邀请的人。此内容仅展示一次，请先保存。') }}</p>
      <div class="invitation-actions">
        <CopyForAgentButton :text="oneTimeText" />
        <button class="secondary-button" type="button" :disabled="busy" @click="run(acknowledge)">{{ ui('I saved the invitation', '我已保存邀请') }}</button>
      </div>
    </div>
    <form v-if="canCreate" class="invitation-create" @submit.prevent="run(create)">
      <label>{{ ui('Access level', '成员权限') }}<select v-model="role" :disabled="busy"><option value="writer">{{ ui('Can edit', '可编辑') }}</option><option value="reader">{{ ui('Read only', '只读') }}</option></select></label>
      <button class="primary-button" type="submit" :disabled="busy">{{ ui('Invite member', '邀请成员') }}</button>
    </form>
    <div class="invitation-history-heading">
      <h4>{{ ui('Invitation history', '邀请记录') }}</h4>
      <button class="text-button" type="button" :disabled="busy" @click="run(() => list())">{{ ui('Refresh invitations', '刷新邀请') }}</button>
    </div>
    <p v-if="!items.length && reviewReady" class="muted">{{ ui('No invitations yet.', '暂无邀请记录。') }}</p>
    <p v-else-if="!items.length && busy" class="muted" role="status">{{ ui('Loading invitations…', '正在加载邀请记录…') }}</p>
    <div v-for="item in items" :key="item.id" class="invitation-row">
      <div class="invitation-summary">
        <p>{{ item.grants.map(grant => `${grant.display_name} · ${grant.role === 'writer' ? ui('Can edit', '可编辑') : ui('Read only', '只读')}`).join(' / ') }} · {{ locale === 'zh-CN' ? ({ active: '有效', expired: '已过期', redeemed: '已兑换', revoked: '已撤销' })[item.status] : item.status }}</p>
        <small class="muted">{{ ui('Created', '创建于') }} {{ new Date(item.created_at).toLocaleString(locale) }} · <code>{{ item.code_fingerprint }}</code></small>
        <p v-if="!oneTimeText && record?.state === 'committed_unavailable' && record.invitation_id === item.id" class="muted">{{ ui('This invitation needs review because its one-time instructions are no longer available.', '这条邀请的一次性话术已无法读取，需要检查处理。') }}</p>
      </div>
      <button v-if="item.allowed_actions.includes('revoke')" class="text-button" type="button" :disabled="busy" @click="run(() => revoke(item))">{{ ui('Revoke invitation', '撤销邀请') }}</button>
    </div>
    <button v-if="cursor" class="secondary-button" type="button" :disabled="busy" @click="run(() => list(false))">{{ ui('Load more invitations', '加载更多邀请') }}</button>
  </section>
</template>

<style scoped>
.scoped-invitations { margin-block-start: 24px; }
.invitation-create, .invitation-actions { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-start; gap: 12px; }
.invitation-create { margin-block: 20px 24px; }
.invitation-create label { display: grid; gap: 8px; width: min(240px, 100%); }
.invitation-create select, .invitation-create button { min-height: 44px; }
.invitation-delivery { display: grid; gap: 12px; margin-block: 20px; }
.invitation-delivery p { margin: 0; }
.invitation-history-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-block-start: 16px; border-top: 1px solid var(--color-border); }
.invitation-history-heading h4 { margin: 0; }
.invitation-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; border-bottom: 1px solid var(--color-border); padding-block: 8px; overflow-wrap: anywhere; }
.invitation-summary { min-width: 0; flex: 1 1 240px; }
.invitation-summary p { margin-block: 8px; }
@media (max-width: 480px) {
  .invitation-create label, .invitation-create button { width: 100%; }
}
</style>
