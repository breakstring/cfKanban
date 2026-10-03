<script setup lang="ts">
import { computed } from "vue";
import UBadge from "@nuxt/ui/components/Badge.vue";

import { locale } from "../lib/i18n-core";

const props = defineProps<{ authorName?: string | undefined; createdAt?: string | undefined; completed?: boolean | undefined }>();
const createdLabel = computed(() => {
  if (!props.createdAt) return "";
  const date = new Date(props.createdAt);
  return Number.isNaN(date.getTime()) ? props.createdAt : new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(date);
});
</script>

<template>
  <div class="issue-comment-header">
    <div v-if="authorName || createdAt || completed" class="issue-comment-meta">
      <strong v-if="authorName" class="issue-comment-author">{{ authorName }}</strong>
      <time v-if="createdAt" :datetime="createdAt">{{ createdLabel }}</time>
      <UBadge v-if="completed" color="success" variant="soft" size="md">{{ locale === 'zh-CN' ? '完成记录' : 'Completion record' }}</UBadge>
    </div>
    <div v-if="$slots.default" class="issue-comment-actions"><slot /></div>
  </div>
</template>

<style scoped>
.issue-comment-header { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px 12px; min-width: 0; margin-bottom: 12px; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.issue-comment-meta { display: flex; flex: 1 1 0; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-width: 0; max-width: 100%; }
.issue-comment-author, .issue-comment-meta time { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.issue-comment-author { color: var(--ui-text); }
.issue-comment-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; max-width: 50%; margin-left: auto; }
</style>
