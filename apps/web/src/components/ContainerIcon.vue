<script setup lang="ts">
defineProps<{ kind: "workspace" | "project" }>();
</script>

<template>
  <svg class="container-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <template v-if="kind === 'workspace'">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7h1m4 0h1M9 11h1m4 0h1M10 21v-5h4v5" />
    </template>
    <path v-else d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </svg>
</template>

<style scoped>
.container-icon { width: 19px; height: 19px; flex: 0 0 19px; color: var(--color-text-muted); vertical-align: -3px; }
</style>
