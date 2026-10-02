<script setup lang="ts">
import { computed, ref } from "vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { locale } from "../lib/i18n-core";
import { loadedStatusLabel, moveStatusNavigationFocus, scrollToStatusColumn, type KanbanStatusColumn } from "../lib/kanban-status-navigation";

const props = defineProps<{ columns: readonly KanbanStatusColumn[]; region: HTMLElement | null }>();
const navigation = ref<HTMLElement | null>(null);
const label = computed(() => locale.value === "zh-CN" ? "看板状态快捷导航" : "Board status navigation");
</script>

<template>
  <nav v-if="columns.length" ref="navigation" class="kanban-status-navigation" :aria-label="label" @keydown="moveStatusNavigationFocus(navigation, $event)">
    <UButton v-for="column in columns" :key="column.key" type="button" color="neutral" variant="ghost" size="xs" :title="loadedStatusLabel(column, locale === 'zh-CN')" :aria-label="loadedStatusLabel(column, locale === 'zh-CN')" :aria-controls="column.target_id" @click="scrollToStatusColumn(region, column.target_id)">
      <span class="kanban-status-dot" :data-status="column.key" aria-hidden="true" />{{ column.display_name }}<UBadge color="neutral" variant="subtle" size="xs" aria-hidden="true">{{ column.loaded }}{{ column.has_more ? '+' : '' }}</UBadge>
    </UButton>
  </nav>
</template>

<style scoped>
.kanban-status-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; margin-bottom: 10px; }
.kanban-status-navigation :deep(button) { flex: none; min-height: 32px; font-size: 12px; white-space: nowrap; }
.kanban-status-dot { flex: none; width: 8px; height: 8px; border: 2px solid var(--color-border-strong); border-radius: 50%; box-sizing: border-box; }
.kanban-status-dot[data-status="in_progress"] { border-color: var(--color-primary); background: var(--color-primary); }
.kanban-status-dot[data-status="done"] { border-color: var(--color-success); background: var(--color-success); }
@media (pointer: coarse) { .kanban-status-navigation :deep(button) { min-height: 44px; } }
</style>
