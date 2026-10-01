<script setup lang="ts">
import { locale, setLocale, t } from "../lib/i18n";
</script>

<template>
  <button
    class="locale-switch"
    type="button"
    :aria-label="t('locale.switch')"
    :title="t('locale.switch')"
    @click="setLocale(locale === 'en' ? 'zh-CN' : 'en')"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="m5 8 6 6m-7 0 6-6 2-3M2 5h12M7 2h1m14 20-5-10-5 10m2-4h6" />
    </svg>
  </button>
</template>

<style scoped>
.locale-switch { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; }
</style>
