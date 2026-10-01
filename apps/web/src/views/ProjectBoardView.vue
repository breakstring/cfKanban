<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import UAvatar from "@nuxt/ui/components/Avatar.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
import IssueQueryFilters from "../components/IssueQueryFilters.vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import {
  type CasConflictState,
  captureCasConflict,
  markCasReadbackComplete,
  markCasReadbackFailed,
} from "../lib/cas-recovery";
import { projectInventoryBoundary } from "../lib/session-boundary";
import { locale, t } from "../lib/i18n";
import { localizedText, type LocalizedText, useLocalizedError } from "../lib/localized-error";
import { boardFilters, boardPath } from "../lib/board-navigation";
import { ColumnPagination } from "../lib/column-pagination";
import { ProjectionGeneration } from "../lib/projection-generation";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { priorityOrder, prioritySaveIsUncertain, priorityText } from "../lib/priority";
import { navigate } from "../lib/router";
import { hasManagementActions } from "../lib/scoped-management";
import { projectSettingsPath } from "../lib/project-settings";
import { WriteFence } from "../lib/write-fence";
import type {
  ContainerResource,
  IssueSummary,
  ListResult,
  PriorityKey,
  ProjectScopeItem,
  ProjectStatusResource,
  StatusKey,
  WebSessionView,
  WriteResult,
} from "../types";

const props = defineProps<{
  projectId: string;
  session: WebSessionView;
  workspaceId: string;
}>();

const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();
const statusOrder: StatusKey[] = ["backlog", "todo", "in_progress", "done", "canceled"];
const project = ref<ContainerResource | null>(null);
const statuses = ref<ProjectStatusResource[]>([]);
const columns = reactive(Object.fromEntries(statusOrder.map(key => [key, new ColumnPagination<IssueSummary>()])) as Record<StatusKey, ColumnPagination<IssueSummary>>);
const initialFilters = boardFilters(window.location.search);
const appliedSearch = ref(initialFilters.search);
const priorities = ref<PriorityKey[]>(initialFilters.priorities);
const labelIds = ref<string[]>(initialFilters.labels);
const appliedPriorities = ref<PriorityKey[]>([]);
const appliedLabelIds = ref<string[]>([]);
const filtersPending = ref(false);
const loading = ref(true);
const { clearError, error, setError, setErrorKey, setLocalizedError } = useLocalizedError();
const search = ref(initialFilters.search);
const saving = ref(new Set<string>());
const pendingPriorities = ref<Record<string, { issue: IssueSummary; priority: PriorityKey }>>({});
const dragged = ref<IssueSummary | null>(null);
const showNewIssue = ref(false);
const formBusy = ref(false);
const casConflict = ref<CasConflictState | null>(null);
const newIssue = ref({ body: "", priority_key: "none" as PriorityKey, status_key: "backlog" as Exclude<StatusKey, "done">, title: "" });
const projectionGeneration = new ProjectionGeneration();
const writeFence = new WriteFence();
let loadRequestId = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
const returnPath = computed(() => boardPath(props.workspaceId, props.projectId, { search: appliedSearch.value, priorities: priorities.value, labels: labelIds.value }));
function openProjectSettings(): void {
  const section = hasManagementActions(project.value) ? "management" : "activity";
  navigate(projectSettingsPath(props.workspaceId, props.projectId, section, returnPath.value), false, returnPath.value);
}
let casRecoveryGeneration = 0;
let casReadback: (() => Promise<void>) | null = null;
let casReadbackInFlight = false;

const role = computed(() => {
  if (props.session.principal.is_owner) return "owner";
  return props.session.allowed_scope.projects?.find((item) => (
    item.workspace_id === props.workspaceId && item.project_id === props.projectId
  ))?.role ?? "reader";
});
const canWrite = computed(() => projectIsActive() && (role.value === "writer" || role.value === "owner"));
const filterProjects = computed<ProjectScopeItem[]>(() => project.value && projectIsActive() ? [{
  project_id: props.projectId, workspace_id: props.workspaceId, role: role.value,
  project_display_name: project.value.display_name,
  workspace_display_name: project.value.workspace_display_name ?? "",
}] : []);
protectNavigationDraft(() => formBusy.value || saving.value.size > 0 || Object.keys(pendingPriorities.value).length > 0 || (showNewIssue.value && (!!newIssue.value.title.trim() || !!newIssue.value.body.trim() || newIssue.value.priority_key !== "none" || newIssue.value.status_key !== "backlog")));
const statusMap = computed(() => new Map(statuses.value.map((status) => [status.key, status])));

function projectIsActive(): boolean {
  const scope = props.session.allowed_scope.projects;
  return scope === undefined || scope.some((item) => (
    item.workspace_id === props.workspaceId && item.project_id === props.projectId
  ));
}

function projectionIsCurrent(generation: number): boolean {
  return projectionGeneration.isCurrent(generation) && projectIsActive();
}

function clearProjectProjection(): void {
  clearTimeout(filterTimer);
  projectionGeneration.invalidate();
  loadRequestId += 1;
  project.value = null;
  pendingPriorities.value = {};
  statuses.value = [];
  for (const column of Object.values(columns)) column.reset();
  loading.value = false;
  showNewIssue.value = false;
  setLocalizedError(
    "This Project is no longer in the current active Project inventory.",
    "此项目已不在当前可用项目列表中。",
  );
}

function refreshProjectNames(): void {
  const scope = props.session.allowed_scope.projects?.find((item) => item.project_id === props.projectId && item.workspace_id === props.workspaceId);
  if (scope === undefined || project.value === null) return;
  project.value = { ...project.value, display_name: scope.project_display_name, workspace_display_name: scope.workspace_display_name };
  emit("context", { label: `${scope.workspace_display_name} / ${scope.project_display_name}`, role: role.value });
}

function refreshProjectInventory(): void {
  projectionGeneration.invalidate();
  loadRequestId += 1;
  if (!projectIsActive()) {
    clearProjectProjection();
    return;
  }
  void load();
}

function query(status: StatusKey, cursor?: string): string {
  const params = new URLSearchParams({ limit: "20", status });
  if (appliedSearch.value) params.set("q", appliedSearch.value);
  for (const priority of appliedPriorities.value) params.append("priority", priority);
  for (const label of appliedLabelIds.value) params.append("label", label);
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/issues?${params}`;
}

async function loadColumn(status: StatusKey, reset = false, throwOnFailure = false): Promise<void> {
  if (!projectIsActive()) return;
  const generation = projectionGeneration.capture();
  const column = columns[status];
  if (reset) {
    const element = document.getElementById(`board-column-${status}`);
    if (element) element.scrollTop = 0;
  }
  await column.load(cursor => apiRequest<ListResult<IssueSummary>>(query(status, cursor)), reset);
  if (!projectionIsCurrent(generation)) return;
  if (column.error instanceof ApiProblem && [403, 404].includes(column.error.status)) {
    clearProjectProjection();
    return;
  }
  if (throwOnFailure && column.error) throw column.error;
}

function onColumnScroll(status: StatusKey, event: Event): void {
  const target = event.target as HTMLElement;
  const column = columns[status];
  if (!column.error && column.cursor && target.scrollTop > 0 && target.scrollHeight - target.clientHeight - target.scrollTop < 200) void loadColumn(status);
}

async function load(_reset = true, throwOnFailure = false): Promise<void> {
  clearTimeout(filterTimer);
  if (!projectIsActive()) { clearProjectProjection(); return; }
  projectionGeneration.invalidate();
  const generation = projectionGeneration.capture();
  const requestId = ++loadRequestId;
  appliedSearch.value = search.value.trim();
  appliedPriorities.value = [...priorities.value];
  appliedLabelIds.value = [...labelIds.value];
  filtersPending.value = false;
  for (const column of Object.values(columns)) column.reset();
  loading.value = true;
  clearError();
  try {
    const [projectResult, statusResult] = await Promise.all([
      apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`),
      apiRequest<ListResult<ProjectStatusResource>>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/statuses`),
      ...statusOrder.map(status => loadColumn(status, false, throwOnFailure)),
    ]);
    if (requestId !== loadRequestId || !projectionIsCurrent(generation)) return;
    project.value = projectResult;
    statuses.value = statusResult.items;
    emit("context", { label: `${projectResult.workspace_display_name} / ${projectResult.display_name}`, role: role.value });
  } catch (caught) {
    if (requestId !== loadRequestId || !projectionIsCurrent(generation)) return;
    setError(caught);
    if (caught instanceof ApiProblem && (caught.status === 403 || caught.status === 404)) clearProjectProjection();
    if (throwOnFailure) throw caught;
  } finally { if (requestId === loadRequestId) loading.value = false; }
}

async function recoverCasConflict(
  caught: unknown,
  resource: string | LocalizedText,
  draft: unknown,
  readback: () => Promise<void> = () => load(true, true),
): Promise<boolean> {
  const conflict = captureCasConflict(caught, resource, draft);
  if (conflict === null) return false;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  casReadback = readback;
  casConflict.value = conflict;
  setErrorKey("error.conflict");
  try {
    await readback();
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(conflict);
  } catch {
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(conflict);
  }
  return true;
}

function dismissCasConflict(): void {
  casRecoveryGeneration += 1;
  casConflict.value = null;
  casReadback = null;
}

async function refreshCasFacts(): Promise<void> {
  const conflict = casConflict.value;
  const readback = casReadback;
  if (conflict === null || readback === null || casReadbackInFlight) return;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  const pending = { ...conflict, readbackState: "pending" as const };
  casConflict.value = pending;
  casReadbackInFlight = true;
  try {
    await readback();
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(pending);
  } catch {
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(pending);
  } finally {
    casReadbackInFlight = false;
  }
}

async function saveStatus(issue: IssueSummary, status: StatusKey): Promise<void> {
  const fenceKey = `issue-status:${issue.id}`;
  if (!canWrite.value || pendingPriorities.value[issue.id] || issue.status.key === status || saving.value.has(issue.id) || !writeFence.enter(fenceKey)) return;
  saving.value = new Set(saving.value).add(issue.id);
  clearError();
  const generation = projectionGeneration.capture();
  try {
    const result = await apiRequest<WriteResult<IssueSummary>>(`/api/v1/issues/${issue.identifier}${status === "done" ? "/commands/complete" : ""}`, {
      body: status === "done" ? { expected_version: issue.version } : { expected_version: issue.version, status_key: status },
      method: status === "done" ? "POST" : "PATCH",
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      await Promise.all([...new Set([issue.status.key, result.resource.status.key])].map(key => loadColumn(key, true)));
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, localizedText(`${issue.identifier} status`, `${issue.identifier} 状态`), { status_key: status }, async () => {
      await load(true, true);
    })) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    const current = new Set(saving.value);
    current.delete(issue.id);
    saving.value = current;
  }
}

function onStatusSelection(issue: IssueSummary, event: Event): void {
  const select = event.target as HTMLSelectElement;
  const status = select.value as StatusKey;
  if (status === "done") select.value = issue.status.key;
  void saveStatus(issue, status);
}

async function savePriority(issue: IssueSummary, priority: PriorityKey): Promise<void> {
  const fenceKey = `issue-priority:${issue.id}`;
  const pending = pendingPriorities.value[issue.id];
  if (pending && (pending.issue.version !== issue.version || pending.priority !== priority)) return;
  if (!canWrite.value || issue.priority === priority || saving.value.has(issue.id) || !writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  saving.value = new Set(saving.value).add(issue.id);
  clearError();
  try {
    const result = await apiRequest<WriteResult<IssueSummary>>(`/api/v1/issues/${issue.identifier}`, {
      method: "PATCH", body: { expected_version: issue.version, priority_key: priority },
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      delete pendingPriorities.value[issue.id];
      await loadColumn(result.resource.status.key, true);
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (prioritySaveIsUncertain(caught)) pendingPriorities.value[issue.id] = { issue, priority };
    else delete pendingPriorities.value[issue.id];
    if (!await recoverCasConflict(caught, issue.identifier, { priority_key: priority })) setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    const current = new Set(saving.value); current.delete(issue.id); saving.value = current;
  }
}

async function createIssue(): Promise<void> {
  if (!newIssue.value.title.trim()) return;
  const fenceKey = "issue-create";
  if (!writeFence.enter(fenceKey)) return;
  formBusy.value = true;
  const generation = projectionGeneration.capture();
  try {
    const result = await apiRequest<WriteResult<IssueSummary>>(
      `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/issues`,
      {
        body: {
          body: newIssue.value.body,
          priority_key: newIssue.value.priority_key,
          status_key: newIssue.value.status_key,
          title: newIssue.value.title.trim(),
        },
        method: "POST",
      },
    );
    if (projectionIsCurrent(generation)) {
      await loadColumn(result.resource.status.key, true);
      newIssue.value = { body: "", priority_key: "none", status_key: "backlog", title: "" };
      showNewIssue.value = false;
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    formBusy.value = false;
  }
}

function issuesFor(status: StatusKey): IssueSummary[] {
  return columns[status].items;
}

function priorityLabel(priority: PriorityKey): string {
  return priorityText(priority, locale.value === "zh-CN");
}

function onDragStart(issue: IssueSummary, event: DragEvent): void {
  if ((event.target as HTMLElement)?.closest("select, option, .priority-control")) { event.preventDefault(); return; }
  dragged.value = issue;
  event.dataTransfer?.setData("text/plain", issue.identifier);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDrop(status: StatusKey): void {
  const issue = dragged.value;
  dragged.value = null;
  if (issue !== null) void saveStatus(issue, status);
}

onMounted(() => load());
onUnmounted(() => {
  projectionGeneration.invalidate();
  clearTimeout(filterTimer);
  loadRequestId += 1;
  for (const column of Object.values(columns)) column.reset();
});
watch(() => projectInventoryBoundary(props.session.allowed_scope.projects), refreshProjectInventory);
watch(() => props.session.allowed_scope.projects, refreshProjectNames, { deep: true });
watch(() => JSON.stringify([priorities.value, labelIds.value]), () => {
  clearTimeout(filterTimer);
  projectionGeneration.invalidate();
  loadRequestId += 1;
  for (const column of Object.values(columns)) column.reset();
  dragged.value = null;
  loading.value = false;
  filtersPending.value = false;
  // 清空失去访问权限的项目会触发标签重置，不能因此重新请求或擦掉权限错误。
  if (project.value === null || !projectIsActive()) return;
  clearError();
  filtersPending.value = true;
  filterTimer = setTimeout(async () => {
    appliedPriorities.value = [...priorities.value];
    appliedLabelIds.value = [...labelIds.value];
    filtersPending.value = false;
    await Promise.all(statusOrder.map(status => loadColumn(status)));
  }, 180);
}, { flush: "sync" });
</script>

<template>
  <main class="board-page board-page--nuxt">
    <header class="board-toolbar">
      <div class="board-title">
        <p class="eyebrow">{{ project?.workspace_display_name }}</p>
        <h1>{{ project?.display_name ?? "" }}</h1>
        <div v-if="project?.context" class="board-description" tabindex="0" :aria-label="locale === 'zh-CN' ? '项目描述' : 'Project description'"><MarkdownContent :source="project.context" /></div>
      </div>
      <div class="board-toolbar-actions">
        <UButton v-if="project" color="neutral" variant="outline" type="button" @click="openProjectSettings">{{ locale === 'zh-CN' ? '项目设置' : 'Project settings' }}</UButton>
        <UBadge v-if="!canWrite" color="neutral" variant="soft">{{ t("board.readOnly") }}</UBadge>
        <UButton v-if="canWrite" color="primary" type="button" @click="showNewIssue = true"><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>{{ t("action.newIssue") }}</UButton>
      </div>
      <div class="board-view-bar">
        <span class="board-view-label"><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="5" height="14" rx="1" /><rect x="12" y="3" width="5" height="8" rx="1" /></svg>{{ locale === 'zh-CN' ? '看板' : 'Board' }}</span>

      </div>
      <div class="board-utility-bar">
        <form class="board-search" role="search" @submit.prevent="load()">
          <UInput v-model="search" class="board-search-field" type="search" :disabled="loading || saving.size > 0 || Object.keys(pendingPriorities).length > 0" :placeholder="t('board.search')" :aria-label="locale === 'zh-CN' ? '搜索事项' : 'Search issues'">
            <template #leading><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg></template>
          </UInput>
          <UButton color="neutral" variant="outline" type="submit" :disabled="loading || saving.size > 0 || Object.keys(pendingPriorities).length > 0">{{ locale === 'zh-CN' ? '搜索' : 'Search' }}</UButton>
        </form>
        <IssueQueryFilters compact v-model:priorities="priorities" v-model:labels="labelIds" :projects="filterProjects" :disabled="loading || saving.size > 0 || Object.keys(pendingPriorities).length > 0" />
      </div>
    </header>
    <p v-if="filtersPending" class="muted-copy" role="status">{{ locale === 'zh-CN' ? '正在更新筛选结果…' : 'Updating filtered results…' }}</p>
    <ErrorNotice v-if="error" :error="error" />
    <p v-for="pending in pendingPriorities" :key="pending.issue.id" class="warning-panel" role="status">{{ locale === 'zh-CN' ? '优先级保存结果尚未确认，请核实原操作后继续。' : 'Priority save is unconfirmed. Verify the original operation before continuing.' }} <UButton color="neutral" variant="ghost" type="button" :disabled="saving.has(pending.issue.id) || !canWrite" @click="savePriority(pending.issue, pending.priority)">{{ pending.issue.identifier }} · {{ locale === 'zh-CN' ? '核实保存' : 'Verify save' }}</UButton></p>
    <CasConflictNotice v-if="casConflict" :busy="formBusy || casReadbackInFlight" :conflict="casConflict" @dismiss="dismissCasConflict" @refresh="refreshCasFacts" />
    <PageState :loading="loading" :error="loading ? '' : ''" />

    <p v-if="!loading" id="board-scroll-hint" class="board-scroll-hint">
      {{ locale === "zh-CN"
        ? "左右滑动查看全部 5 列；不方便拖拽时，可用卡片下方的状态菜单。"
        : "Swipe sideways to see all 5 columns. Use the status menu on each card when dragging is awkward." }}
    </p>
    <div
      v-if="!loading"
      class="kanban-scroll"
      role="region"
      tabindex="0"
      aria-describedby="board-scroll-hint"
      :aria-label="locale === 'zh-CN' ? '项目看板横向浏览区' : 'Project Kanban horizontal navigation'"
    >
      <section class="kanban-board" :aria-label="locale === 'zh-CN' ? '项目看板' : 'Project Kanban board'">
        <article
          v-for="statusKey in statusOrder"
          :key="statusKey"
          class="kanban-column"
          :data-status="statusKey"
          @dragover.prevent
          @drop="onDrop(statusKey)"
        >
          <header class="column-header">
            <h2>{{ statusMap.get(statusKey)?.display_name ?? statusKey }}</h2>
            <UBadge color="neutral" variant="soft" size="md" :title="locale === 'zh-CN' ? '已加载事项数量，非项目总数' : 'Loaded issues, not the project total'" :aria-label="`${locale === 'zh-CN' ? '已加载' : 'Loaded'} ${issuesFor(statusKey).length}${columns[statusKey].cursor ? '+' : ''}`">{{ locale === 'zh-CN' ? '已加载' : 'Loaded' }} {{ issuesFor(statusKey).length }}{{ columns[statusKey].cursor ? "+" : "" }}</UBadge>
          </header>
          <div :id="`board-column-${statusKey}`" class="column-content" tabindex="0" :aria-label="`${statusMap.get(statusKey)?.display_name ?? statusKey} · ${locale === 'zh-CN' ? '事项列表' : 'Issues'}`" @scroll="onColumnScroll(statusKey, $event)">
            <article
              v-for="issue in issuesFor(statusKey)"
              :key="issue.id"
              class="issue-card"
              :class="{ saving: saving.has(issue.id) }"
              :draggable="canWrite && !saving.has(issue.id) && !pendingPriorities[issue.id]"
              :aria-busy="saving.has(issue.id)"
              @dragstart="onDragStart(issue, $event)"
            >
              <div class="card-topline">
                <code>{{ issue.identifier }}</code>
                <PrioritySelect v-if="canWrite" compact :value="issue.priority" :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id]" :label="`${issue.identifier} · ${t('issue.priority')}`" @change="savePriority(issue, $event)" />
                <span v-else class="priority-mark" :data-priority="issue.priority">{{ priorityLabel(issue.priority) }}</span>
              </div>
              <button class="issue-card-open" type="button" @click="navigate(`/app/issues/${issue.identifier}`)">
                <span class="card-heading">
                  <strong :title="issue.title">{{ issue.title }}</strong>
                </span>
                <span v-if="issue.labels.length || issue.needs_reassignment" class="card-summary">
                  <span v-if="issue.labels.length" class="label-line" :title="issue.labels.map(label => label.name).join(' · ')">
                    <UBadge v-for="label in issue.labels.slice(0, 3)" :key="label.id" class="label-chip" color="neutral" variant="soft" size="md" :title="label.name">{{ label.name }}</UBadge>
                    <span v-if="issue.labels.length > 3" class="card-label-count" :aria-label="`${locale === 'zh-CN' ? '更多标签' : 'More labels'}: ${issue.labels.slice(3).map(label => label.name).join(' · ')}`">+{{ issue.labels.length - 3 }}</span>
                  </span>
                  <span v-if="issue.needs_reassignment" class="warning-chip">{{ locale === "zh-CN" ? "需重新指派" : "reassign" }}</span>
                </span>
              </button>
              <div class="card-meta">
                <span class="card-assignee" :title="issue.assignee?.display_name ?? t('issue.unassigned')"><UAvatar :alt="issue.assignee?.display_name ?? '—'" size="2xs" /><span>{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span></span>
              <select
                v-if="canWrite"
                class="card-status-select"
                :value="issue.status.key"
                :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id]"
                :aria-label="`${issue.identifier} · ${locale === 'zh-CN' ? '变更状态' : 'Change status'}`"
                :draggable="false"
                @pointerdown.stop
                @mousedown.stop
                @click.stop
                @keydown.stop
                @dragstart.stop.prevent
                @change.stop="onStatusSelection(issue, $event)"
              >
                <option v-for="option in statusOrder" :key="option" :value="option">
                  {{ statusMap.get(option)?.display_name ?? option }}
                </option>
              </select>
              </div>
            </article>
            <p v-if="columns[statusKey].loading" role="status" class="column-empty">{{ locale === "zh-CN" ? "加载中…" : "Loading…" }}</p>
            <div v-else-if="columns[statusKey].error" class="column-page-error" role="alert"><p>{{ errorText(columns[statusKey].error) }}</p><button class="text-button" type="button" @click="loadColumn(statusKey)">{{ locale === "zh-CN" ? "重试" : "Retry" }}</button></div>
            <button v-else-if="columns[statusKey].cursor" class="load-more" type="button" @click="loadColumn(statusKey)">{{ locale === "zh-CN" ? "加载更多" : "Load more" }}</button>
            <p v-else-if="columns[statusKey].loaded" class="column-empty">{{ issuesFor(statusKey).length === 0 ? t("board.empty") : (locale === "zh-CN" ? "已加载完毕" : "All issues loaded") }}</p>
          </div>
        </article>
      </section>
    </div>



    <ModalDialog v-if="showNewIssue" :busy="formBusy" :title="t('action.newIssue')" @close="showNewIssue = false">
      <form class="form-stack" @submit.prevent="createIssue">
        <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<UInput v-model="newIssue.title" required maxlength="256" autofocus /></label>
        <label>{{ t("issue.body") }}<UTextarea v-model="newIssue.body" :rows="7" :placeholder="t('comment.placeholder')" /></label>
        <div class="form-grid">
          <label>{{ t("issue.status") }}<USelect v-model="newIssue.status_key" :items="statusOrder.filter(key => key !== 'done').map(key => ({ value: key, label: statusMap.get(key)?.display_name ?? key }))" /></label>
          <label>{{ t("issue.priority") }}<USelect v-model="newIssue.priority_key" :items="priorityOrder.map(key => ({ value: key, label: priorityLabel(key) }))" :aria-label="t('issue.priority')" /></label>
        </div>
        <div class="form-actions"><UButton color="neutral" variant="outline" type="button" :disabled="formBusy" @click="showNewIssue = false">{{ t("action.cancel") }}</UButton><UButton color="primary" type="submit" :loading="formBusy">{{ t("action.save") }}</UButton></div>
      </form>
    </ModalDialog>

  </main>
</template>

<style scoped>
.board-page--nuxt { padding: 28px 28px 18px; }
.board-toolbar { gap: 20px 24px; margin-bottom: 20px; }
.board-title { min-width: 0; }
.board-title h1 { font-family: var(--font-ui); font-size: 24px; font-weight: 650; line-height: 1.35; letter-spacing: -.02em; }
.board-title .eyebrow { margin-bottom: 6px; font-size: 12px; color: var(--color-text-muted); }
.board-description { margin-top: 8px; max-height: 100px; max-width: 72ch; overflow: auto; overflow-wrap: anywhere; font-size: 14px; color: var(--color-text-muted); }
.board-description :deep(.markdown > :first-child) { margin-top: 0; }
.board-description :deep(.markdown > :last-child) { margin-bottom: 0; }
.ui-action-icon { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.board-view-bar { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 1px solid var(--color-border); padding-top: 6px; }
.board-view-label { display: inline-flex; align-items: center; gap: 8px; align-self: stretch; padding: 10px 0; border-bottom: 2px solid var(--color-primary); color: var(--color-primary); font-size: 14px; font-weight: 600; }
.board-utility-bar { justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.board-search { flex: 0 1 380px; gap: 8px; }
.board-search-field { flex: 1; min-width: 0; }
.board-search :deep(input) { min-height: 36px; padding-right: 12px; padding-left: 36px; font-size: 14px; }
.kanban-board { grid-template-columns: repeat(5, minmax(248px, 1fr)); min-width: 1304px; border-top: 0; gap: 16px; }
.kanban-column { border-radius: 12px; padding: 8px; background: var(--color-surface-muted); }
.column-header { min-height: 44px; justify-content: flex-start; gap: 8px; padding: 0 8px 6px; }
.column-header h2 { font-size: 13px; font-weight: 600; }
.column-header > :last-child { background: transparent; padding-inline: 2px; }
.column-content { gap: 8px; scrollbar-gutter: auto; padding: 2px 0 0; }
.issue-card { gap: 10px; border-color: transparent; padding: 12px 14px; border-radius: var(--radius-card); box-shadow: 0 1px 2px color-mix(in srgb, var(--color-text) 4%, transparent); }
.issue-card:hover { border-color: var(--color-border); box-shadow: 0 2px 6px color-mix(in srgb, var(--color-text) 7%, transparent); }
.card-topline { display: flex; min-width: 0; justify-content: space-between; align-items: center; gap: 8px; }
.card-topline > code { color: var(--color-text-muted); font-size: 12px; letter-spacing: .025em; }
.card-topline :deep(.card-priority-select) { max-width: 106px; flex-basis: auto; text-align: right; }
.card-topline .priority-mark { min-height: 24px; padding: 0; background: transparent; font-size: 12px; }
.issue-card-open { gap: 10px; min-height: 0; }
.card-heading { display: block; }
.card-heading > strong { font-size: 14px; line-height: 1.6; font-weight: 550; }
.card-summary { min-height: 20px; }
.card-summary .label-line .label-chip { max-width: 45%; min-height: 20px; padding: 1px 5px; color: var(--color-text-muted); background: var(--color-surface-muted); border-radius: 4px; font-size: 12px; font-weight: 400; }
.card-meta { flex-wrap: nowrap; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--color-border); }
.card-assignee { display: flex; align-items: center; gap: 6px; flex: 1 1 0; text-align: left; }
.card-assignee > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-status-select { flex: 0 1 auto; max-width: 54%; padding: 4px 2px; min-height: 32px; font-size: 12px; text-align: right; }
.column-empty { padding: 16px 8px; border-top: 0; color: var(--color-text-muted); font-size: 12px; }
.form-stack :deep(.relative), .form-grid :deep(.relative) { width: 100%; }
@media (max-width: 940px) {
  .board-page--nuxt { padding: 20px 16px 12px; }
  .board-toolbar-actions :deep(button), .board-search :deep(input), .board-search :deep(button), .card-status-select, .issue-card-open { min-height: 44px; }
}
@media (max-width: 640px) {
  .board-toolbar { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .board-toolbar-actions { justify-content: flex-start; flex-wrap: wrap; }
  .board-title h1 { font-size: 22px; }
  .board-view-bar { padding-top: 0; }
  .board-search { flex-basis: 100%; }
  .board-description { max-height: 96px; }
  .kanban-board { grid-template-columns: repeat(5, minmax(260px, 1fr)); min-width: 1364px; }
  .card-status-select { min-height: 44px; }
}
</style>
