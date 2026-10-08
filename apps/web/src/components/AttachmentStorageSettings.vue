<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ApiProblem, apiRequest, hasUncertainWrite } from "../lib/api";
import { locale } from "../lib/i18n";
import type { WriteResult } from "../types";

interface AttachmentSettings { limit_bytes: number | null; configured: boolean; version: number; reserved_bytes: number }
type SettingsWrite = { expected_version: number; limit_bytes: number | null };
const emit = defineEmits<{ saved: [] }>();
const settingsPath = "/api/v1/admin/attachment-settings";
const current = ref<AttachmentSettings | null>(null);
const mode = ref<"" | "limited" | "unlimited">("");
const limitMiB = ref("");
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const readFailed = ref(false);
const needsReadback = ref(false);
const error = ref<"" | "invalid" | "save" | "conflict" | "uncertain" | "expired">("");
const pending = ref<SettingsWrite | null>(null);
const controller = new AbortController();
let disposed = false;
let readRetry: ReturnType<typeof setTimeout> | undefined;
let readAttempts = 0;
let lastRead = 0;
const busy = computed(() => loading.value || saving.value);
const limitBytes = computed(() => mode.value === "unlimited" ? null : Number(limitMiB.value) * 1048576);
const valid = computed(() => Boolean(mode.value) && (limitBytes.value === null || Number.isSafeInteger(limitBytes.value) && limitBytes.value > 0));
const dirty = computed(() => current.value !== null && (current.value.configured
  ? !valid.value || limitBytes.value !== current.value.limit_bytes
  : Boolean(mode.value)));
const canSave = computed(() => !busy.value && !needsReadback.value && error.value !== "expired"
  && (pending.value !== null || current.value !== null && dirty.value && valid.value));
function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }
function bytes(value: number): string {
  const index = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${["B", "KiB", "MiB", "GiB"][index]}`;
}
function isSettings(value: unknown): value is AttachmentSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as AttachmentSettings;
  return typeof settings.configured === "boolean" && Number.isSafeInteger(settings.version) && settings.version > 0
    && Number.isSafeInteger(settings.reserved_bytes) && settings.reserved_bytes >= 0
    && (settings.limit_bytes === null || Number.isSafeInteger(settings.limit_bytes) && settings.limit_bytes > 0);
}
function isSettingsWriteResult(value: unknown, body: SettingsWrite): value is WriteResult<AttachmentSettings> {
  if (!value || typeof value !== "object") return false;
  const resource = (value as Partial<WriteResult<AttachmentSettings>>).resource;
  return isSettings(resource) && resource.configured && resource.version === body.expected_version + 1
    && resource.limit_bytes === body.limit_bytes;
}
function resetDraft(): void {
  if (!current.value || busy.value || pending.value) return;
  mode.value = !current.value.configured ? "" : current.value.limit_bytes === null ? "unlimited" : "limited";
  limitMiB.value = current.value.limit_bytes === null ? "" : String(current.value.limit_bytes / 1048576);
  error.value = "";
  saved.value = false;
}
async function readSettings(retainDraft: boolean): Promise<boolean> {
  clearTimeout(readRetry);
  loading.value = true;
  lastRead = Date.now();
  try {
    const result = await apiRequest<AttachmentSettings>(settingsPath, {
      signal: controller.signal, validateResponse: isSettings, authorizationCurrent: () => !disposed,
    });
    if (disposed) return false;
    const changed = current.value !== null && current.value.version !== result.version;
    current.value = result;
    readFailed.value = false;
    needsReadback.value = false;
    readAttempts = 0;
    loading.value = false;
    if (!retainDraft) resetDraft();
    else if (changed && !pending.value) error.value = "conflict";
    return true;
  } catch (caught) {
    if (!disposed) {
      readFailed.value = true;
      if (!(caught instanceof ApiProblem && [401, 403].includes(caught.status)) && ++readAttempts < 3) {
        readRetry = setTimeout(() => { void readSettings(retainDraft); }, 1000);
      }
    }
    return false;
  } finally { if (!disposed) loading.value = false; }
}
async function saveSettings(): Promise<void> {
  if (busy.value || needsReadback.value || !current.value || error.value === "expired") return;
  if (!pending.value && !valid.value) { error.value = "invalid"; return; }
  if (!pending.value && !dirty.value) return;
  const body = pending.value ?? { expected_version: current.value.version, limit_bytes: limitBytes.value };
  pending.value = body;
  saving.value = true;
  saved.value = false;
  error.value = "";
  try {
    const result = await apiRequest<WriteResult<AttachmentSettings>>(settingsPath, {
      method: "PATCH", body, signal: controller.signal, authorizationCurrent: () => !disposed,
      validateResponse: value => isSettingsWriteResult(value, body),
    });
    if (disposed) return;
    current.value = result.resource;
    pending.value = null;
    saving.value = false;
    resetDraft();
    saved.value = true;
    emit("saved");
  } catch (caught) {
    if (disposed) return;
    if (caught instanceof ApiProblem && caught.body.source === "service" && caught.body.code === "VERSION_CONFLICT") {
      pending.value = null;
      needsReadback.value = true;
      error.value = "conflict";
      await readSettings(true);
    } else if (caught instanceof ApiProblem && caught.body.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED") error.value = "expired";
    else if (hasUncertainWrite(settingsPath)) error.value = "uncertain";
    else { pending.value = null; error.value = "save"; }
  } finally { if (!disposed) saving.value = false; }
}
function onFocus(): void {
  if (!busy.value && Date.now() - lastRead >= 60_000) void readSettings(dirty.value || pending.value !== null);
}
watch([mode, limitMiB], () => { saved.value = false; if (error.value === "invalid" || error.value === "save") error.value = ""; }, { flush: "sync" });
onMounted(() => { void readSettings(false); window.addEventListener("focus", onFocus); });
onUnmounted(() => { disposed = true; clearTimeout(readRetry); controller.abort(); window.removeEventListener("focus", onFocus); });
</script>

<template>
  <div class="attachment-storage-settings" aria-labelledby="attachment-storage-settings-heading" :aria-busy="busy">
    <h3 id="attachment-storage-settings-heading">{{ ui('Attachment storage limit', '附件存储上限') }}</h3>
    <p class="muted-copy">{{ ui('Reaching the limit pauses new uploads. Lowering it keeps existing files; uploads and deleted files remain reserved until reclaimed.', '达到上限会暂停新上传。调低上限不删除已有文件；上传中和已删除文件在回收前仍占用容量。') }}</p>
    <dl v-if="current" class="attachment-settings-current">
      <div><dt>{{ ui('Current limit', '当前上限') }}</dt><dd>{{ !current.configured ? ui('Not set', '未设置') : current.limit_bytes === null ? ui('Unlimited', '不限制') : bytes(current.limit_bytes) }}</dd></div>
      <div><dt>{{ ui('Reserved storage', '当前占用') }}</dt><dd>{{ bytes(current.reserved_bytes) }}</dd></div>
    </dl>
    <p v-if="loading" class="muted-copy" role="status">{{ ui('Loading current storage settings…', '正在读取当前存储设置…') }}</p>
    <p v-if="readFailed" class="warning-panel" role="status">{{ current ? ui('Current storage settings could not be read. Earlier values and your draft are retained.', '暂时无法读取当前存储设置，已保留上次结果和草稿。') : ui('Current storage settings could not be read.', '暂时无法读取当前存储设置。') }}</p>
    <form class="attachment-settings-form" @submit.prevent="saveSettings">
      <div class="attachment-settings-fields">
        <label for="attachment-storage-mode">{{ ui('Storage limit', '存储上限') }}<USelect id="attachment-storage-mode" v-model="mode" :disabled="busy || !current || !!pending" :placeholder="ui('Choose…', '请选择…')" :items="[{value:'limited',label:ui('Set a limit','设置容量上限')},{value:'unlimited',label:ui('Unlimited','不限制')}]" /></label>
        <label v-if="mode === 'limited'" for="attachment-storage-mib">{{ ui('Capacity (MiB)', '容量（MiB）') }}<UInput id="attachment-storage-mib" v-model="limitMiB" type="number" min="0.00000095367431640625" step="any" :disabled="busy || !current || !!pending" required /></label>
      </div>
      <p class="muted-copy">{{ ui('1 GiB = 1024 MiB. Unlimited has no application storage cap and may incur R2 charges.', '1 GiB = 1024 MiB。不限制表示没有应用容量上限，仍可能产生 R2 费用。') }}</p>
      <p v-if="error" class="warning-panel" role="alert">{{ error === 'invalid' ? ui('Choose a mode and enter a positive capacity precise to whole bytes.', '请选择模式，并输入可精确换算为整数字节的正容量。') : error === 'conflict' ? ui('The current limit changed elsewhere. Its latest value is shown above. Review it before saving your retained draft again.', '当前上限已被其他操作修改，上方显示最新值。请核对后再次保存，草稿已保留。') : error === 'uncertain' ? ui('This save is not confirmed. Your draft is retained; save again to verify the same request before editing.', '本次保存尚未确认，草稿已保留。请再次保存以核实原请求，再继续编辑。') : error === 'expired' ? ui('This save can no longer be retried safely. Your draft is retained; the original result still needs verification.', '本次保存已超过安全重试期限，草稿已保留，仍需核实原操作结果。') : ui('Could not save the storage limit. Your draft is retained; try again.', '存储上限保存失败，草稿已保留，请重试。') }}</p>
      <div class="attachment-settings-actions">
        <UButton color="neutral" variant="ghost" type="button" :disabled="busy || !dirty || !!pending" @click="resetDraft">{{ ui('Discard changes', '放弃修改') }}</UButton>
        <UButton color="neutral" variant="outline" type="submit" :disabled="!canSave">{{ saving ? ui('Saving…', '正在保存…') : ui('Save storage limit', '保存存储上限') }}</UButton>
      </div>
    </form>
    <p v-if="saved" role="status">{{ ui('Storage limit saved.', '存储上限已保存。') }}</p>
  </div>
</template>

<style scoped>
.attachment-storage-settings { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--color-border); }
.attachment-storage-settings h3 { margin: 0 0 8px; font-size: 15px; }
.attachment-settings-current { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 16px 0; }
.attachment-settings-current dt { font-size: 13px; color: var(--color-text-muted); }
.attachment-settings-current dd { margin: 4px 0 0; font-weight: 600; }
.attachment-settings-form { display: grid; gap: 12px; }
.attachment-settings-fields { display: flex; flex-wrap: wrap; gap: 12px 24px; }
.attachment-settings-fields label { display: grid; flex: 0 1 240px; min-width: 0; gap: 6px; }
.attachment-settings-form p { margin: 0; }
.attachment-settings-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
</style>
