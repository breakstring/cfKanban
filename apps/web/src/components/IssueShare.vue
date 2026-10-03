<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UDropdownMenu from "@nuxt/ui/components/DropdownMenu.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import type { DropdownMenuItem } from "@nuxt/ui";
import { locale } from "../lib/i18n-core";
const props = defineProps<{ identifier: string; origin?: string | undefined; disabled?: boolean }>();
const ui = (english: string, chinese: string) => locale.value === "zh-CN" ? chinese : english;
const link = computed(() => {
  if (!/^CFK-[1-9][0-9]*$/.test(props.identifier) || !props.origin) return "";
  try {
    const url = new URL(props.origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return `${url.origin}/app/issues/${props.identifier}`;
  } catch { return ""; }
});
type CopyKind = "identifier" | "link";
const menuOpen = ref(false);
const copying = ref(false);
const copied = ref<CopyKind | null>(null);
const manual = ref("");
let generation = 0;
function reset() {
  generation++;
  menuOpen.value = false;
  copied.value = null;
  manual.value = "";
}
watch(() => [props.identifier, props.origin, props.disabled], reset, { flush: "sync" });
onBeforeUnmount(() => { generation++; });
async function copy(kind: CopyKind) {
  const value = kind === "link" ? link.value : props.identifier;
  if (props.disabled || copying.value || !value) return;
  const current = ++generation;
  copying.value = true;
  copied.value = null;
  manual.value = "";
  try {
    await navigator.clipboard.writeText(value);
    if (current === generation) copied.value = kind;
  } catch { if (current === generation) manual.value = value; }
  finally { copying.value = false; }
}
const items = computed<DropdownMenuItem[]>(() => [
  { label: ui("Copy ID", "复制编号"), disabled: props.disabled || copying.value || !props.identifier, onSelect: () => copy("identifier") },
  ...(link.value ? [{ label: ui("Copy link", "复制链接"), disabled: props.disabled || copying.value, onSelect: () => copy("link") }] : []),
]);
</script>
<template>
  <span class="issue-share">
    <UDropdownMenu v-model:open="menuOpen" :items="items" :disabled="disabled || copying || !identifier" :portal="true" :content="{ align: 'end', sideOffset: 4, collisionPadding: 8 }" :ui="{ content: 'w-40 max-w-[calc(100vw-16px)]', item: 'min-h-9 max-[940px]:min-h-11' }">
      <UButton color="neutral" variant="ghost" size="xs" type="button" class="issue-share-trigger" :title="ui('Copy issue', '复制事项')" :aria-label="ui('Copy issue', '复制事项')" :aria-busy="copying" :disabled="disabled || copying || !identifier" @click.stop>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path v-if="copied" d="m3 8 3 3 7-7" /><template v-else><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M10 3H4a1 1 0 0 0-1 1v6" /></template></svg>
        <span>{{ copied ? ui('Copied', '已复制') : ui('Copy', '复制') }}</span>
        <svg class="issue-share-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </UButton>
    </UDropdownMenu>
    <span v-if="copied" class="sr-only" role="status">{{ copied === 'link' ? ui('Link copied', '链接已复制') : ui('ID copied', '编号已复制') }}</span>
    <label v-if="manual" class="issue-share-fallback" role="alert">{{ ui('Copy unavailable. Select the text below to copy.', '无法自动复制，请选择下方文本复制。') }}<UTextarea readonly :model-value="manual" :rows="2" class="w-full" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
  </span>
</template>
<style scoped>
.issue-share { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 0; max-width: 100%; }
.issue-share-trigger { min-height: 32px; }
.issue-share-chevron { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.issue-share-fallback { display: grid; width: min(20rem, calc(100vw - 32px)); max-width: 100%; gap: 6px; font-size: 12px; font-weight: 400; }
@media (max-width: 940px) { .issue-share-trigger { min-height: 44px; } }
</style>
