<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
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
import { continuationCursor, cursorRequiresRestart, mergePageById } from "../lib/pagination";
import { ColumnPagination } from "../lib/column-pagination";
import { ProjectionGeneration } from "../lib/projection-generation";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { priorityOrder, prioritySaveIsUncertain, priorityText } from "../lib/priority";
import { navigate } from "../lib/router";
import { hasManagementActions, managementPath } from "../lib/scoped-management";
import { WriteFence } from "../lib/write-fence";
import type {
  ContainerResource,
  IssueSummary,
  IssueTombstone,
  ListResult,
  PriorityKey,
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
const appliedSearch = ref("");
const deletedIssues = ref<IssueTombstone[]>([]);
const deletedIssuesNextCursor = ref<string | null>(null);
const deletedIssuesLoadingMore = ref(false);
const loading = ref(true);
const { clearError, error, setError, setErrorKey, setLocalizedError } = useLocalizedError();
const search = ref("");
const saving = ref(new Set<string>());
const pendingPriorities = ref<Record<string, { issue: IssueSummary; priority: PriorityKey }>>({});
const dragged = ref<IssueSummary | null>(null);
const showNewIssue = ref(false);
const showDeleted = ref(false);
const formBusy = ref(false);
const casConflict = ref<CasConflictState | null>(null);
const newIssue = ref({ body: "", priority_key: "none" as PriorityKey, status_key: "backlog" as StatusKey, title: "" });
const projectionGeneration = new ProjectionGeneration();
const writeFence = new WriteFence();
let loadRequestId = 0;
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
protectNavigationDraft(() => formBusy.value || saving.value.size > 0 || Object.keys(pendingPriorities.value).length > 0 || (showNewIssue.value && (!!newIssue.value.title.trim() || !!newIssue.value.body.trim() || newIssue.value.priority_key !== "none" || newIssue.value.status_key !== "backlog")));
const statusMap = computed(() => new Map(statuses.value.map((status) => [status.key, status])));

function projectIsActive(): boolean {
  const scope = props.session.allowed_scope.projects;
  return scope === undefined || scope.some((item) => (
    item.workspace_id === props.workspaceId && item.project_id === props.projectId
  ));
}

function setCursorRestartError(): void {
  setLocalizedError(
    "The list scope or visibility changed, so the old cursor was retired. Refresh this list before continuing.",
    "列表范围或可见权限已变化，原分页位置已失效。请刷新当前列表后继续。",
  );
}

function projectionIsCurrent(generation: number): boolean {
  return projectionGeneration.isCurrent(generation) && projectIsActive();
}

function clearProjectProjection(): void {
  projectionGeneration.invalidate();
  loadRequestId += 1;
  project.value = null;
  pendingPriorities.value = {};
  statuses.value = [];
  for (const column of Object.values(columns)) column.reset();
  deletedIssues.value = [];
  deletedIssuesNextCursor.value = null;
  loading.value = false;
  showDeleted.value = false;
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
  deletedIssues.value = [];
  deletedIssuesNextCursor.value = null;
  showDeleted.value = false;
  if (!projectIsActive()) {
    clearProjectProjection();
    return;
  }
  void load();
}

function query(status: StatusKey, cursor?: string): string {
  const params = new URLSearchParams({ limit: "20", status });
  if (appliedSearch.value) params.set("q", appliedSearch.value);
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
  if (!projectIsActive()) { clearProjectProjection(); return; }
  projectionGeneration.invalidate();
  const generation = projectionGeneration.capture();
  const requestId = ++loadRequestId;
  appliedSearch.value = search.value.trim();
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

async function loadDeleted(reset = true, throwOnFailure = false): Promise<void> {
  if (!reset && deletedIssuesNextCursor.value === null) return;
  showDeleted.value = true;
  const generation = projectionGeneration.capture();
  deletedIssuesLoadingMore.value = !reset;
  try {
    const params = new URLSearchParams({ deleted: "only", limit: "100" });
    if (!reset && deletedIssuesNextCursor.value !== null) params.set("cursor", deletedIssuesNextCursor.value);
    const result = await apiRequest<ListResult<IssueTombstone>>(
      `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/issues?${params}`,
    );
    if (projectionIsCurrent(generation)) {
      deletedIssues.value = mergePageById(deletedIssues.value, result.items, reset);
      deletedIssuesNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!reset && cursorRequiresRestart(caught)) {
      deletedIssuesNextCursor.value = null;
      setCursorRestartError();
    } else {
      setError(caught);
    }
    if (throwOnFailure) throw caught;
  } finally {
    deletedIssuesLoadingMore.value = false;
  }
}

function restoreUnavailableText(issue: IssueTombstone): string {
  if (issue.parent_status.workspace === "deleted") {
    return locale.value === "zh-CN" ? "请先恢复所属工作区" : "Restore the parent Workspace first";
  }
  if (issue.parent_status.project === "deleted") {
    return locale.value === "zh-CN" ? "请先恢复所属项目" : "Restore the parent Project first";
  }
  if (issue.unavailability_reason !== null) return issue.unavailability_reason.code;
  return locale.value === "zh-CN" ? "当前不可恢复" : "Restore unavailable";
}

async function restoreIssue(issue: IssueTombstone): Promise<void> {
  if (!issue.restorable || !issue.allowed_actions.includes("restore")) return;
  const fenceKey = `issue-restore:${issue.id}`;
  if (!writeFence.enter(fenceKey)) return;
  formBusy.value = true;
  const generation = projectionGeneration.capture();
  try {
    await apiRequest(`/api/v1/issues/${issue.identifier}/commands/restore`, {
      body: { expected_version: issue.version },
      method: "POST",
    });
    if (projectionIsCurrent(generation)) {
      deletedIssues.value = deletedIssues.value.filter((item) => item.id !== issue.id);
      await load();
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, localizedText(`${issue.identifier} restore`, `${issue.identifier} 恢复`), { action: "restore" }, () => loadDeleted(true, true))) {
      setError(caught);
    }
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
  loadRequestId += 1;
  for (const column of Object.values(columns)) column.reset();
});
watch(() => projectInventoryBoundary(props.session.allowed_scope.projects), refreshProjectInventory);
watch(() => props.session.allowed_scope.projects, refreshProjectNames, { deep: true });
</script>

<template>
  <main class="board-page">
    <header class="board-toolbar">
      <div class="board-title">
        <p class="eyebrow">{{ project?.workspace_display_name }}</p>
        <h1>{{ project?.display_name ?? "" }}</h1>
      </div>
      <div class="board-toolbar-actions">
        <button v-if="hasManagementActions(project)" class="text-button" type="button" @click="navigate(`${managementPath(workspaceId, projectId)}&from=${encodeURIComponent(`/app/w/${workspaceId}/p/${projectId}`)}`)">{{ locale === 'zh-CN' ? '项目管理' : 'Manage project' }}</button>
        <button v-if="canWrite" class="text-button" type="button" @click="navigate(`/app/w/${workspaceId}/p/${projectId}/labels`)">{{ locale === "zh-CN" ? "标签管理" : "Manage labels" }}</button>
        <span v-if="!canWrite" class="read-only-badge">{{ t("board.readOnly") }}</span>
        <button v-if="canWrite" class="primary-button button-with-icon" type="button" @click="showNewIssue = true"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>{{ t("action.newIssue") }}</button>
      </div>
      <div class="board-utility-bar">
        <form class="board-search" role="search" @submit.prevent="load()">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
          <input v-model="search" type="search" :disabled="loading || saving.size > 0 || Object.keys(pendingPriorities).length > 0" :placeholder="t('board.search')" :aria-label="locale === 'zh-CN' ? '搜索事项' : 'Search issues'" />
          <button class="text-button board-search-submit" type="submit" :disabled="loading || saving.size > 0 || Object.keys(pendingPriorities).length > 0">{{ locale === 'zh-CN' ? '搜索' : 'Search' }}</button>
        </form>

        <button v-if="canWrite" class="text-button muted" type="button" @click="loadDeleted(true)">{{ locale === "zh-CN" ? "已删除" : "Deleted" }}</button>
      </div>
    </header>

    <ErrorNotice v-if="error" :error="error" />
    <p v-for="pending in pendingPriorities" :key="pending.issue.id" class="warning-panel" role="status">{{ locale === 'zh-CN' ? '优先级保存结果尚未确认，请核实原操作后继续。' : 'Priority save is unconfirmed. Verify the original operation before continuing.' }} <button class="text-button" type="button" :disabled="saving.has(pending.issue.id) || !canWrite" @click="savePriority(pending.issue, pending.priority)">{{ pending.issue.identifier }} · {{ locale === 'zh-CN' ? '核实保存' : 'Verify save' }}</button></p>
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
            <span :title="locale === 'zh-CN' ? '已加载事项数量，非项目总数' : 'Loaded issues, not the project total'">{{ locale === "zh-CN" ? "已加载" : "Loaded" }} {{ issuesFor(statusKey).length }}{{ columns[statusKey].cursor ? "+" : "" }}</span>
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
                <div class="card-meta">
                  <code>{{ issue.identifier }}</code>
                  <PrioritySelect v-if="canWrite" compact :value="issue.priority" :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id]" :label="`${issue.identifier} · ${t('issue.priority')}`" @change="savePriority(issue, $event)" />
                  <span v-else class="priority-mark" :data-priority="issue.priority">{{ priorityLabel(issue.priority) }}</span>
                </div>
              <button class="issue-card-open" type="button" @click="navigate(`/app/issues/${issue.identifier}`)">
                <strong>{{ issue.title }}</strong>
                <span v-if="issue.labels.length" class="label-line">
                  <span v-for="label in issue.labels.slice(0, 3)" :key="label.id" class="label-chip" :title="label.name">{{ label.name }}</span>
                </span>
                <span v-if="issue.needs_reassignment" class="card-exceptions">
                  <span v-if="issue.needs_reassignment" class="warning-chip">{{ locale === "zh-CN" ? "需重新指派" : "reassign" }}</span>
                </span>
              </button>
              <div class="card-footer">
                <span class="card-assignee" :title="issue.assignee?.display_name ?? t('issue.unassigned')">{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span>
              <select
                v-if="canWrite"
                class="card-status-select"
                :value="issue.status.key"
                :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id]"
                :aria-label="`${issue.identifier} · ${locale === 'zh-CN' ? '变更状态' : 'Change status'}`"
                @click.stop
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
        <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<input v-model="newIssue.title" required maxlength="256" /></label>
        <label>{{ t("issue.body") }}<textarea v-model="newIssue.body" rows="7" :placeholder="t('comment.placeholder')" /></label>
        <div class="form-grid">
          <label>{{ t("issue.status") }}<select v-model="newIssue.status_key"><option v-for="key in statusOrder.filter((item) => item !== 'done')" :key="key" :value="key">{{ statusMap.get(key)?.display_name ?? key }}</option></select></label>
          <label>{{ t("issue.priority") }}<select v-model="newIssue.priority_key" :aria-label="t('issue.priority')"><option v-for="key in priorityOrder" :key="key" :value="key">{{ priorityLabel(key) }}</option></select></label>
        </div>
        <div class="form-actions"><button class="secondary-button" type="button" @click="showNewIssue = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="formBusy">{{ t("action.save") }}</button></div>
      </form>
    </ModalDialog>

    <ModalDialog v-if="showDeleted" :busy="formBusy" :title="locale === 'zh-CN' ? '已删除事项' : 'Deleted issues'" @close="showDeleted = false">
      <div class="tombstone-list">
        <div v-for="issue in deletedIssues" :key="issue.id" class="tombstone-row">
          <span><code>{{ issue.identifier }}</code><strong>{{ issue.title }}</strong></span>
          <button v-if="issue.restorable && issue.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreIssue(issue)">{{ t("action.restore") }}</button>
          <small v-else class="warning-chip">{{ restoreUnavailableText(issue) }}</small>
        </div>
        <p v-if="deletedIssues.length === 0" class="empty-copy">{{ locale === "zh-CN" ? "没有可恢复的事项。" : "No recoverable issues." }}</p>
        <button v-if="deletedIssuesNextCursor" class="load-more" type="button" :disabled="deletedIssuesLoadingMore" @click="loadDeleted(false)">{{ deletedIssuesLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多已删除事项" : "Load more deleted issues") }}</button>
      </div>
    </ModalDialog>
  </main>
</template>
