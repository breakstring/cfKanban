<script setup lang="ts">
import { locale } from "../lib/i18n-core";
import { priorityOrder, priorityText } from "../lib/priority";
import type { PriorityKey } from "../types";

const props = defineProps<{ value: PriorityKey; label: string; disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{ change: [priority: PriorityKey] }>();
function change(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const value = select.value as PriorityKey;
  select.value = props.value;
  if (!props.disabled && value !== props.value && priorityOrder.includes(value)) emit("change", value);
}
</script>

<template>
  <select class="priority-control" :class="{ 'card-priority-select': compact }" :data-priority="value" :aria-label="label" :value="value" :disabled="disabled" :draggable="false" @change.stop="change" @pointerdown.stop @mousedown.stop @click.stop @keydown.stop @dragstart.stop.prevent>
    <option v-for="priority in priorityOrder" :key="priority" :value="priority">{{ priorityText(priority, locale === 'zh-CN') }}</option>
  </select>
</template>

<style scoped>
.priority-control { border-radius: 6px; font-size: 13px; }
.card-priority-select { min-height: 32px; padding: 3px 2px; font-size: 12px; }
.priority-control[data-priority="urgent"] { color: var(--color-danger); }
.priority-control[data-priority="high"] { color: var(--color-warning); }
.priority-control[data-priority="none"], .priority-control[data-priority="low"], .priority-control[data-priority="medium"] { color: var(--color-text-muted); }
@media (max-width: 940px) { .card-priority-select { min-height: 44px; } }
</style>
