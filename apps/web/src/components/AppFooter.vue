<script setup lang="ts">
import { computed } from "vue";

import release from "../../../../release/version.json";
import cfKanbanMarkUrl from "../assets/cfkanban-mark.png";
import { locale, t } from "../lib/i18n";

const props = defineProps<{ expiresAt?: string; preferredOrigin?: string | null }>();
const docsUrl = computed(() => `/docs/${locale.value}/overview/`);
const expiresLabel = computed(() => {
  if (!props.expiresAt) return "";
  const value = new Date(props.expiresAt);
  return Number.isNaN(value.valueOf()) ? props.expiresAt
    : new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(value);
});
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
    <div v-if="expiresAt || preferredOrigin" class="app-footer-session">
      <span v-if="expiresAt" class="app-footer-expiry">
        {{ locale === 'zh-CN' ? '登录有效至' : 'Signed in until' }} <time :datetime="expiresAt">{{ expiresLabel }}</time>
        <span class="app-footer-session-help">{{ locale === 'zh-CN' ? '到期后请用通行密钥重新登录，或让 Agent 重新打开。' : 'After expiry, sign in with a Passkey or ask your Agent to reopen.' }}</span>
      </span>
      <a v-if="preferredOrigin" :href="preferredOrigin" target="_blank" rel="noreferrer noopener">{{ t('session.preferred') }} · {{ preferredOrigin }} <span aria-hidden="true">↗</span></a>
    </div>
  </footer>
</template>

<style scoped>
.app-footer-session { display: flex; flex: 1 0 100%; flex-wrap: wrap; gap: 4px 24px; align-items: center; justify-content: space-between; padding-bottom: 2px; font-size: 12px; }
.app-footer-expiry { display: flex; flex-wrap: wrap; gap: 0 5px; }
.app-footer-session-help { margin-left: 4px; }
.app-footer-session a { color: var(--color-text-muted); overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .app-footer-session-help { flex-basis: 100%; margin-left: 0; }
  .app-footer-session a { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 44px; }
}
</style>
