<script setup lang="ts">
import { computed } from "vue";

import release from "../../../../release/version.json";
import cfKanbanMarkUrl from "../assets/cfkanban-mark.png";
import { locale, t } from "../lib/i18n";

const docsUrl = computed(() => `/docs/${locale.value}/overview/`);
</script>

<template>
  <footer class="app-footer">
    <div class="app-footer-brand">
      <img :src="cfKanbanMarkUrl" alt="" aria-hidden="true" />
      <span>cfKanban</span>
      <span class="app-footer-version" :title="t('footer.productVersion')" :aria-label="`${t('footer.productVersion')}: ${release.version}`">{{ release.version }}</span>
    </div>
    <nav class="app-footer-links" :aria-label="t('footer.navigation')">
      <a :href="docsUrl" target="_blank" rel="noopener noreferrer" :aria-label="`${t('home.documentation')} (${t('footer.newTab')})`" :title="t('footer.newTab')">
        {{ t("home.documentation") }} <span aria-hidden="true">↗</span>
      </a>
      <a href="https://github.com/breakstring/cfKanban" target="_blank" rel="noopener noreferrer" :aria-label="`${t('home.github')} (${t('footer.newTab')})`" :title="t('footer.newTab')">
        {{ t("home.github") }} <span aria-hidden="true">↗</span>
      </a>
    </nav>
  </footer>
</template>
