<script setup lang="ts">
import { computed } from "vue";
import CopyButton from "./CopyButton.vue";
import { locale } from "../lib/i18n-core";
const props = defineProps<{ identifier: string; origin?: string | undefined; disabled?: boolean }>();
const link = computed(() => {
  if (!/^CFK-[1-9][0-9]*$/.test(props.identifier) || !props.origin) return "";
  try {
    const url = new URL(props.origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return `${url.origin}/app/issues/${props.identifier}`;
  } catch { return ""; }
});
</script>
<template>
  <span class="issue-share">
    <CopyButton :value="identifier" :label="locale === 'zh-CN' ? '复制编号' : 'Copy ID'" :disabled="disabled" show-label />
    <CopyButton v-if="link" :value="link" :label="locale === 'zh-CN' ? '复制链接' : 'Copy link'" :disabled="disabled" show-label />
  </span>
</template>
<style scoped>
.issue-share { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
</style>
