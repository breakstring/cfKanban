<script setup lang="ts">
import { computed } from "vue";
import { locale } from "../lib/i18n-core";

const props = defineProps<{ progress?: { total: number; done: number } | undefined }>();
const label = computed(() => locale.value === "zh-CN"
  ? `子事项：${props.progress?.done}/${props.progress?.total} 已完成`
  : `Sub-issues: ${props.progress?.done}/${props.progress?.total} completed`);
</script>

<template>
  <span v-if="progress && progress.total > 0" class="issue-children-progress" role="img" :aria-label="label" :title="label">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="progress-track" cx="10" cy="10" r="7" />
      <circle class="progress-value" cx="10" cy="10" r="7" pathLength="100" :stroke-dasharray="`${100 * progress.done / progress.total} 100`" transform="rotate(-90 10 10)" />
    </svg>
    <span>{{ progress.done }}/{{ progress.total }}</span>
  </span>
</template>

<style scoped>
.issue-children-progress { display: inline-flex; flex: none; align-items: center; gap: 4px; color: var(--ui-text-muted); font-size: 12px; font-weight: 400; white-space: nowrap; vertical-align: middle; }
.issue-children-progress svg { width: 17px; height: 17px; fill: none; stroke-width: 2; }
.progress-track { stroke: var(--ui-border-accented); }
.progress-value { stroke: var(--ui-primary); }
</style>
