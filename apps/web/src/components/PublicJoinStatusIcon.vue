<script setup lang="ts">
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { computed } from "vue";
import { locale } from "../lib/i18n";

const props = defineProps<{ enabled: boolean | null | undefined }>();
const label = computed(() => {
  if (props.enabled === true) return locale.value === "zh-CN" ? "公开加入已开启" : "Public Join enabled";
  if (props.enabled === false) return locale.value === "zh-CN" ? "公开加入已关闭" : "Public Join disabled";
  return locale.value === "zh-CN" ? "公开加入状态未知" : "Public Join status unknown";
});
</script>

<template>
  <UTooltip :text="label" :delay-duration="150">
    <span class="public-join-status-icon" :data-enabled="enabled" role="img" :aria-label="label" tabindex="0">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <circle cx="9" cy="7" r="3" />
        <path d="M3 20v-2a6 6 0 0 1 12 0v2" />
        <template v-if="enabled === true"><path d="M19 7v6m-3-3h6" /></template>
        <template v-else-if="enabled === false"><path d="m17 8 4 4m0-4-4 4" /></template>
        <template v-else><path d="M16.5 7.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3M19 14h.01" /></template>
      </svg>
    </span>
  </UTooltip>
</template>

<style scoped>
.public-join-status-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 24px; border-radius: 4px; color: var(--color-text-muted); }
.public-join-status-icon svg { width: 19px; height: 19px; }
.public-join-status-icon[data-enabled="true"] { color: var(--color-success); }
</style>
