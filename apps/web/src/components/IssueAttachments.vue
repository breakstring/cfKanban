<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";

import ErrorNotice from "./ErrorNotice.vue";
import ModalDialog from "./ModalDialog.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { type Attachment, type AttachmentUploadDraft, captureAttachmentUploadDraft } from "../lib/attachment-upload-drafts";
import { locale, t } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor, cursorRequiresRestart, mergePageById } from "../lib/pagination";
import { ProjectionGeneration } from "../lib/projection-generation";
import { isVerifiedServiceAccessFailure } from "../lib/session-boundary";
import { WriteFence } from "../lib/write-fence";
import type { ListResult, WriteResult } from "../types";

interface AttachmentList extends ListResult<Attachment> {
  capabilities: { attachments: boolean };
  limits: { max_file_bytes: number; max_active_per_issue: number; max_storage_bytes: number | null; storage_limit_configured: boolean };
}
const props = defineProps<{ identifier: string; canUpload: boolean; sessionId: string; principalId: string }>();
let savedDraft = captureAttachmentUploadDraft(props.sessionId, props.principalId, props.identifier);
if (!props.canUpload) savedDraft.set(null);
const attachments = ref<Attachment[]>([]);
const nextCursor = ref<string | null>(null);
const enabled = ref<boolean | null>(null);
const storageLimitConfigured = ref(false);
const maxFileBytes = ref(10 * 1024 * 1024);
const maxFiles = ref(20);
const loading = ref(false);
const busy = ref(false);
const deletedOnly = ref(false);
const dropping = ref(false);
const draft = shallowRef<AttachmentUploadDraft | null>(savedDraft.get());
const uploadPhase = ref<"selected" | "hashing" | "reserving" | "uploading" | "failed">(draft.value?.reserveStarted ? "failed" : "selected");
const deleteTarget = ref<Attachment | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const { clearError, error, setError, setLocalizedError } = useLocalizedError();
const generation = new ProjectionGeneration();
const writeFence = new WriteFence();
let controller = new AbortController();
let listRequestId = 0;
const canChoose = computed(() => props.canUpload && enabled.value === true && storageLimitConfigured.value && !busy.value && draft.value === null);
const progressText = computed(() => ({
  selected: ui("Ready to upload", "准备上传"),
  hashing: ui("Checking file…", "正在校验文件…"),
  reserving: ui("Reserving space…", "正在预留空间…"),
  uploading: ui("Uploading…", "正在上传…"),
  failed: ui("Upload interrupted. Retry continues the same file.", "上传中断。重试会继续同一个文件。"),
}[uploadPhase.value]));

function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024))} ${bytes < 1024 * 1024 ? "KiB" : "MiB"}`;
}
function contentUrl(item: Attachment): string { return `/api/v1/attachments/${encodeURIComponent(item.id)}/content`; }
function current(stamp: number): boolean { return savedDraft.isCurrent() && generation.isCurrent(stamp) && !controller.signal.aborted; }
function forgetUnauthorizedDraft(caught: unknown): void {
  if (caught instanceof ApiProblem && isVerifiedServiceAccessFailure(caught.status, caught.body)) draft.value = null;
}

async function load(reset = true): Promise<void> {
  if (!reset && nextCursor.value === null) return;
  const stamp = generation.capture();
  const requestId = ++listRequestId;
  const params = new URLSearchParams({ limit: "20" });
  if (deletedOnly.value) params.set("deleted", "only");
  if (!reset && nextCursor.value) params.set("cursor", nextCursor.value);
  loading.value = true;
  if (reset) clearError();
  try {
    const result = await apiRequest<AttachmentList>(`/api/v1/issues/${encodeURIComponent(props.identifier)}/attachments?${params}`, { signal: controller.signal });
    if (!current(stamp) || requestId !== listRequestId) return;
    attachments.value = mergePageById(attachments.value, result.items, reset);
    nextCursor.value = continuationCursor(result);
    enabled.value = result.capabilities.attachments;
    storageLimitConfigured.value = result.limits.storage_limit_configured;
    maxFileBytes.value = Math.min(result.limits.max_file_bytes, 10 * 1024 * 1024);
    maxFiles.value = result.limits.max_active_per_issue;
  } catch (caught) {
    if (!current(stamp) || requestId !== listRequestId) return;
    if (cursorRequiresRestart(caught)) nextCursor.value = null;
    if (caught instanceof ApiProblem && [401, 403, 404].includes(caught.status)) attachments.value = [];
    forgetUnauthorizedDraft(caught);
    setError(caught);
  } finally {
    if (current(stamp) && requestId === listRequestId) loading.value = false;
  }
}

function selectFiles(files: FileList | null): void {
  if (!canChoose.value || files === null || files.length === 0) return;
  clearError();
  if (files.length !== 1) { setLocalizedError("Choose one file at a time.", "每次请选择一个文件。"); return; }
  const file = files.item(0);
  if (file === null) return;
  if (file.size < 1 || file.size > maxFileBytes.value) {
    setLocalizedError(`Choose a non-empty file no larger than ${sizeLabel(maxFileBytes.value)}.`, `请选择非空且不超过 ${sizeLabel(maxFileBytes.value)} 的文件。`);
    return;
  }
  if (!file.name.trim() || file.name === "." || file.name === ".." || [...file.name].length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(file.name)) {
    setLocalizedError("Use a filename under 180 characters without paths or control characters.", "文件名不能超过 180 字符，也不能包含路径或控制字符。");
    return;
  }
  draft.value = { file, sha256: null, reserveKey: crypto.randomUUID(), uploadKey: crypto.randomUUID(), attachment: null, reserveStarted: false, firstAttemptAt: null };
  uploadPhase.value = "selected";
}
function onSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  selectFiles(input.files);
  input.value = "";
}
function onDrop(event: DragEvent): void {
  dropping.value = false;
  selectFiles(event.dataTransfer?.files ?? null);
}

async function upload(): Promise<void> {
  const attempt = draft.value;
  if (!attempt || !props.canUpload || !enabled.value || (!storageLimitConfigured.value && !attempt.reserveStarted) || !writeFence.enter("upload")) return;
  const stamp = generation.capture();
  busy.value = true;
  clearError();
  try {
    if (attempt.firstAttemptAt !== null && Date.now() >= attempt.firstAttemptAt + 24 * 60 * 60 * 1000) {
      setLocalizedError("The safe retry window ended. Refresh the attachment list and review the existing upload before starting again.", "安全重试时间已结束。请刷新附件列表，核对已有上传后再重新开始。");
      uploadPhase.value = "failed";
      return;
    }
    if (attempt.sha256 === null) {
      uploadPhase.value = "hashing";
      const bytes = await attempt.file.arrayBuffer();
      if (!current(stamp)) return;
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      if (!current(stamp)) return;
      attempt.sha256 = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
    }
    if (attempt.attachment === null) {
      uploadPhase.value = "reserving";
      attempt.reserveStarted = true;
      attempt.firstAttemptAt ??= Date.now();
      const result = await apiRequest<WriteResult<Attachment>>(`/api/v1/issues/${encodeURIComponent(props.identifier)}/attachments`, {
        method: "POST", idempotencyKey: attempt.reserveKey, signal: controller.signal,
        body: { filename: attempt.file.name, content_type: attempt.file.type || "application/octet-stream", size_bytes: attempt.file.size, sha256: attempt.sha256 },
      });
      if (!current(stamp)) return;
      attempt.attachment = result.resource;
    } else {
      const latest = await apiRequest<Attachment>(`/api/v1/attachments/${encodeURIComponent(attempt.attachment.id)}`, { signal: controller.signal });
      if (!current(stamp)) return;
      attempt.attachment = latest;
    }
    if (attempt.attachment.state !== "ready") {
      if (!attempt.attachment.allowed_actions.includes("upload")) {
        setLocalizedError("This reservation can no longer accept an upload. Refresh its current state.", "此预留已不能继续上传，请刷新查看当前状态。");
        uploadPhase.value = "failed";
        return;
      }
      uploadPhase.value = "uploading";
      const result = await apiRequest<WriteResult<Attachment>>(`${contentUrl(attempt.attachment)}`, {
        method: "PUT", rawBody: attempt.file, idempotencyKey: attempt.uploadKey, signal: controller.signal,
      });
      if (!current(stamp)) return;
      attempt.attachment = result.resource;
    }
    draft.value = null;
    deletedOnly.value = false;
    await load();
  } catch (caught) {
    if (!current(stamp)) return;
    forgetUnauthorizedDraft(caught);
    if (attempt.attachment === null && caught instanceof ApiProblem && caught.body.source === "service"
      && (caught.body.category === "validation" || caught.body.category === "business_quota")) attempt.reserveStarted = false;
    uploadPhase.value = "failed";
    setError(caught);
  } finally {
    writeFence.leave("upload");
    if (current(stamp)) busy.value = false;
  }
}

async function changeAttachment(item: Attachment, restore: boolean): Promise<void> {
  const action = restore ? "restore" : "delete";
  if (!item.allowed_actions.includes(action) || !writeFence.enter(item.id)) return;
  const stamp = generation.capture();
  busy.value = true;
  clearError();
  try {
    await apiRequest(`/api/v1/attachments/${encodeURIComponent(item.id)}${restore ? "/commands/restore" : `?expected_version=${item.version}`}`, {
      method: restore ? "POST" : "DELETE", signal: controller.signal,
      ...(restore ? { body: { expected_version: item.version } } : {}),
    });
    if (!current(stamp)) return;
    deleteTarget.value = null;
    if (draft.value?.attachment?.id === item.id) draft.value = null;
    await load();
  } catch (caught) {
    if (!current(stamp)) return;
    // Refresh facts after a CAS failure; the user decides whether to repeat the action.
    if (caught instanceof ApiProblem && caught.status === 409) {
      try {
        const latest = await apiRequest<Attachment>(`/api/v1/attachments/${encodeURIComponent(item.id)}`, { signal: controller.signal });
        if (current(stamp)) {
          attachments.value = attachments.value
            .map((entry) => entry.id === latest.id ? latest : entry)
            .filter((entry) => (entry.deleted_at !== null) === deletedOnly.value);
          if (deleteTarget.value?.id === latest.id) deleteTarget.value = latest;
        }
      } catch { /* The original failure remains visible if readback is unavailable. */ }
    }
    if (current(stamp)) setError(caught);
  } finally {
    writeFence.leave(item.id);
    if (current(stamp)) busy.value = false;
  }
}

function toggleDeleted(): void {
  if (busy.value) return;
  deletedOnly.value = !deletedOnly.value;
  attachments.value = [];
  nextCursor.value = null;
  void load();
}
function resetScope(): void {
  generation.invalidate();
  controller.abort();
  controller = new AbortController();
  attachments.value = [];
  savedDraft = captureAttachmentUploadDraft(props.sessionId, props.principalId, props.identifier);
  if (!props.canUpload) savedDraft.set(null);
  draft.value = savedDraft.get();
  uploadPhase.value = draft.value?.reserveStarted ? "failed" : "selected";
  deleteTarget.value = null;
  nextCursor.value = null;
  enabled.value = null;
  busy.value = false;
  void load();
}
watch(draft, (value) => savedDraft.set(value), { flush: "sync" });
watch(() => [props.identifier, props.canUpload, props.sessionId, props.principalId], resetScope);
onMounted(() => { void load(); });
onUnmounted(() => { generation.invalidate(); controller.abort(); });
</script>

<template>
  <section class="content-section attachment-section" :aria-label="ui('Attachments', '附件')">
    <div class="section-heading-row compact">
      <h2>{{ ui("Attachments", "附件") }}</h2>
      <button v-if="enabled && canUpload" class="text-button muted" type="button" :disabled="busy" @click="toggleDeleted">{{ deletedOnly ? ui("Active files", "使用中的附件") : ui("Deleted files", "已删除附件") }}</button>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="enabled === false" class="attachment-note">{{ ui("Attachment storage is not enabled. Ask the Owner to enable it.", "附件存储尚未启用，请联系所有者开启。") }}</p>
    <template v-else-if="enabled">
      <p v-if="!storageLimitConfigured" class="attachment-note">{{ ui("New uploads require the Owner to set a storage limit or explicitly choose unlimited. Existing files remain accessible.", "所有者需先设置存储上限或明确选择不限制，才能上传新文件。已有文件仍可访问。") }}</p>
      <div v-if="canUpload && !deletedOnly" class="attachment-dropzone" :class="{ 'is-dragging': dropping, 'is-disabled': !canChoose }" @dragover.prevent="dropping = canChoose" @dragleave.prevent="dropping = false" @drop.prevent="onDrop">
        <input ref="fileInput" type="file" class="attachment-file-input" tabindex="-1" :disabled="!canChoose" @change="onSelect" />
        <button class="secondary-button button-with-icon" type="button" :disabled="!canChoose" @click="fileInput?.click()"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 10 5-5a3 3 0 0 1 4 4l-7 7a4.5 4.5 0 0 1-6-6l7-7" /></svg>{{ ui("Choose a file", "选择文件") }}</button>
        <p>{{ ui("or drop one here", "或拖入一个文件") }}<small>{{ sizeLabel(maxFileBytes) }} {{ ui("per file", "以内") }} · {{ ui(`Up to ${maxFiles} files per issue`, `每个事项最多 ${maxFiles} 个附件`) }}</small></p>
      </div>
      <div v-if="canUpload && draft" class="attachment-upload" role="status" :aria-busy="busy">
        <div><strong>{{ draft.file.name }}</strong><small>{{ sizeLabel(draft.file.size) }} · {{ progressText }}</small></div>
        <div class="attachment-row-actions">
          <button v-if="!busy" class="primary-button" type="button" :disabled="!storageLimitConfigured && !draft.reserveStarted" @click="upload">{{ uploadPhase === 'failed' ? ui('Retry upload', '重试上传') : ui('Upload', '上传') }}</button>
          <button v-if="!busy && !draft.reserveStarted" class="text-button" type="button" @click="draft = null">{{ t("action.cancel") }}</button>
          <button v-if="!busy && draft.attachment?.allowed_actions.includes('delete')" class="text-button muted" type="button" @click="deleteTarget = draft.attachment">{{ ui("Cancel upload", "取消上传") }}</button>
        </div>
      </div>
      <div v-if="attachments.length" class="attachment-list">
        <article v-for="item in attachments" :key="item.id" class="attachment-row">
          <a v-if="item.preview_content_type && item.allowed_actions.includes('download')" class="attachment-thumbnail" :href="`${contentUrl(item)}?preview=1`" target="_blank" rel="noopener noreferrer" :aria-label="`${ui('Preview', '预览')} ${item.filename}`"><img :src="`${contentUrl(item)}?preview=1`" alt="" loading="lazy" /></a>
          <div v-else class="attachment-file-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H5V3h2Zm7 0v6h5M8 13h8M8 17h5" /></svg></div>
          <div class="attachment-file-info"><a v-if="item.allowed_actions.includes('download')" :href="contentUrl(item)" download>{{ item.filename }}</a><strong v-else>{{ item.filename }}</strong><small>{{ sizeLabel(item.size_bytes) }} · {{ item.uploaded_by.display_name }}<template v-if="item.state !== 'ready'"> · {{ item.state === 'pending' ? ui('Upload pending', '上传未完成') : ui('Expired', '已过期') }}</template></small></div>
          <div class="attachment-row-actions"><a v-if="item.allowed_actions.includes('download')" class="text-button attachment-download" :href="contentUrl(item)" download>{{ ui("Download", "下载") }}</a><button v-if="item.allowed_actions.includes('delete')" class="text-button muted" type="button" :disabled="busy" @click="deleteTarget = item">{{ t("action.delete") }}</button><button v-if="item.allowed_actions.includes('restore')" class="secondary-button" type="button" :disabled="busy" @click="changeAttachment(item, true)">{{ t("action.restore") }}</button></div>
        </article>
      </div>
      <p v-else-if="!loading && !draft" class="attachment-note">{{ deletedOnly ? ui('No deleted attachments.', '没有已删除的附件。') : ui('No attachments yet.', '还没有附件。') }}</p>
      <button v-if="nextCursor" class="load-more" type="button" :disabled="loading" @click="load(false)">{{ ui("Load more files", "加载更多附件") }}</button>
    </template>
    <p v-if="loading" class="attachment-note" role="status">{{ ui("Loading attachments…", "正在加载附件…") }}</p>
    <button v-else-if="error" class="text-button" type="button" :disabled="busy" @click="load()">{{ t("action.refresh") }}</button>
    <ModalDialog v-if="deleteTarget" :busy="busy" :title="deleteTarget.state === 'ready' ? ui('Delete attachment?', '删除附件？') : ui('Cancel this upload?', '取消上传？')" @close="deleteTarget = null">
      <p class="attachment-confirm-name">{{ deleteTarget.filename }}</p><p class="muted-copy">{{ deleteTarget.state === 'ready' ? ui('The file can be restored. Deleting it does not release its storage budget.', '文件可恢复；软删除不会释放存储预算。') : ui('This upload reservation will be canceled and cannot be restored.', '将取消这次上传预留，取消后不能恢复。') }}</p>
      <ErrorNotice v-if="error" :error="error" />
      <div class="form-actions"><button class="secondary-button" type="button" :disabled="busy" @click="deleteTarget = null">{{ t("action.cancel") }}</button><button class="danger-button" type="button" :disabled="busy || !deleteTarget.allowed_actions.includes('delete')" @click="changeAttachment(deleteTarget, false)">{{ t("action.delete") }}</button></div>
    </ModalDialog>
  </section>
</template>

<style scoped>
.attachment-section { min-width: 0; }
.attachment-section > .section-heading-row { margin-bottom: 18px; }
.attachment-note { margin: 14px 0 0; color: var(--color-text-muted); font-size: .875rem; }
.attachment-dropzone { display: flex; align-items: center; gap: 16px; padding: 20px; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-card); background: var(--color-surface); }
.attachment-dropzone.is-dragging { border-color: var(--color-primary); background: var(--color-surface-muted); }
.attachment-dropzone.is-disabled { border-color: var(--color-border); }
.attachment-dropzone p { margin: 0; color: var(--color-text-muted); font-size: .85rem; }
.attachment-dropzone small, .attachment-upload small, .attachment-file-info small { display: block; margin-top: 4px; color: var(--color-text-muted); font-size: .75rem; }
.attachment-file-input { display: none; }
.attachment-upload { display: flex; gap: 14px; align-items: center; justify-content: space-between; margin-top: 14px; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.attachment-upload > div:first-child { min-width: 0; }
.attachment-upload strong { font-size: .875rem; overflow-wrap: anywhere; }
.attachment-list { margin-top: 18px; }
.attachment-row { display: flex; gap: 14px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--color-border); }
.attachment-thumbnail, .attachment-file-mark { display: grid; flex: 0 0 48px; width: 48px; height: 48px; border: 1px solid var(--color-border); border-radius: var(--radius-control); overflow: hidden; place-items: center; background: var(--color-surface); }
.attachment-thumbnail img { width: 100%; height: 100%; object-fit: cover; }
.attachment-file-mark svg { width: 24px; fill: none; stroke: var(--color-text-muted); stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
.attachment-file-info { flex: 1; min-width: 0; }
.attachment-file-info > a, .attachment-file-info > strong { color: var(--color-text); font-size: .875rem; font-weight: 600; overflow-wrap: anywhere; text-decoration-color: var(--color-border-strong); text-underline-offset: 3px; }
.attachment-file-info > a:hover { color: var(--color-primary); }
.attachment-row-actions { display: flex; flex-shrink: 0; gap: 4px; align-items: center; }
.attachment-download { display: inline-flex; align-items: center; text-decoration: none; }
.attachment-confirm-name { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .attachment-dropzone { flex-direction: column; align-items: flex-start; padding: 16px; gap: 10px; }
  .attachment-upload { flex-direction: column; align-items: stretch; }
  .attachment-row { flex-wrap: wrap; gap: 10px; }
  .attachment-row > .attachment-row-actions { width: 100%; justify-content: flex-end; }
}
</style>
