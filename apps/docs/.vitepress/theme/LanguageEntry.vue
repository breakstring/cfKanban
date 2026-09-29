<script setup lang="ts">
import { onMounted } from "vue";
import { withBase } from "vitepress";
import { readStoredLocale, resolveLocalePreference } from "../../../web/src/lib/locale-preference";

onMounted(() => {
  const locale = resolveLocalePreference(readStoredLocale(() => window.localStorage, "cfkanban_locale"), navigator.languages);
  window.location.replace(withBase(`/${locale}/overview/`));
});
</script>

<template>
  <p class="docs-language-entry">
    <a :href="withBase('/en/overview/')">English documentation</a>
    <a :href="withBase('/zh-CN/overview/')">简体中文文档</a>
  </p>
</template>
