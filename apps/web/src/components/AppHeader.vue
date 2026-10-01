<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UDropdownMenu from "@nuxt/ui/components/DropdownMenu.vue";
import type { DropdownMenuItem } from "@nuxt/ui";
import { computed } from "vue";

import cfKanbanMarkUrl from "../assets/cfkanban-mark.png";
import ProjectSwitcher from "./ProjectSwitcher.vue";
import LocaleSwitch from "./LocaleSwitch.vue";
import { locale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import { projectDisplayRole, projectRoleLabel } from "../lib/scoped-management";
import { canAccessOwnerControlPlane } from "../lib/session-capabilities";
import type { WebSessionView } from "../types";

const props = defineProps<{
  context?: string | undefined;
  role?: string | undefined;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  session: WebSessionView;
}>();

const emit = defineEmits<{ logout: []; verified: [session: WebSessionView] }>();

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

const accountItems = computed<DropdownMenuItem[][]>(() => [
  [
    { label: locale.value === "zh-CN" ? "工作清单" : "Work list", onSelect: () => navigate("/app/work") },
    ...(canAccessOwnerControlPlane(props.session)
      ? [{ label: locale.value === "zh-CN" ? "管理中心" : "Management center", onSelect: () => navigate("/app/admin") }]
      : []),
    { label: locale.value === "zh-CN" ? "个人设置" : "Personal settings", onSelect: () => navigate("/app/profile") },
  ],
  [{ label: t("action.logout"), color: "error", onSelect: () => emit("logout") }],
]);

</script>

<template>
  <header class="app-header">
    <UButton color="neutral" variant="ghost" class="brand-button" type="button" @click="navigate('/app')">
      <img class="brand-mark" :src="cfKanbanMarkUrl" alt="" aria-hidden="true" />
      <span>cfKanban</span>
    </UButton>
    <div class="header-context">
      <ProjectSwitcher :session="session" :context="context" :project-id="projectId" :workspace-id="workspaceId" @verified="emit('verified', $event)" />
    </div>
    <nav class="header-actions" :aria-label="locale === 'zh-CN' ? '账户与语言' : 'Account and language'">
      <LocaleSwitch />
      <UDropdownMenu :items="accountItems" :content="{ align: 'end' }" :ui="{ content: 'account-menu' }">
        <UButton color="neutral" variant="ghost" class="account-trigger" type="button" :aria-label="locale === 'zh-CN' ? '账户菜单' : 'Account menu'">
          <svg class="account-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3" /><path d="M4 17v-1a6 6 0 0 1 12 0v1" /></svg>
          <span class="account-name">{{ session.principal.display_name }}</span>
          <svg class="account-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
        </UButton>
        <template #content-top>
          <div class="account-facts">
            <strong>{{ session.principal.display_name }}</strong>
            <span v-if="displayedRole">{{ displayedRole }}</span>
          </div>
        </template>
      </UDropdownMenu>
    </nav>
  </header>
</template>
