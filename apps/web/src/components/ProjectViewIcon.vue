<script setup lang="ts">
defineProps<{ view: "board" | "list" | "milestones" | "trends" }>();
</script>

<template>
  <svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <template v-if="view === 'board'"><rect x="3" y="3" width="5" height="14" rx="1" /><rect x="12" y="3" width="5" height="8" rx="1" /></template>
    <path v-else-if="view === 'list'" d="M7 4h10M7 10h10M7 16h10M3 4h.01M3 10h.01M3 16h.01" />
    <path v-else-if="view === 'milestones'" d="M4 17V3m0 1h12l-3 4 3 4H4" />
    <path v-else d="M3 3v14h14M6 12l3-4 3 2 4-6" />
  </svg>
</template>

<style scoped>
.ui-action-icon { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
</style>
