<script setup lang="ts">
import UModal from "@nuxt/ui/components/Modal.vue";

import { locale } from "../lib/i18n";

withDefaults(defineProps<{
  busy?: boolean;
  title: string;
}>(), { busy: false });

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <UModal
    :open="true"
    :title="title"
    :dismissible="!busy"
    :close="{ disabled: busy, 'aria-label': locale === 'zh-CN' ? '关闭' : 'Close' }"
    :ui="{ content: 'cfk-modal-content', header: 'cfk-modal-header', body: 'cfk-modal-body' }"
    @update:open="!$event && !busy && emit('close')"
  >
    <template #body>
      <slot />
    </template>
  </UModal>
</template>

<style>
.cfk-modal-content { width: min(680px, calc(100vw - 32px)); max-width: none; border-radius: 12px; }
.cfk-modal-header { padding: 20px 24px; }
.cfk-modal-body { padding: 20px 24px 24px; }
.cfk-modal-content .form-stack > label, .cfk-modal-content .form-grid > label { display: grid; gap: 8px; }
.cfk-modal-content .form-stack label > .relative, .cfk-modal-content .form-grid label > .relative { width: 100%; }
.cfk-modal-content .form-actions { margin-top: 8px; }
@media (max-width: 640px) {
  .cfk-modal-header, .cfk-modal-body { padding: 20px; }
  .cfk-modal-content button, .cfk-modal-content input, .cfk-modal-content select { min-height: 44px; }
}
</style>
