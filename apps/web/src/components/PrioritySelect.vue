<script setup lang="ts">
import { locale } from "../lib/i18n";
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
