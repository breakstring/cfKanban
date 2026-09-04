<script setup lang="ts">
import ErrorNotice from "./ErrorNotice.vue";
import { locale } from "../lib/i18n";

withDefaults(defineProps<{
  actionLabel?: string;
  error?: string;
  loading?: boolean;
}>(), { actionLabel: "Try again", error: "", loading: false });

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="loading" class="page-state" aria-live="polite">
    <span class="spinner" aria-hidden="true" />
    <span>{{ locale === "zh-CN" ? "加载中…" : "Loading…" }}</span>
  </div>
  <div v-else-if="error" class="page-state error-state">
    <ErrorNotice :error="error" />
    <button class="secondary-button" type="button" @click="emit('retry')">{{ actionLabel }}</button>
  </div>
</template>
