<script setup lang="ts">
import { ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import { locale } from "../lib/i18n-core";

const props = defineProps<{ value: string; label: string; showLabel?: boolean; disabled?: boolean }>();
const copied = ref(false);
const manual = ref(false);
let generation = 0;
watch(() => props.value, () => { generation++; copied.value = false; manual.value = false; });
async function copy() {
  if (props.disabled) return;
  const current = generation;
  try {
    await navigator.clipboard.writeText(props.value);
    if (current === generation) { copied.value = true; manual.value = false; }
  } catch { if (current === generation) manual.value = true; }
}
</script>

<template>
  <span class="copy-control">
    <UButton color="neutral" variant="ghost" size="xs" type="button" :title="label" :aria-label="label" :disabled="disabled || !value" @click.stop="copy">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path v-if="copied" d="m3 8 3 3 7-7" /><template v-else><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M10 3H4a1 1 0 0 0-1 1v6" /></template></svg>
      <span v-if="showLabel">{{ copied ? (locale === 'zh-CN' ? '已复制' : 'Copied') : label }}</span>
    </UButton>
    <span v-if="copied && !showLabel" class="copy-status" role="status">{{ locale === 'zh-CN' ? '已复制' : 'Copied' }}</span>
    <label v-if="manual" class="copy-fallback">{{ locale === 'zh-CN' ? '无法自动复制，请选择下方文本复制。' : 'Copy unavailable. Select the text below to copy.' }}<UTextarea readonly :model-value="value" :rows="Math.min(8, value.split('\n').length + 1)" class="w-full" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
  </span>
</template>

<style scoped>
.copy-control { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.copy-status { color: var(--ui-text-muted); font-size: 11px; }
.copy-fallback { display: grid; width: 100%; gap: 6px; font-size: 12px; font-weight: 400; }
</style>
