<script setup lang="ts">
defineProps<{ propertiesId: string; propertiesLabel: string }>();
</script>

<template>
  <section class="issue-detail-layout">
    <div class="issue-detail-main"><slot /></div>
    <aside :id="propertiesId" class="issue-detail-properties" tabindex="-1" :aria-label="propertiesLabel"><slot name="properties" /></aside>
  </section>
</template>

<style scoped>
.issue-detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) 270px; align-items: start; gap: 32px; min-width: 0; margin-top: 28px; }
.issue-detail-main { min-width: 0; }
.issue-detail-properties { box-sizing: border-box; min-width: 0; padding-left: 24px; border-left: 1px solid var(--ui-border); scroll-margin-top: 16px; }
.issue-detail-properties :deep(.issue-property-list) { display: block; min-width: 0; margin: 0; }
.issue-detail-properties :deep(.issue-property-list > div) { display: block; min-width: 0; padding-bottom: 20px; }
.issue-detail-properties :deep(.issue-property-list dt) { margin: 0 0 6px; color: var(--ui-text-muted); font-size: 12px; }
.issue-detail-properties :deep(.issue-property-list dd) { min-width: 0; margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.issue-detail-properties :deep(.issue-property-list select) { box-sizing: border-box; width: auto; max-width: 100%; min-height: 32px; padding: 4px 22px 4px 3px; border: 0; border-radius: 6px; appearance: none; field-sizing: content; background-color: transparent; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23596b83' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E"); background-position: right 3px center; background-repeat: no-repeat; background-size: 12px; font-size: 12px; }
.issue-detail-properties :deep(.issue-property-list select:hover:not(:disabled)) { background-color: var(--ui-bg-muted); }
.issue-detail-properties :deep(.issue-property-list select:focus-visible) { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.issue-detail-properties :deep(.sidebar-actions button) { width: 100%; justify-content: center; }
.issue-detail-properties :deep(.sidebar-actions) { padding: 8px 0 0; border: 0; }
.issue-detail-properties :deep(.section-heading-row.compact) { flex-direction: row; align-items: center; gap: 8px; }
.issue-detail-properties :deep(.section-heading-row.compact h2) { margin: 0; }
.issue-detail-properties :deep(.label-chip) { color: var(--ui-text-muted); background: var(--ui-bg-muted); border-radius: 5px; }
.issue-detail-properties :deep(.label-chip button) { min-width: 28px; min-height: 28px; padding: 0 4px; }
.issue-detail-main :deep(.issue-comment-form) { display: grid; gap: 12px; margin-top: 24px; }
.issue-detail-main :deep(.editor-panel) { padding: 0; border: 0; border-radius: 0; background: transparent; }
.issue-detail-main :deep(.issue-comment-form > label) { display: grid; gap: 8px; color: var(--ui-text-muted); font-size: 12px; }
.issue-detail-main :deep(.issue-comment-form > :last-child) { justify-self: start; }
.issue-detail-main :deep(.issue-comment-form .relative) { width: 100%; }
.issue-detail-main :deep(.issue-comment-form textarea) { font-size: 0.9rem; line-height: 1.65; }
@media (max-width: 940px) {
  .issue-detail-layout { grid-template-columns: minmax(0, 1fr) 232px; gap: 20px; }
  .issue-detail-properties :deep(button), .issue-detail-properties :deep(.issue-property-list select) { min-height: 44px; }
  .issue-detail-main :deep(button), .issue-detail-main :deep(input), .issue-detail-main :deep(select) { min-height: 44px; }
}
@media (width < 780px) {
  .issue-detail-layout { grid-template-columns: minmax(0, 1fr); margin-top: 24px; }
  .issue-detail-properties { padding-left: 0; border-left: 0; }
  .issue-detail-properties :deep(.label-chip button) { min-width: 44px; min-height: 44px; }
}
</style>
