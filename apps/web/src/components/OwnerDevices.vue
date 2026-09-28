<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import ErrorNotice from "./ErrorNotice.vue";
import ModalDialog from "./ModalDialog.vue";
import { apiRequest, errorText } from "../lib/api";
import { locale } from "../lib/i18n";
import {
  approveOwnerDeviceAttempt, isOwnerDeviceList, isOwnerDeviceWriteResult, OwnerDeviceInputError,
  ownerDeviceIdentity, ownerDeviceRetryAllowed, ownerDeviceVersionConflict, parseOwnerDevicePairing,
  revokeOwnerDeviceAttempt, type OwnerDeviceAttempt, type OwnerDeviceIdentity, type OwnerDevicePairing,
} from "../lib/owner-devices";
import { registerNavigationGuard } from "../lib/router";
import type { CredentialResource, ListResult, WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView }>();
const identity = ref<OwnerDeviceIdentity | null>(null);
const devices = ref<CredentialResource[]>([]);
const nextCursor = ref<string | null>(null);
const busy = ref(false);
const failure = ref<unknown>(null);
const notice = ref<"" | "approved" | "revoked" | "changed">("");
const dialog = ref<"approve" | "revoke" | null>(null);
const input = ref("");
const pairing = ref<OwnerDevicePairing | null>(null);
const target = ref<CredentialResource | null>(null);
const confirmed = ref(false);
const reviewVersion = ref<number | null>(null);
const approvalKey = ref("");
const pending = ref<OwnerDeviceAttempt | null>(null);
const retryExpired = ref(false);
const controller = new AbortController();
const replacementKeys = new Map<string, string>();
let disposed = false;
let removeGuard = () => {};
function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }

const error = computed(() => {
  if (failure.value === null) return "";
  if (!(failure.value instanceof OwnerDeviceInputError)) return errorText(failure.value);
  if (failure.value.code === "target") return ui("This request or device does not match the current instance and Owner. Check the source device and try again.", "请求或设备与当前实例、Owner 不匹配。请核对来源设备后重试。");
  if (failure.value.code === "expired") return ui("This pairing request is expired or not yet valid. Ask the Agent on the new device to check its pending request.", "配对请求已过期或尚未生效，请让新设备上的 Agent 检查待接入请求。");
  if (failure.value.code === "identity") return ui("The current instance address or Owner identity could not be verified. Reopen administration from the trusted instance address.", "无法核实当前实例地址或 Owner 身份，请从可信实例地址重新进入管理页。");
  return ui("Paste only the complete public pairing_request object from your new device. Secret tokens, extra fields and malformed requests are not accepted.", "请只粘贴新设备生成的完整非秘密 pairing_request 对象。不能包含秘密 Token、额外字段或格式错误。");
});
const reviewing = computed(() => dialog.value === "approve" ? pairing.value !== null : target.value !== null);
const locked = computed(() => busy.value || pending.value !== null);

async function readIdentity(): Promise<OwnerDeviceIdentity> {
  const [meta, me] = await Promise.all([
    apiRequest<unknown>("/api/v1/meta", { signal: controller.signal }),
    apiRequest<unknown>("/api/v1/me", { signal: controller.signal }),
  ]);
  return ownerDeviceIdentity(meta, me, window.location.origin, props.session.principal.id);
}

async function readDevices(owner: OwnerDeviceIdentity, cursor: string | null = null): Promise<ListResult<CredentialResource>> {
  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  return apiRequest<ListResult<CredentialResource>>(`/api/v1/admin/principals/${owner.principalId}/credentials?${params}`, {
    signal: controller.signal, validateResponse: value => isOwnerDeviceList(value, owner.principalId),
  });
}

async function refresh(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const current = await readIdentity();
    const result = await readDevices(current);
    if (disposed) return;
    identity.value = current;
    devices.value = result.items;
    nextCursor.value = result.next_cursor;
  } catch (caught) { if (!disposed) failure.value = caught; }
  finally { if (!disposed) busy.value = false; }
}

async function loadMore(): Promise<void> {
  if (busy.value || !identity.value || !nextCursor.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const result = await readDevices(identity.value, nextCursor.value);
    if (disposed) return;
    devices.value = [...devices.value, ...result.items.filter(item => !devices.value.some(current => current.id === item.id))];
    nextCursor.value = result.next_cursor;
  } catch (caught) { if (!disposed) failure.value = caught; }
  finally { if (!disposed) busy.value = false; }
}

function openApprove(): void {
  if (locked.value) return;
  dialog.value = "approve";
  pairing.value = null;
  target.value = null;
  input.value = "";
  confirmed.value = false;
  reviewVersion.value = null;
  failure.value = null;
  notice.value = "";
}

async function inspect(): Promise<void> {
  if (locked.value) return;
  busy.value = true;
  failure.value = null;
  confirmed.value = false;
  pairing.value = null;
  try {
    const current = await readIdentity();
    const request = parseOwnerDevicePairing(input.value, current);
    if (disposed) return;
    identity.value = current;
    pairing.value = request;
    approvalKey.value = replacementKeys.get(request.idempotency_key) ?? request.idempotency_key;
    reviewVersion.value = current.version;
    input.value = "";
  } catch (caught) { if (!disposed) { failure.value = caught; input.value = ""; } }
  finally { if (!disposed) busy.value = false; }
}

async function openRevoke(device: CredentialResource): Promise<void> {
  if (locked.value || !device.allowed_actions.includes("revoke_owner_device")) return;
  dialog.value = "revoke";
  target.value = device;
  pairing.value = null;
  confirmed.value = false;
  reviewVersion.value = null;
  notice.value = "";
  failure.value = null;
  busy.value = true;
  try {
    const current = await readIdentity();
    if (disposed) return;
    identity.value = current;
    reviewVersion.value = current.version;
  } catch (caught) { if (!disposed) failure.value = caught; }
  finally { if (!disposed) busy.value = false; }
}

function closeDialog(): void {
  if (busy.value) return;
  dialog.value = null;
  if (!pending.value) { pairing.value = null; target.value = null; input.value = ""; }
  confirmed.value = false;
}

async function send(attempt: OwnerDeviceAttempt): Promise<void> {
  try {
    await apiRequest(attempt.path, { method: "POST", body: attempt.body, idempotencyKey: attempt.key,
      validateResponse: value => isOwnerDeviceWriteResult(value, attempt) });
    if (disposed) return;
    pending.value = null;
    notice.value = attempt.kind === "approve" ? "approved" : "revoked";
    dialog.value = null;
    pairing.value = null;
    target.value = null;
    confirmed.value = false;
    const current = await readIdentity();
    const result = await readDevices(current);
    if (disposed) return;
    identity.value = current;
    devices.value = result.items;
    nextCursor.value = result.next_cursor;
  } catch (caught) {
    if (disposed) return;
    failure.value = caught;
    if (ownerDeviceVersionConflict(caught)) {
      pending.value = null;
      confirmed.value = false;
      reviewVersion.value = null;
      approvalKey.value = crypto.randomUUID();
      if (pairing.value) replacementKeys.set(pairing.value.idempotency_key, approvalKey.value);
      notice.value = "changed";
      try {
        const current = await readIdentity();
        const result = await readDevices(current);
        if (disposed) return;
        identity.value = current;
        devices.value = result.items;
        nextCursor.value = result.next_cursor;
        reviewVersion.value = current.version;
        if (dialog.value === "revoke" && target.value) target.value = result.items.find(device => device.id === target.value?.id) ?? null;
      } catch (readError) { if (!disposed) failure.value = readError; }
    }
  }
}

async function submit(): Promise<void> {
  if (locked.value || !confirmed.value || !reviewing.value || reviewVersion.value === null) return;
  busy.value = true;
  failure.value = null;
  try {
    const current = await readIdentity();
    if (disposed) return;
    identity.value = current;
    if (reviewVersion.value !== current.version) {
      const result = await readDevices(current);
      if (disposed) return;
      devices.value = result.items;
      nextCursor.value = result.next_cursor;
      if (dialog.value === "revoke" && target.value) target.value = result.items.find(device => device.id === target.value?.id) ?? null;
      reviewVersion.value = current.version;
      confirmed.value = false;
      notice.value = "changed";
      return;
    }
    const attempt = dialog.value === "approve" && pairing.value
      ? approveOwnerDeviceAttempt(pairing.value, current, approvalKey.value)
      : target.value ? revokeOwnerDeviceAttempt(target.value, current, crypto.randomUUID()) : null;
    if (!attempt) return;
    pending.value = attempt;
    retryExpired.value = false;
    await send(attempt);
  } catch (caught) { if (!disposed) failure.value = caught; }
  finally { if (!disposed) busy.value = false; }
}

async function retry(): Promise<void> {
  if (busy.value || !pending.value) return;
  if (!ownerDeviceRetryAllowed(pending.value)) { retryExpired.value = true; return; }
  busy.value = true;
  failure.value = null;
  try { await send(pending.value); } finally { if (!disposed) busy.value = false; }
}

function leaveMessage(): string { return ui("This device operation has no confirmed result. Leaving loses the in-page retry information. Stay here and retry the original operation, or ask your Agent to check the device before starting another operation.", "设备操作的结果尚未确认。离开会丢失本页的重试信息。请留在本页重试原请求，或让 Agent 核对设备状态后再开始其他操作。"); }
function beforeUnload(event: BeforeUnloadEvent): void {
  if (!pending.value) return;
  event.preventDefault();
  event.returnValue = "";
}
function date(value: string | null): string { return value ? new Date(value).toLocaleString(locale.value) : "—"; }
onMounted(() => {
  removeGuard = registerNavigationGuard(() => !pending.value || window.confirm(leaveMessage()));
  window.addEventListener("beforeunload", beforeUnload);
  void refresh();
});
onUnmounted(() => { disposed = true; controller.abort(); removeGuard(); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <section class="owner-section owner-devices" aria-labelledby="owner-devices-heading" :aria-busy="busy">
    <div class="section-heading-row">
      <div><h2 id="owner-devices-heading">{{ ui('Owner devices', 'Owner 设备') }}</h2><p>{{ ui('Your computers share one Owner identity, each with an independent credential.', '你的电脑共用同一个 Owner 身份，各自使用独立凭据。') }}</p></div>
      <div class="form-actions"><button class="text-button" type="button" :disabled="busy" @click="refresh">{{ ui('Refresh devices', '刷新设备') }}</button><button class="secondary-button" type="button" :disabled="locked || !identity" @click="openApprove">{{ ui('Add my computer', '添加我的电脑') }}</button></div>
    </div>
    <ErrorNotice v-if="error && !dialog" :error="error" />
    <p v-if="notice === 'approved'" role="status">{{ ui('Device approved. Return to the Agent on the new computer to verify and finish local access.', '设备已批准。请回到新电脑上的 Agent，验证并完成本地接入。') }}</p>
    <p v-if="notice === 'revoked'" role="status">{{ ui('Device credential revoked. Other devices remain available.', '该设备凭据已撤销，其他设备可继续使用。') }}</p>
    <div v-if="pending && !dialog" class="warning-panel" role="alert"><p>{{ ui('The last device operation has no confirmed result. New device operations are paused; retry the original request.', '上次设备操作的结果尚未确认，已暂停新的设备操作，请重试原请求。') }}</p><p><strong>{{ pending.deviceName ?? ui('Unnamed device', '未命名设备') }}</strong> · <code>{{ pending.fingerprint }}</code></p><p v-if="retryExpired">{{ ui('The safe retry window ended. Ask your Agent to inspect this device before continuing.', '安全重试期限已过，请让 Agent 核对该设备状态后再继续。') }}</p><button class="secondary-button" type="button" :disabled="busy || retryExpired" @click="retry">{{ ui('Retry original operation', '重试原操作') }}</button></div>
    <ul class="device-list">
      <li v-for="device in devices" :key="device.id" class="device-row">
        <div class="device-details"><strong>{{ device.device_name ?? ui('Unnamed device', '未命名设备') }}</strong><span v-if="session.source.kind === 'credential' && session.source.id === device.id" class="role-badge">{{ ui('Current session source', '当前会话来源') }}</span><code>{{ device.fingerprint }}</code><small>{{ ui('Added', '添加于') }} {{ date(device.issued_at) }} · {{ ui('Last used', '最近使用') }} {{ date(device.last_used_at) }}</small><small v-if="device.revoked_at">{{ ui('Revoked', '已撤销') }} {{ date(device.revoked_at) }}</small></div>
        <button v-if="device.allowed_actions.includes('revoke_owner_device')" class="danger-text-button" type="button" :disabled="locked" :aria-label="`${ui('Revoke device', '撤销设备')} ${device.device_name ?? device.fingerprint}`" @click="openRevoke(device)">{{ ui('Revoke', '撤销') }}</button>
      </li>
    </ul>
    <p v-if="!busy && !devices.length" class="muted-copy">{{ ui('No device credentials loaded. Refresh to check the current state.', '尚未读取到设备凭据，请刷新核对当前状态。') }}</p>
    <button v-if="nextCursor" class="text-button" type="button" :disabled="busy" @click="loadMore">{{ ui('Load more devices', '加载更多设备') }}</button>
    <p class="muted-copy">{{ ui('The current session’s source credential and the last active Owner credential cannot be revoked here.', '不能在这里撤销当前会话的来源凭据或最后一份有效 Owner 凭据。') }}</p>
  </section>

  <ModalDialog v-if="dialog" :busy="busy" :title="dialog === 'approve' ? ui('Add my computer', '添加我的电脑') : ui('Revoke Owner device', '撤销 Owner 设备')" @close="closeDialog">
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="notice === 'changed'" class="warning-panel" role="alert">{{ ui('Owner access changed. Review the refreshed identity and device details, then confirm again.', 'Owner 权限状态已变化，请核对刷新后的身份和设备信息，并重新确认。') }}</p>
    <form v-if="dialog === 'approve' && !pairing" class="device-form" @submit.prevent="inspect">
      <p id="owner-pairing-help">{{ ui('On your new computer, ask cfkanban-admin to prepare Owner device access. Paste its public pairing_request object below; never paste a secret credential.', '先让新电脑上的 cfkanban-admin 准备 Owner 设备接入，再将生成的非秘密 pairing_request 对象粘贴到下方。不要粘贴秘密凭据。') }}</p>
      <label for="owner-pairing-request">{{ ui('Public pairing request', '非秘密配对请求') }}</label>
      <textarea id="owner-pairing-request" v-model="input" rows="7" maxlength="8192" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="owner-pairing-help" :disabled="locked" />
      <button class="primary-button" type="submit" :disabled="locked || !input.trim()">{{ busy ? ui('Checking…', '正在检查…') : ui('Check request', '检查请求') }}</button>
    </form>
    <form v-else class="device-form" @submit.prevent="submit">
      <p>{{ dialog === 'approve' ? ui('This computer will have full Owner access to this instance. Confirm it is your device.', '这台电脑将拥有本实例的完整 Owner 权限，请确认它是你的设备。') : ui('This stops the selected credential and its browser sessions. Other devices and independent passkeys remain available.', '这将停用所选凭据及其派生浏览器会话，其他设备和独立通行密钥不受影响。') }}</p>
      <dl class="device-review">
        <dt>{{ ui('Instance', '实例') }}</dt><dd>{{ identity?.origin }}<br /><code>{{ identity?.instanceId }}</code></dd>
        <dt>Owner</dt><dd>{{ identity?.displayName }}<br /><code>{{ identity?.principalId }}</code></dd>
        <dt>{{ ui('Device', '设备') }}</dt><dd>{{ pairing?.device_name ?? target?.device_name ?? ui('Unnamed device', '未命名设备') }}</dd>
        <dt>{{ ui('Fingerprint', '指纹') }}</dt><dd><code>{{ pairing ? `cfk_v1_${pairing.token_prefix}_…` : target?.fingerprint }}</code></dd>
        <template v-if="pairing"><dt>{{ ui('Request expires', '请求有效期至') }}</dt><dd>{{ date(pairing.expires_at) }}</dd></template>
      </dl>
      <div v-if="pending" class="warning-panel" role="alert"><p>{{ ui('The result is not confirmed. Keep this page open and retry the original request; its target and request are preserved.', '操作结果尚未确认。请保持此页打开并重试原请求，目标与请求已保留。') }}</p><p v-if="retryExpired">{{ ui('The safe retry window ended. Ask your Agent to inspect this device before continuing.', '安全重试期限已过，请让 Agent 核对该设备状态后再继续。') }}</p><button class="secondary-button" type="button" :disabled="busy || retryExpired" @click="retry">{{ ui('Retry original operation', '重试原操作') }}</button></div>
      <template v-else>
        <label class="device-confirm"><input v-model="confirmed" type="checkbox" :disabled="busy || reviewVersion === null" />{{ dialog === 'approve' ? ui('I checked this request and approve this computer as my Owner device.', '我已核对该请求，批准这台电脑作为我的 Owner 设备。') : ui('I confirm revoking this device credential.', '我确认撤销该设备凭据。') }}</label>
        <div class="form-actions"><button :class="dialog === 'approve' ? 'primary-button' : 'danger-button'" type="submit" :disabled="busy || !confirmed || reviewVersion === null || !reviewing">{{ busy ? ui('Saving…', '正在提交…') : dialog === 'approve' ? ui('Approve device', '批准设备') : ui('Revoke device', '撤销设备') }}</button><button class="secondary-button" type="button" :disabled="busy" @click="closeDialog">{{ ui('Cancel', '取消') }}</button></div>
      </template>
    </form>
  </ModalDialog>
</template>

<style scoped>
.device-list { margin: 16px 0; padding: 0; list-style: none; }
.device-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--color-border); }
.device-row > button { flex-shrink: 0; white-space: nowrap; }
.device-details { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; min-width: 0; }
.device-details small { width: 100%; color: var(--color-text-muted); }
.device-details code, .device-review dd { overflow-wrap: anywhere; }
.device-form { display: grid; gap: 16px; }
.device-form p { margin: 0; }
.device-form textarea { width: 100%; resize: vertical; }
.device-form > button { justify-self: start; }
.device-review { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 0; }
.device-review dt { color: var(--color-text-muted); }
.device-review dd { margin: 0; }
.device-confirm { display: flex; align-items: flex-start; gap: 8px; }
.device-confirm input { flex: 0 0 18px; width: 18px; height: 18px; min-height: 18px; padding: 0; margin-top: 4px; }
@media (max-width: 600px) { .device-row { align-items: flex-start; } .device-row button { min-height: 44px; } .device-review { grid-template-columns: 1fr; gap: 4px; } .device-review dd { margin-bottom: 8px; } }
</style>
