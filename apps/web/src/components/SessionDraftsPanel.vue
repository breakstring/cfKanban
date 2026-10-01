<script setup lang="ts">
import { ref } from "vue";
import { locale } from "../lib/i18n";
import { navigate } from "../lib/router";
import { canRestoreSessionTextDraft, discardSessionTextDraft, restoreSessionTextDraft, retainedSessionTextDrafts, sessionTextDraftCopy, type RetainedSessionTextDraft } from "../lib/session-drafts";
import type { WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView | null }>();
const copiedDraftId = ref<number | null>(null);
const draftRestoreFailedId = ref<number | null>(null);

async function copyDraft(draft: RetainedSessionTextDraft): Promise<void> {
  copiedDraftId.value = draft.id;
  try { await window.navigator.clipboard.writeText(sessionTextDraftCopy(draft)); } catch { /* Select the displayed plain text instead. */ }
}
async function restoreDraft(draft: RetainedSessionTextDraft): Promise<void> {
  const owner = props.session?.principal.id;
  if (!owner || !canRestoreSessionTextDraft(draft, owner)) return;
  if (!window.confirm(locale.value === "zh-CN" ? "恢复这些文字会替换本表单的对应输入，但不会提交。确认恢复？" : "Restore this text into the form, replacing its corresponding inputs without submitting?")) return;
  draftRestoreFailedId.value = null;
  try { if (!await restoreSessionTextDraft(draft.id, owner)) draftRestoreFailedId.value = draft.id; }
  catch { draftRestoreFailedId.value = draft.id; }
}
</script>

<template>
  <section v-if="retainedSessionTextDrafts.length" class="session-text-drafts page-shell" aria-live="polite">
    <h2>{{ locale === 'zh-CN' ? '本页保留的文字草稿' : 'Text drafts retained on this page' }}</h2>
    <p>{{ locale === 'zh-CN' ? '只保存在当前页面内存；刷新或关闭页面会丢失。重新登录后可打开原表单，核对当前权限并明确恢复；也可复制文字。' : 'Kept only in this page memory; refreshing or closing loses them. After signing in, open the form, check current access, and explicitly restore, or copy the text.' }}</p>
    <article v-for="draft in retainedSessionTextDrafts" :key="draft.id">
      <strong>{{ locale === 'zh-CN' ? draft.label.zh : draft.label.en }}</strong>
      <p v-if="draft.copyOnly" role="alert">{{ locale === 'zh-CN' ? '上次提交结果尚未确定，请先核对；此草稿仅提供复制，不恢复或重发请求。' : 'Check the previous submission outcome first. This draft supports copying only; it will not restore or resend a request.' }}</p>
      <p v-if="draftRestoreFailedId === draft.id" role="alert">{{ locale === 'zh-CN' ? '暂时无法验证或恢复此表单；文字仍保留，可复制。' : 'The form could not be verified or restored. Your text is retained and can be copied.' }}</p>
      <div class="form-actions">
        <button class="secondary-button" type="button" @click="copyDraft(draft)">{{ locale === 'zh-CN' ? '复制文字' : 'Copy text' }}</button>
        <button v-if="session && !draft.copyOnly" class="secondary-button" type="button" @click="navigate(draft.path)">{{ locale === 'zh-CN' ? '打开原表单' : 'Open form' }}</button>
        <button v-if="session && canRestoreSessionTextDraft(draft, session.principal.id)" class="primary-button" type="button" @click="restoreDraft(draft)">{{ locale === 'zh-CN' ? '恢复文字' : 'Restore text' }}</button>
        <button class="secondary-button" type="button" @click="discardSessionTextDraft(draft.id)">{{ locale === 'zh-CN' ? '丢弃' : 'Discard' }}</button>
      </div>
      <label v-if="copiedDraftId === draft.id">{{ locale === 'zh-CN' ? '可选中并复制的文字' : 'Text you can select and copy' }}<textarea readonly :value="sessionTextDraftCopy(draft)" rows="5" /></label>
    </article>
  </section>
</template>

<style scoped>
.session-text-drafts { margin: 16px auto; padding: 16px; border: 1px solid var(--color-border); border-radius: 12px; }
.session-text-drafts article + article { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-border); }
.session-text-drafts textarea { display: block; width: 100%; margin-top: 8px; }
</style>
