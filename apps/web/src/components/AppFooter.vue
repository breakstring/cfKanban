<script setup lang="ts">
import { computed } from "vue";

import release from "../../../../release/version.json";
import cfKanbanMarkUrl from "../assets/cfkanban-mark-orange.svg";
import { locale, t } from "../lib/i18n";

defineProps<{ preferredOrigin?: string | null }>();
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
    <div v-if="preferredOrigin" class="app-footer-session">
      <a :href="preferredOrigin" target="_blank" rel="noreferrer noopener">{{ t('session.preferred') }} · {{ preferredOrigin }} <span aria-hidden="true">↗</span></a>
    </div>
  </footer>
</template>

<style scoped>
.app-footer-session { display: flex; flex: 1 0 100%; flex-wrap: wrap; gap: 4px 24px; align-items: center; justify-content: space-between; padding-bottom: 2px; font-size: 12px; }
.app-footer-session a { color: var(--color-text-muted); overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .app-footer-session a { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 44px; }
}
</style>
