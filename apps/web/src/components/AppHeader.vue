<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import cfKanbanMarkUrl from "../assets/cfkanban-mark.png";
import ProjectSwitcher from "./ProjectSwitcher.vue";
import { apiRequest } from "../lib/api";
import { locale, setLocale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import { projectDisplayRole, projectRoleLabel } from "../lib/scoped-management";
import { canAccessOwnerControlPlane } from "../lib/session-capabilities";
import type { InstanceDiscovery, WebSessionView } from "../types";

const props = defineProps<{
  context?: string | undefined;
  role?: string | undefined;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  session: WebSessionView;
}>();

const emit = defineEmits<{ logout: []; verified: [session: WebSessionView] }>();
const discovery = ref<InstanceDiscovery | null>(null);
const expiresLabel = computed(() => {
  const value = new Date(props.session.expires_at);
  return Number.isNaN(value.valueOf())
    ? props.session.expires_at
    : new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(value);
});
const preferredOrigin = computed(() => {
  const value = discovery.value?.preferred_api_origin;
  return value && value !== window.location.origin ? value : null;
});

function roleLabel(value: string): string {
  if (locale.value !== "zh-CN") return value;
  if (value === "owner") return "所有者";
  if (value === "writer") return "协作者";
  if (value === "reader") return "只读者";
  return value;
}

const displayedRole = computed(() => {
  const project = props.session.allowed_scope.projects?.find(item =>
    item.workspace_id === props.workspaceId && item.project_id === props.projectId);
  return project
    ? projectRoleLabel(projectDisplayRole(props.session, project), locale.value)
    : props.role ? roleLabel(props.role) : null;
});

async function loadDiscovery(): Promise<void> {
  try {
    discovery.value = await apiRequest<InstanceDiscovery>("/.well-known/cfkanban-instance.json");
  } catch {
    // The authenticated surface remains usable when public discovery is temporarily unavailable.
  }
}

onMounted(loadDiscovery);
</script>

<template>
  <header class="app-header">
    <button class="brand-button" type="button" @click="navigate('/app')">
      <img class="brand-mark" :src="cfKanbanMarkUrl" alt="" aria-hidden="true" />
      <span>cfKanban</span>
    </button>
    <div class="header-context">
      <ProjectSwitcher :session="session" :context="context" :project-id="projectId" :workspace-id="workspaceId" @verified="emit('verified', $event)" />
      <span v-if="displayedRole" class="role-badge">{{ displayedRole }}</span>
    </div>
    <nav class="header-actions" :aria-label="locale === 'zh-CN' ? '账户与语言' : 'Account and language'">
      <button v-if="canAccessOwnerControlPlane(session)" class="text-button" type="button" @click="navigate('/app/admin')">
        {{ t("admin.overview") }}
      </button>
      <button class="text-button profile-button" type="button" @click="navigate('/app/profile')">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3" /><path d="M4 17v-1a6 6 0 0 1 12 0v1" /></svg>
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
    <div class="session-facts">
      <span>{{ t("session.expires") }} · <time :datetime="session.expires_at">{{ expiresLabel }}</time></span>
      <a v-if="preferredOrigin" :href="preferredOrigin" target="_blank" rel="noreferrer noopener">
        {{ t("session.preferred") }} · {{ preferredOrigin }}
      </a>
      <button class="text-button muted mobile-sign-out" type="button" @click="emit('logout')">{{ t("action.logout") }}</button>
    </div>
  </header>
</template>
