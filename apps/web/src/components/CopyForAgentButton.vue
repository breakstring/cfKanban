<script setup lang="ts">
import { ref, watch } from "vue";
import { locale, t } from "../lib/i18n";

const props = defineProps<{ text: string }>();
const state = ref<"idle" | "copying" | "copied" | "failed">("idle");
let attempt = 0;
watch(() => props.text, () => {
  attempt += 1;
  state.value = "idle";
});

async function copy(): Promise<void> {
  const currentAttempt = ++attempt;
  state.value = "copying";
  try {
    await navigator.clipboard.writeText(props.text);
    if (currentAttempt === attempt) state.value = "copied";
  } catch {
    if (currentAttempt === attempt) state.value = "failed";
  }
}
</script>

<template>
  <span class="copy-for-agent">
    <button class="secondary-button" type="button" :disabled="state === 'copying'" @click="copy">
      {{ state === 'copying' ? (locale === 'zh-CN' ? '复制中…' : 'Copying…') : state === 'copied' ? (locale === 'zh-CN' ? '✓ 已复制' : '✓ Copied') : t('action.copy') }}
    </button>
    <span class="copy-feedback" :class="{ 'copy-failed': state === 'failed' }" role="status" aria-live="polite">
      {{ state === 'copied' ? (locale === 'zh-CN' ? '已复制到剪贴板，可粘贴给智能体。' : 'Copied to clipboard. Paste it into your Agent.') : state === 'failed' ? (locale === 'zh-CN' ? '复制失败，请重试或手动选择文本复制。' : 'Copy failed. Try again or select and copy the text manually.') : '' }}
    </span>
  </span>
</template>

<style scoped>
.copy-for-agent { display: inline-grid; gap: 6px; max-width: 100%; }
.copy-feedback { color: var(--color-success); font-size: 0.85rem; overflow-wrap: anywhere; }
.copy-feedback:empty { display: none; }
.copy-failed { color: var(--color-danger); }
</style>
