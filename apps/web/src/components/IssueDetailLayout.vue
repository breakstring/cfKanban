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
.issue-detail-properties { box-sizing: border-box; min-width: 0; padding: 20px; border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg); scroll-margin-top: 16px; }
.issue-detail-properties :deep(.issue-property-list) { display: block; min-width: 0; margin: 0; }
.issue-detail-properties :deep(.issue-property-list > div) { display: block; min-width: 0; padding: 14px 0; border-bottom: 1px solid var(--ui-border); }
.issue-detail-properties :deep(.issue-property-list > div:first-child) { padding-top: 0; }
.issue-detail-properties :deep(.issue-property-list dt) { margin: 0 0 6px; color: var(--ui-text-muted); font-size: 12px; }
.issue-detail-properties :deep(.issue-property-list dd) { min-width: 0; margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.issue-detail-properties :deep(.issue-property-list select) { box-sizing: border-box; width: 100%; min-height: 36px; font-size: 13px; }
.issue-detail-properties :deep(.sidebar-actions button) { width: 100%; justify-content: center; }
.issue-detail-main :deep(.issue-comment-form) { display: grid; gap: 12px; margin-top: 28px; padding: 20px; border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg); }
.issue-detail-main :deep(.issue-comment-form > label) { display: grid; gap: 8px; color: var(--ui-text-muted); font-size: 12px; }
.issue-detail-main :deep(.issue-comment-form > :last-child) { justify-self: start; }
.issue-detail-main :deep(.issue-comment-form .relative) { width: 100%; }
.issue-detail-main :deep(.issue-comment-form textarea) { font-size: 0.9rem; line-height: 1.65; }
@media (max-width: 940px) {
  .issue-detail-layout { grid-template-columns: minmax(0, 1fr) 232px; gap: 20px; }
  .issue-detail-properties :deep(button), .issue-detail-properties :deep(.issue-property-list select) { min-height: 44px; }
  .issue-detail-main :deep(button), .issue-detail-main :deep(input), .issue-detail-main :deep(select) { min-height: 44px; }
}
@media (width < 780px) { .issue-detail-layout { grid-template-columns: minmax(0, 1fr); margin-top: 24px; } }
@media (max-width: 640px) { .issue-detail-properties, .issue-detail-main :deep(.issue-comment-form) { padding: 16px; } }
</style>
