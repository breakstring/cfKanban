<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

import ErrorNotice from "./ErrorNotice.vue";
import { ApiProblem, apiRequest, clearPendingRequestIntents, hasUncertainWrite } from "../lib/api";
import { HomepageSettingsDraft, isHomepageSettings, isHomepageSettingsWriteResult, noticeLength } from "../lib/homepage-notice";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { changedTextFields, useSessionTextDraft, verifySessionTextDraftIdentity } from "../lib/session-drafts";
import type { HomepageSettings, WriteResult } from "../types";

const draft = reactive(new HomepageSettingsDraft());
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const reviewing = ref(false);
const retryExpired = ref(false);
const busy = computed(() => loading.value || saving.value);
const { error, clearError, setError } = useLocalizedError();
const controller = new AbortController();
let disposed = false;
function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }

const settingsPath = "/api/v1/admin/homepage-settings";
const draftRestoreReady = () => !disposed && !busy.value && draft.current !== null
  && draft.pending === null && !draft.requiresReadback && !hasUncertainWrite(settingsPath);
useSessionTextDraft({
  key: "homepage-notice", path: "/app/admin",
  label: { en: "Homepage notice", zh: "首页实例说明" },
  capture: () => draft.current === null ? null : changedTextFields({
    english: [draft.english, draft.current.notice_en ?? ""],
    chinese: [draft.chinese, draft.current.notice_zh_cn ?? ""],
  }),
  canRestore: draftRestoreReady,
  uncertain: () => busy.value || draft.pending !== null || draft.requiresReadback || hasUncertainWrite(settingsPath),
  restore: async (fields, _target, isCurrent) => {
    const current = await apiRequest<HomepageSettings>(settingsPath, {
      signal: controller.signal, validateResponse: isHomepageSettings, authorizationCurrent: isCurrent,
    });
    if (!isCurrent() || !draftRestoreReady()) return false;
    const verified = await verifySessionTextDraftIdentity(isCurrent);
    if (!isCurrent() || !verified?.principal.is_owner || verified.allowed_scope.kind !== "instance" || !draftRestoreReady()) return false;
    const localFields = draft.current ? changedTextFields({ english: [draft.english, draft.current.notice_en ?? ""], chinese: [draft.chinese, draft.current.notice_zh_cn ?? ""] }) : null;
    draft.receive(current, false);
    if (localFields?.english !== undefined) draft.english = localFields.english;
    if (localFields?.chinese !== undefined) draft.chinese = localFields.chinese;
    if (fields.english !== undefined) draft.english = fields.english;
    if (fields.chinese !== undefined) draft.chinese = fields.chinese;
    saved.value = false;
    reviewing.value = true;
    return true;
  },
});

async function load(): Promise<void> {
  if (busy.value) return;
  loading.value = true;
  saved.value = false;
  clearError();
  const retainDraft = draft.current !== null;
  try {
    const result = await apiRequest<HomepageSettings>("/api/v1/admin/homepage-settings", { signal: controller.signal, validateResponse: isHomepageSettings });
    if (disposed) return;
    draft.receive(result, retainDraft);
    reviewing.value = retainDraft;
  } catch (caught) {
    if (!disposed) setError(caught);
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function save(retryOriginal = false): Promise<void> {
  if (busy.value || (retryOriginal ? draft.pending === null || retryExpired.value : !draft.canSave)) return;
  const body = draft.beginWrite();
  saving.value = true;
  saved.value = false;
  clearError();
  try {
    const result = await apiRequest<WriteResult<HomepageSettings>>("/api/v1/admin/homepage-settings", {
      method: "PATCH", body, signal: controller.signal,
      validateResponse: value => isHomepageSettingsWriteResult(value, body),
    });
    if (disposed) return;
    saved.value = draft.finishWrite(result.resource);
    reviewing.value = !saved.value;
  } catch (caught) {
    if (disposed) return;
    if (caught instanceof ApiProblem) {
      if (caught.body.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED") retryExpired.value = true;
      if (caught.body.source === "service" && (caught.body.code === "VERSION_CONFLICT"
        || (!retryOriginal && caught.status === 400 && caught.body.category === "validation"))) {
        draft.pending = null;
        if (caught.body.code === "VERSION_CONFLICT") draft.requiresReadback = true;
      }
    }
    setError(caught);
  } finally {
    if (!disposed) saving.value = false;
  }
}

function resolvePending(): void {
  if (busy.value || !draft.canRetirePending) return;
  draft.retirePending();
  clearPendingRequestIntents("PATCH", "/api/v1/admin/homepage-settings");
  retryExpired.value = false;
  clearError();
}

function restoreDefaults(): void {
  draft.reset();
  saved.value = false;
}

onMounted(load);
onUnmounted(() => { disposed = true; controller.abort(); });
</script>

<template>
  <section class="owner-section homepage-settings" aria-labelledby="homepage-settings-heading" :aria-busy="busy">
    <div class="section-heading-row">
      <div>
        <h2 id="homepage-settings-heading">{{ ui('Homepage instance notice', '首页实例说明') }}</h2>
        <p id="homepage-settings-help">{{ ui('Publicly visible plain text, up to 500 Unicode characters per language. Leave Chinese blank to use English; otherwise blank fields use the built-in notice.', '对所有访客公开，仅显示纯文本，每种语言最多 500 个 Unicode 字符。中文留空时先使用英文；仍无内容时使用内置说明。') }}</p>
      </div>
    </div>
    <p v-if="loading" role="status" class="muted-copy">{{ ui('Loading saved content…', '正在加载已保存内容…') }}</p>
    <ErrorNotice v-if="error" :error="error" />
    <div v-if="draft.pending" class="warning-panel" role="alert">
      <p>{{ ui('This save is not confirmed yet. Your edits are retained. Check the saved content or retry this same save before making another change.', '本次保存尚未确认，输入已保留。请先查看已保存内容，或重试本次保存，再进行其他修改。') }}</p>
      <p v-if="retryExpired">{{ ui('This save can no longer be retried safely. Check the saved content before making another change.', '本次保存已超过安全重试期限，请先查看已保存内容，再决定后续修改。') }}</p>
      <div class="homepage-settings-actions">
        <UButton color="neutral" variant="outline" class="secondary-button" type="button" :disabled="busy || retryExpired" @click="save(true)">{{ ui('Retry this save', '重试本次保存') }}</UButton>
        <UButton color="neutral" variant="outline" v-if="draft.canRetirePending" class="secondary-button" type="button" :disabled="busy" @click="resolvePending">{{ ui('Content reviewed; continue editing', '已核对内容，继续编辑') }}</UButton>
      </div>
    </div>
    <p v-if="!draft.current && !loading" class="warning-panel">{{ ui('Saved content could not be loaded. Try loading it again before editing.', '已保存内容未能加载，请重新加载后再编辑。') }}</p>
    <p v-if="draft.requiresReadback" class="warning-panel" role="alert">{{ ui('Someone changed this content. Your edits are retained. Check the saved content before saving again.', '内容已被其他操作修改，你的输入已保留。请查看已保存内容后再决定是否保存。') }}</p>
    <UButton v-if="!loading && (!draft.current || draft.requiresReadback || draft.pending)" color="neutral" variant="outline" class="secondary-button" type="button" :disabled="busy" @click="load">{{ draft.current ? ui('Check saved content', '查看已保存内容') : ui('Retry loading', '重新加载') }}</UButton>
    <div v-if="reviewing && draft.current" class="homepage-current" role="status">
      <p>{{ ui('Latest saved values are shown below. Your draft is retained; saving will replace these values.', '下方是最新保存的内容。你的草稿已保留；保存将替换这些内容。') }}</p>
      <dl>
        <dt>English</dt><dd>{{ draft.current.notice_en ?? ui('Use fallback', '使用回退说明') }}</dd>
        <dt>简体中文</dt><dd>{{ draft.current.notice_zh_cn ?? ui('Use fallback', '使用回退说明') }}</dd>
      </dl>
    </div>
    <form @submit.prevent="save()">
      <fieldset :disabled="busy || !draft.current">
        <label for="homepage-notice-en">English</label>
        <textarea id="homepage-notice-en" v-model="draft.english" rows="3" aria-describedby="homepage-settings-help homepage-notice-en-count" :aria-invalid="noticeLength(draft.english) > 500" @input="saved = false" />
        <p id="homepage-notice-en-count" class="muted-copy">{{ noticeLength(draft.english) }} / 500</p>
        <label for="homepage-notice-zh">简体中文</label>
        <textarea id="homepage-notice-zh" v-model="draft.chinese" rows="3" aria-describedby="homepage-settings-help homepage-notice-zh-count" :aria-invalid="noticeLength(draft.chinese) > 500" @input="saved = false" />
        <p id="homepage-notice-zh-count" class="muted-copy">{{ noticeLength(draft.chinese) }} / 500</p>
        <p v-if="!draft.valid" class="warning-panel" role="alert">{{ ui('Each language must contain at most 500 Unicode characters after trimming whitespace.', '去除首尾空白后，每种语言最多 500 个 Unicode 字符。') }}</p>
        <div class="homepage-settings-actions">
          <UButton color="neutral" variant="outline" class="secondary-button" type="submit" :disabled="!draft.canSave">{{ saving ? ui('Saving…', '正在保存…') : ui('Save', '保存') }}</UButton>
          <UButton color="neutral" variant="ghost" class="text-button" type="button" @click="restoreDefaults">{{ ui('Restore defaults', '恢复默认') }}</UButton>
        </div>
        <p class="muted-copy">{{ ui('Restore defaults clears both fields. Save to apply the change.', '恢复默认只清空两个输入框，保存后生效。') }}</p>
      </fieldset>
    </form>
    <p v-if="saved" role="status">{{ ui('Homepage notice saved.', '首页实例说明已保存。') }}</p>
  </section>
</template>

<style scoped>
.homepage-settings fieldset { display: grid; gap: 8px; min-width: 0; margin: 16px 0 0; padding: 0; border: 0; }
.homepage-settings textarea { width: 100%; resize: vertical; }
.homepage-settings label { font-weight: 600; }
.homepage-settings .muted-copy { margin: 0 0 8px; }
.homepage-settings-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.homepage-current { margin-top: 16px; padding: 12px; border: 1px solid var(--color-border); border-radius: 8px; }
.homepage-current p { margin-top: 0; }
.homepage-current dd { margin: 4px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
