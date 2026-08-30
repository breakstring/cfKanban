<script setup lang="ts">
import { locale, setLocale } from "../lib/i18n";
</script>

<template>
  <button
    class="locale-switch"
    type="button"
    :aria-label="locale === 'en' ? '切换到简体中文' : 'Switch to English'"
    @click="setLocale(locale === 'en' ? 'zh-CN' : 'en')"
  >
    {{ locale === "en" ? "简体中文" : "English" }}
  </button>
</template>
