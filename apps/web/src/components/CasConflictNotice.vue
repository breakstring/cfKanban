<script setup lang="ts">
import { ref } from "vue";

import type { CasConflictState } from "../lib/cas-recovery";
import { locale } from "../lib/i18n";
import { resolveLocalizedText } from "../lib/localized-error";

defineProps<{ busy?: boolean; conflict: CasConflictState }>();
const emit = defineEmits<{ dismiss: []; refresh: [] }>();
const copyFailed = ref(false);

async function copyDraft(value: string): Promise<void> {
  copyFailed.value = false;
  try {
    await window.navigator.clipboard.writeText(value);
  } catch {
    copyFailed.value = true;
  }
}
</script>

<template>
  <section class="warning-panel cas-conflict" role="alert">
    <strong>{{ locale === "zh-CN" ? `${resolveLocalizedText(conflict.resource, locale)} 已被其他写入更新` : `${resolveLocalizedText(conflict.resource, locale)} changed remotely` }}</strong>
    <p>
      {{ conflict.currentVersion === null
        ? (locale === "zh-CN" ? "服务端报告版本冲突。" : "The service reported a version conflict.")
        : (locale === "zh-CN" ? `服务端当前版本为 v${conflict.currentVersion}。` : `The remote version is v${conflict.currentVersion}.`) }}
      {{ conflict.readbackState === "complete"
        ? (locale === "zh-CN" ? "最新事实已读回；本地草稿仍保留，请重新判断后再提交。" : "The latest fact was read back. Your local draft is retained for review.")
        : conflict.readbackState === "failed"
          ? (locale === "zh-CN" ? "最新事实读回失败；请再次刷新。不会自动合并或重放。" : "The latest fact could not be read back. Refresh again; nothing will be merged or replayed automatically.")
          : (locale === "zh-CN" ? "正在读回最新事实；不会自动合并或重放。" : "Reading the latest fact; nothing will be merged or replayed automatically.") }}
    </p>
    <label v-if="conflict.draft">
      {{ locale === "zh-CN" ? "本地未提交草稿" : "Unsubmitted local draft" }}
      <textarea :value="conflict.draft" readonly rows="4" />
    </label>
    <p v-if="copyFailed" class="inline-alert">{{ locale === "zh-CN" ? "复制被拒绝，请手动选择上方草稿。" : "Copy was denied; select the draft above manually." }}</p>
    <div class="form-actions">
      <button class="secondary-button" type="button" :disabled="busy" @click="emit('refresh')">{{ locale === "zh-CN" ? "再次刷新事实" : "Refresh facts again" }}</button>
      <button v-if="conflict.draft" class="secondary-button" type="button" @click="copyDraft(conflict.draft)">{{ locale === "zh-CN" ? "复制草稿" : "Copy draft" }}</button>
      <button class="text-button" type="button" @click="emit('dismiss')">{{ locale === "zh-CN" ? "关闭提示" : "Dismiss" }}</button>
    </div>
  </section>
</template>
