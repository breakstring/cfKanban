<script setup lang="ts">
import { computed } from "vue";

import { locale } from "../lib/i18n";

const props = defineProps<{ error: string }>();

interface ErrorEntry {
  diagnostics: string | null;
  message: string;
}

const entries = computed<ErrorEntry[]>(() => props.error
  .split("\n\n")
  .map((block) => block.trim())
  .filter(Boolean)
  .map((block) => {
    const separator = block.indexOf("\n");
    if (separator < 0) return { diagnostics: null, message: block };
    return {
      diagnostics: block.slice(separator + 1).replace(/^(?:Diagnostic facts|诊断信息):\s*/, ""),
      message: block.slice(0, separator),
    };
  }));
</script>

<template>
  <div class="inline-alert error-notice" role="alert">
    <div v-for="(entry, index) in entries" :key="index" class="error-entry">
      <p>{{ entry.message }}</p>
      <details v-if="entry.diagnostics" class="error-diagnostics">
        <summary>{{ locale === "zh-CN" ? "查看诊断信息" : "View diagnostic facts" }}</summary>
        <p>{{ entry.diagnostics }}</p>
      </details>
    </div>
  </div>
</template>
