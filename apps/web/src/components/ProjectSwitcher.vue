<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { apiRequest } from "../lib/api";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor } from "../lib/pagination";
import { groupProjects } from "../lib/project-navigation";
import { navigate } from "../lib/router";
import { managedWorkspaceIds, managementPath } from "../lib/scoped-management";
import { canAccessOwnerControlPlane } from "../lib/session-capabilities";
import type { ContainerResource, ListResult, WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView; context?: string | undefined; projectId?: string | undefined; workspaceId?: string | undefined }>();
const emit = defineEmits<{ verified: [session: WebSessionView] }>();
const opened = ref(false);
const busy = ref(false);
const search = ref("");
const workspaces = ref<ContainerResource[]>([]);
const verified = ref<WebSessionView | null>(null);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;
const ui = (en: string, zh: string): string => locale.value === "zh-CN" ? zh : en;
const groups = computed(() => groupProjects(verified.value?.allowed_scope.projects ?? [], workspaces.value, search.value));
const allGroups = computed(() => groupProjects((verified.value ?? props.session).allowed_scope.projects ?? [], workspaces.value));
const workspaceLabels = computed(() => containerChoiceLabels(allGroups.value.map(group => ({ id: group.id, name: group.name }))));
const projectLabels = computed(() => new Map(allGroups.value.flatMap(group => [...containerChoiceLabels(group.projects.map(project => ({ id: project.project_id, name: project.project_display_name })))])));
const currentProject = computed(() => props.session.allowed_scope.projects?.find(project => project.project_id === props.projectId && project.workspace_id === props.workspaceId));
const title = computed(() => currentProject.value ? `${workspaceLabels.value.get(currentProject.value.workspace_id)?.label ?? currentProject.value.workspace_display_name} / ${projectLabels.value.get(currentProject.value.project_id)?.label ?? currentProject.value.project_display_name}` : props.context || ui("Choose project", "选择项目"));

async function open(): Promise<void> {
  if (opened.value) { close(); return; }
  opened.value = true;
  search.value = "";
  await refresh();
  await nextTick();
  searchInput.value?.focus();
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
function close(): void { opened.value = false; generation += 1; trigger.value?.focus(); }
function selectProject(workspace: string, project: string): void {
  if (navigate(`/app/w/${workspace}/p/${project}`)) close();
}
function manage(workspace: string): void {
  const from = currentProject.value ? `/app/w/${currentProject.value.workspace_id}/p/${currentProject.value.project_id}` : null;
  if (navigate(`${managementPath(workspace)}${from ? `&from=${encodeURIComponent(from)}` : ""}`)) close();
}
function outside(event: PointerEvent): void { if (opened.value && !root.value?.contains(event.target as Node)) opened.value = false; }
function keyboard(event: KeyboardEvent): void {
  if (event.key === "Escape") { event.preventDefault(); close(); }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target === searchInput.value && event.key !== "ArrowDown") return;
  const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>(".project-switch-panel button:not(:disabled)") ?? [])];
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : (index + 1) % buttons.length;
  buttons[next]?.focus();
}
watch(() => props.session, value => { if (verified.value) verified.value = value; }, { deep: true });
onMounted(() => document.addEventListener("pointerdown", outside));
onUnmounted(() => { generation += 1; document.removeEventListener("pointerdown", outside); });
</script>

<template>
  <div ref="root" class="project-switcher" @keydown="keyboard">
    <button ref="trigger" class="project-switch-trigger" type="button" :aria-expanded="opened" aria-controls="project-switch-panel" @click="open"><strong>{{ title }}</strong><span aria-hidden="true">▾</span></button>
    <section v-if="opened" id="project-switch-panel" class="project-switch-panel" :aria-label="ui('Switch project', '切换项目')">
      <label class="project-switch-search">{{ ui("Workspace or project", "工作区或项目") }}<input ref="searchInput" v-model="search" type="search" :placeholder="ui('Search workspaces or projects…', '搜索工作区或项目…')" /></label>
      <p v-if="busy" role="status">{{ ui("Loading…", "加载中…") }}</p>
      <div v-if="error" role="alert"><p>{{ error }}</p><button class="text-button" type="button" :disabled="busy" @click="refresh">{{ ui("Retry", "重试") }}</button></div>
      <div v-for="group in groups" :key="group.id" class="project-switch-group">
        <div class="project-switch-group-title"><h2 :title="workspaceLabels.get(group.id)?.title">{{ workspaceLabels.get(group.id)?.label ?? group.name }}</h2><button v-if="group.canManage" class="text-button" type="button" @click.stop="manage(group.id)">{{ ui("Manage workspace", "管理工作区") }} →</button></div>
        <button v-for="project in group.projects" :key="project.project_id" class="project-switch-row" type="button" :title="projectLabels.get(project.project_id)?.title" :aria-current="project.project_id === projectId && project.workspace_id === workspaceId ? 'page' : undefined" @click="selectProject(project.workspace_id, project.project_id)"><span aria-hidden="true">{{ project.project_id === projectId && project.workspace_id === workspaceId ? '✓' : '' }}</span><strong>{{ projectLabels.get(project.project_id)?.label ?? project.project_display_name }}</strong><small>{{ project.role === 'reader' ? ui('Reader', '只读者') : project.role === 'owner' ? ui('Owner', '所有者') : ui('Writer', '协作者') }}</small></button>
        <p v-if="!group.projects.length" class="muted-copy">{{ ui("No projects", "暂无项目") }}</p>
      </div>
      <p v-if="!busy && !groups.length">{{ ui("No available projects", "暂无可访问项目") }}</p>
    </section>
  </div>
</template>
