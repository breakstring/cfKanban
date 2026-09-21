<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import PageState from "../components/PageState.vue";
import { apiRequest } from "../lib/api";
import { hasManagementActions, managedWorkspaceIds, managementPath, projectDisplayRole, projectRoleLabel } from "../lib/scoped-management";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import type { ContainerResource, ProjectScopeItem, WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView }>();

interface Choice {
  displayName: string;
  projectId: string;
  scope: ProjectScopeItem;
  workspaceId: string;
  workspaceName: string;
}

const choices = ref<Choice[]>([]);
const managedWorkspaces = ref<ContainerResource[]>([]);
let managementGeneration = 0;
async function loadManagement(): Promise<void> {
  const generation = ++managementGeneration;
  managedWorkspaces.value = [];
  const results = await Promise.allSettled(managedWorkspaceIds(props.session).map(id => apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(id)}`)));
  if (generation !== managementGeneration) return;
  managedWorkspaces.value = results.flatMap(result => result.status === "fulfilled" && hasManagementActions(result.value) ? [result.value] : []);
}

const choiceLabels = computed(() => containerChoiceLabels(choices.value.map((choice) => ({ id: choice.projectId, name: choice.displayName, workspaceName: choice.workspaceName }))));
const loading = ref(true);
const error = ref("");

function load(): void {
  loading.value = true;
  error.value = "";
  choices.value = (props.session.allowed_scope.projects ?? []).map((scope) => ({
    displayName: scope.project_display_name,
    projectId: scope.project_id,
    scope,
    workspaceId: scope.workspace_id,
    workspaceName: scope.workspace_display_name,
  }));
  loading.value = false;
}

onMounted(() => { load(); void loadManagement(); });
onUnmounted(() => { managementGeneration += 1; });
watch(() => [props.session.management_grants, props.session.allowed_scope.kind, props.session.allowed_scope.workspace_id], () => { void loadManagement(); }, { deep: true });
watch(() => props.session.allowed_scope.projects, load, { deep: true });
</script>

<template>
  <main class="page-shell narrow-page">
    <header class="page-title-block">
      <p class="eyebrow">{{ locale === "zh-CN" ? "项目范围" : "Project scope" }}</p>
      <h1>{{ t("project.choose") }}</h1>
      <p>{{ t("project.chooseHelp") }}</p>
    </header>
    <PageState :loading="loading" :error="error" :action-label="t('action.refresh')" @retry="load" />
    <section v-if="managedWorkspaces.length" class="selection-list">
      <h2>{{ locale === 'zh-CN' ? '工作区管理' : 'Workspace management' }}</h2>
      <button v-for="workspace in managedWorkspaces" :key="workspace.id" class="selection-row" type="button" @click="navigate(managementPath(workspace.id))"><strong>{{ workspace.display_name }}</strong><span>{{ locale === 'zh-CN' ? '管理工作区和项目' : 'Manage workspace and projects' }}</span></button>
    </section>
    <div v-if="!loading && !error" class="selection-list">
      <button
        v-for="choice in choices"
        :key="`${choice.workspaceId}/${choice.projectId}`"
        class="selection-row"
        :title="choiceLabels.get(choice.projectId)?.title"
        type="button"
        @click="navigate(`/app/w/${encodeURIComponent(choice.workspaceId)}/p/${encodeURIComponent(choice.projectId)}`)"
      >
        <span>
          <small>{{ choice.workspaceName }}</small>
          <strong>{{ choiceLabels.get(choice.projectId)?.label }}</strong>
        </span>
        <span class="selection-row-end"><span class="role-badge">{{ projectRoleLabel(projectDisplayRole(session, choice.scope), locale) }}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></span>
      </button>
      <p v-if="choices.length === 0" class="empty-copy">
        {{ locale === "zh-CN" ? "当前没有可访问的项目，请联系所有者获取项目权限。" : "No projects are currently available. Contact the Owner for project access." }}
      </p>
    </div>
  </main>
</template>
