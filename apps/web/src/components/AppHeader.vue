<script setup lang="ts">
import { locale, setLocale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import type { WebSessionView } from "../types";

defineProps<{
  context?: string | undefined;
  role?: string | undefined;
  session: WebSessionView;
}>();

const emit = defineEmits<{ logout: [] }>();
</script>

<template>
  <header class="app-header">
    <button class="brand-button" type="button" @click="navigate('/app')">
      <span class="brand-mark" aria-hidden="true">cf</span>
      <span>cfKanban</span>
    </button>
    <div v-if="context" class="header-context">
      <strong>{{ context }}</strong>
      <span v-if="role" class="role-badge">{{ role }}</span>
    </div>
    <nav class="header-actions" :aria-label="locale === 'zh-CN' ? '账户与语言' : 'Account and language'">
      <button v-if="session.principal.is_owner" class="text-button" type="button" @click="navigate('/app/admin')">
        {{ t("admin.overview") }}
      </button>
      <button class="text-button" type="button" @click="navigate('/app/profile')">
        {{ session.principal.display_name }}
      </button>
      <button
        class="locale-switch"
        type="button"
        :aria-label="locale === 'en' ? '切换到简体中文' : 'Switch to English'"
        @click="setLocale(locale === 'en' ? 'zh-CN' : 'en')"
      >
        {{ locale === "en" ? "简中" : "EN" }}
      </button>
      <button class="text-button muted" type="button" @click="emit('logout')">
        {{ t("action.logout") }}
      </button>
    </nav>
  </header>
</template>
