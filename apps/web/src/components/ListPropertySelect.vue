<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ value: string; label: string; options: Array<{ value: string; label: string }>; disabled?: boolean }>();
const emit = defineEmits<{ change: [event: Event] }>();
const selectedLabel = computed(() => props.options.find(option => option.value === props.value)?.label ?? props.value);
function change(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (!props.disabled && select.value !== props.value && props.options.some(option => option.value === select.value)) emit("change", event);
  select.value = props.value;
}
</script>

<template>
  <span class="list-property" :class="{ disabled }">
    <span class="list-property-text" aria-hidden="true">{{ selectedLabel }}</span>
    <svg viewBox="0 0 8 8" aria-hidden="true"><path d="m0 2 4 4 4-4z" /></svg>
    <select :value="value" :disabled="disabled" :aria-label="label" @change="change"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
  </span>
</template>

<style scoped>
.list-property { position: relative; display: inline-flex; align-items: center; justify-self: start; gap: 6px; width: fit-content; max-width: 100%; min-height: 32px; padding: 4px 2px; color: var(--color-text-muted); font-size: 12px; }
.list-property-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-property svg { flex: none; width: 8px; height: 8px; fill: currentColor; }
.list-property select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.list-property.disabled { opacity: .55; }
.list-property.disabled select { cursor: default; }
.list-property:focus-within { outline: 2px solid var(--color-primary); outline-offset: 2px; }
@media (max-width: 940px) { .list-property { min-height: 44px; } }
</style>
