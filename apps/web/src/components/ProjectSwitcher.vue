<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import ProjectSwitcherMenu from "./ProjectSwitcherMenu.vue";
import { apiRequest } from "../lib/api";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor } from "../lib/pagination";
import { groupProjects } from "../lib/project-navigation";
import { navigate } from "../lib/router";
import { managedWorkspaceIds, managementPath, projectDisplayRole, projectRoleLabel } from "../lib/scoped-management";
import { canAccessOwnerControlPlane } from "../lib/session-capabilities";
import type { ContainerResource, ListResult, WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView; context?: string | undefined; projectId?: string | undefined; workspaceId?: string | undefined }>();
const emit = defineEmits<{ verified: [session: WebSessionView] }>();
const opened = ref(false);
const busy = ref(false);
const search = ref("");
const workspaces = ref<ContainerResource[]>([]);
const verified = ref<WebSessionView | null>(null);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;
const ui = (en: string, zh: string): string => locale.value === "zh-CN" ? zh : en;
const groups = computed(() => groupProjects(verified.value?.allowed_scope.projects ?? [], workspaces.value, search.value));
const allGroups = computed(() => groupProjects((verified.value ?? props.session).allowed_scope.projects ?? [], workspaces.value));
const workspaceLabels = computed(() => containerChoiceLabels(allGroups.value.map(group => ({ id: group.id, name: group.name }))));
const projectLabels = computed(() => new Map(allGroups.value.flatMap(group => [...containerChoiceLabels(group.projects.map(project => ({ id: project.project_id, name: project.project_display_name })))])));
const currentProject = computed(() => props.session.allowed_scope.projects?.find(project => project.project_id === props.projectId && project.workspace_id === props.workspaceId));
const title = computed(() => currentProject.value ? `${workspaceLabels.value.get(currentProject.value.workspace_id)?.label ?? currentProject.value.workspace_display_name} / ${projectLabels.value.get(currentProject.value.project_id)?.label ?? currentProject.value.project_display_name}` : props.context || ui("Choose project", "选择项目"));
const menuGroups = computed(() => groups.value.map(group => ({
  id: group.id,
  label: workspaceLabels.value.get(group.id)?.label ?? group.name,
  title: workspaceLabels.value.get(group.id)?.title,
  projects: group.projects.map(project => ({
    id: project.project_id,
    label: projectLabels.value.get(project.project_id)?.label ?? project.project_display_name,
    title: projectLabels.value.get(project.project_id)?.title,
    current: project.project_id === props.projectId && project.workspace_id === props.workspaceId,
    description: projectRoleLabel(projectDisplayRole(verified.value ?? props.session, project), locale.value),
  })),
})));

async function open(): Promise<void> {
  if (opened.value) { close(); return; }
  opened.value = true;
  search.value = "";
  await refresh();
}
async function refresh(): Promise<void> {
  const current = ++generation;
  busy.value = true; verified.value = null; workspaces.value = []; clearError();
  try {
    const session = await apiRequest<WebSessionView>("/api/v1/web-session");
    if (current !== generation) return;
    verified.value = session;
    emit("verified", session);
    const managed: ContainerResource[] = [];
    if (canAccessOwnerControlPlane(session)) {
      let cursor: string | null = null;
      do {
        const page: ListResult<ContainerResource> = await apiRequest(`/api/v1/workspaces?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (current !== generation) return;
        managed.push(...page.items);
        cursor = continuationCursor(page);
      } while (cursor);
    } else {
      const results = await Promise.allSettled(managedWorkspaceIds(session).map(id => apiRequest<ContainerResource>(`/api/v1/workspaces/${id}`)));
      if (current !== generation) return;
      for (const result of results) {
        if (result.status === "fulfilled") managed.push(result.value);
        else setError(result.reason);
      }
    }
    workspaces.value = managed;
  } catch (caught) { if (current === generation) setError(caught); }
  finally { if (current === generation) busy.value = false; }
}
function close(): void { opened.value = false; generation += 1; }
function selectProject(projectId: string): void {
  const project = groups.value.flatMap(group => group.projects).find(item => item.project_id === projectId);
  if (project && navigate(`/app/w/${project.workspace_id}/p/${project.project_id}`)) close();
}
function manage(workspace: string): void {
  const from = currentProject.value ? `/app/w/${currentProject.value.workspace_id}/p/${currentProject.value.project_id}` : null;
  if (navigate(`${managementPath(workspace)}&section=settings${from ? `&from=${encodeURIComponent(from)}` : ""}`)) close();
}
watch(() => props.session, value => { if (verified.value) verified.value = value; }, { deep: true });
onUnmounted(() => { generation += 1; });
</script>

<template>
  <ProjectSwitcherMenu :title="title" :opened="opened" :search="search" :groups="menuGroups" :busy="busy" :error="error" @open="open" @close="close" @search="search = $event" @retry="refresh" @select="selectProject">
    <template #group-action="{ group }"><UButton color="neutral" variant="ghost" v-if="groups.find(item => item.id === group.id)?.canManage" class="text-button" type="button" @click.stop="manage(group.id)">{{ ui("Workspace settings", "工作区设置") }} →</UButton></template>
  </ProjectSwitcherMenu>
</template>
