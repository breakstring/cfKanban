<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <section class="issue-content-section">
    <div class="issue-content-heading"><h2>{{ title }}</h2><div v-if="$slots.actions" class="issue-content-actions"><slot name="actions" /></div></div>
    <slot />
  </section>
</template>

<style scoped>
.issue-content-section { min-width: 0; margin-bottom: 24px; padding: 8px 0 32px; border-bottom: 1px solid var(--color-border); font-size: 16px; }
.issue-content-section + .issue-content-section, :global(.content-section) + .issue-content-section { padding-top: 32px; }
.issue-content-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.issue-content-heading h2 { margin: 0 0 6px; font-family: var(--font-ui); font-size: 14px; line-height: 1.5; font-weight: 650; }
.issue-content-actions { display: flex; flex: none; align-items: center; gap: 8px; color: var(--color-text-muted); font-size: 13px; }
.issue-content-section :deep(.markdown) { max-width: min(65ch, 100%); font-size: 16px; }
</style>
