<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import { locale } from "../lib/i18n";

const props = withDefaults(defineProps<{
  busy?: boolean;
  title: string;
}>(), { busy: false });

const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !props.busy) emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  panel.value?.focus();
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="!busy && emit('close')">
    <section
      ref="panel"
      aria-modal="true"
      class="modal-panel"
      role="dialog"
      tabindex="-1"
      :aria-label="title"
    >
      <header class="modal-header">
        <h2>{{ title }}</h2>
        <button class="icon-button" type="button" :disabled="busy" :aria-label="locale === 'zh-CN' ? '关闭' : 'Close'" @click="emit('close')">×</button>
      </header>
      <slot />
    </section>
  </div>
</template>
