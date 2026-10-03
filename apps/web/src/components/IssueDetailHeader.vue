<script setup lang="ts">
defineProps<{ identifier: string; title: string }>();
</script>

<template>
  <header class="issue-detail-header">
    <p class="issue-detail-identifier">{{ identifier }}</p>
    <h1 class="issue-detail-title">{{ title }}</h1>
    <div class="issue-detail-meta"><slot /></div>
    <div class="issue-detail-actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.issue-detail-header { display: grid; grid-template-columns: minmax(0, 1fr) fit-content(45%); align-items: start; column-gap: 24px; box-sizing: border-box; width: 100%; min-width: 0; padding: 24px 0; border-bottom: 1px solid var(--ui-border); }
.issue-detail-identifier { grid-column: 1; grid-row: 1; min-width: 0; margin: 0 0 8px; color: var(--ui-text-muted); font-family: var(--font-mono); font-size: 13px; overflow-wrap: anywhere; }
.issue-detail-title { grid-column: 1; grid-row: 2; min-width: 0; margin: 0; font-family: var(--font-ui); font-size: clamp(24px, 2.5vw, 32px); line-height: 1.4; font-weight: 650; overflow-wrap: anywhere; }
.issue-detail-meta { grid-column: 1; grid-row: 3; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; min-width: 0; margin-top: 14px; color: var(--ui-text-muted); font-size: 13px; }
.issue-detail-actions { grid-column: 2; grid-row: 1 / span 3; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: 8px; min-width: 0; max-width: 100%; }
.issue-detail-actions > :deep(*) { min-width: 0; max-width: 100%; }
.issue-detail-actions :deep(textarea) { box-sizing: border-box; width: 100%; max-width: 100%; }
@media (max-width: 940px) { .issue-detail-actions :deep(button), .issue-detail-meta :deep(button) { min-height: 44px; } }
@media (width < 780px) {
  .issue-detail-header { grid-template-columns: minmax(0, max-content) minmax(0, 1fr); column-gap: 8px; }
  .issue-detail-identifier { align-self: center; margin-bottom: 0; }
  .issue-detail-actions { grid-row: 1; gap: 6px; }
  .issue-detail-title { grid-column: 1 / -1; margin-top: 8px; }
  .issue-detail-meta { grid-column: 1 / -1; }
}
@media (max-width: 640px) { .issue-detail-header { padding-top: 20px; } }
</style>
