<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import UAvatar from "@nuxt/ui/components/Avatar.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import AssigneeMenu from "../components/AssigneeMenu.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import IssueChildrenProgress from "../components/IssueChildrenProgress.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
import IssueQueryFilters from "../components/IssueQueryFilters.vue";
import KanbanStatusNavigation from "../components/KanbanStatusNavigation.vue";
import { ApiProblem, apiRequest, errorText, hasUncertainWrite } from "../lib/api";
import {
  type CasConflictState,
  captureCasConflict,
  markCasReadbackComplete,
  markCasReadbackFailed,
} from "../lib/cas-recovery";
import { projectInventoryBoundary, sessionCanWriteProject } from "../lib/session-boundary";
import { locale, t } from "../lib/i18n";
import { statusDisplayName } from "../lib/status-display";
import { lazyPage } from "../lib/lazy-page";
import { localizedText, type LocalizedText, useLocalizedError } from "../lib/localized-error";
import { boardFilters, boardPath } from "../lib/board-navigation";
import { matchesBoardFilters, refreshBoardIssueProgress, sortBoardIssues } from "../lib/board-projection";
import { ColumnPagination } from "../lib/column-pagination";
import { ProjectionGeneration } from "../lib/projection-generation";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { changedTextFields, useSessionTextDraft, verifySessionTextDraftIdentity } from "../lib/session-drafts";
import { priorityOrder, prioritySaveIsUncertain, priorityText } from "../lib/priority";
import { navigate } from "../lib/router";
import { continuationCursor, cursorRequiresRestart } from "../lib/pagination";
import { hasManagementActions } from "../lib/scoped-management";
import { projectSettingsPath } from "../lib/project-settings";
import { WriteFence } from "../lib/write-fence";
import type {
  ContainerResource,
  IssueSummary,
  IssueCounts,
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
const columns = reactive(Object.fromEntries(statusOrder.map(key => [key, new ColumnPagination<IssueSummary>(true)])) as Record<StatusKey, ColumnPagination<IssueSummary>>);
const counts = ref<IssueCounts | null>(null);
const countsLoading = ref(false);
const countsError = ref<unknown>(null);
let countsRequestId = 0;
const initialFilters = boardFilters(window.location.search);
const ProjectIssueList = lazyPage(() => import("../components/ProjectIssueList.vue"));
const viewMode = ref<"board" | "list">(initialFilters.view ?? "board");
const selectedStatus = ref<StatusKey | undefined>(initialFilters.status);
const expandedGroups = ref(new Set<StatusKey>(initialFilters.status ? [initialFilters.status] : initialFilters.expanded ?? ["backlog"]));
const eligibleStatuses = computed(() => selectedStatus.value ? [selectedStatus.value] : statusOrder);
const requestedStatuses = () => viewMode.value === "board" ? eligibleStatuses.value : eligibleStatuses.value.filter(key => expandedGroups.value.has(key));
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
const pendingStatuses = ref<Record<string, { issue: IssueSummary; status: StatusKey }>>({});
const pendingAssignees = ref<Record<string, { issue: IssueSummary; principalId: string | null }>>({});
const assignees = ref<Array<{ principal_id: string; display_name: string }>>([]);
const assigneesCursor = ref<string | null>(null);
const assigneesLoaded = ref(false);
const assigneesLoading = ref(false);
const assigneesError = ref<unknown>(null);
let assigneesGeneration = 0;
const confirmedVersions = new Map<string, number>();
const dragged = ref<IssueSummary | null>(null);
const showNewIssue = ref(false);
const formBusy = ref(false);
const casConflict = ref<CasConflictState | null>(null);
const newIssue = ref({ body: "", priority_key: "none" as PriorityKey, status_key: "backlog" as Exclude<StatusKey, "done">, title: "" });
const projectionGeneration = new ProjectionGeneration();
const writeFence = new WriteFence();
let loadRequestId = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
const returnPath = computed(() => boardPath(props.workspaceId, props.projectId, { search: appliedSearch.value, priorities: priorities.value, labels: labelIds.value, ...(selectedStatus.value ? { status: selectedStatus.value } : {}), expanded: [...expandedGroups.value], ...(viewMode.value === "list" ? { view: "list" as const } : {}) }));
function setView(mode: "board" | "list"): void {
  if (viewMode.value === mode) return;
  viewMode.value = mode;
  if (mode === "board") for (const key of eligibleStatuses.value) if (!columns[key].loaded && !columns[key].loading && !columns[key].error) void loadColumn(key);
  // 布局切换只改当前 URL，避免以完整路由为 key 的页面重新挂载、重取分页。
  window.history.replaceState(window.history.state, "", returnPath.value);
}
function changeStatusFilter(value: string): void {
  selectedStatus.value = statusOrder.includes(value as StatusKey) ? value as StatusKey : undefined;
  if (selectedStatus.value) expandedGroups.value = new Set([selectedStatus.value]);
}
function toggleListGroup(key: StatusKey): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key); else {
    next.add(key);
    if (!columns[key].loaded && !columns[key].loading && !columns[key].error) void loadColumn(key);
  }
  expandedGroups.value = next;
  window.history.replaceState(window.history.state, "", returnPath.value);
}
function openListIssue(identifier: string): void {
  navigate(`/app/issues/${identifier}?from=${encodeURIComponent(returnPath.value)}`, false, returnPath.value);
}
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
const hasPendingWrites = computed(() => Object.keys(pendingPriorities.value).length > 0 || Object.keys(pendingStatuses.value).length > 0 || Object.keys(pendingAssignees.value).length > 0);
protectNavigationDraft(() => formBusy.value || saving.value.size > 0 || hasPendingWrites.value || casConflict.value !== null || (showNewIssue.value && (!!newIssue.value.title.trim() || !!newIssue.value.body.trim() || newIssue.value.priority_key !== "none" || newIssue.value.status_key !== "backlog")));
useSessionTextDraft({
  key: `new-issue:${props.workspaceId}:${props.projectId}`, path: `/app/w/${props.workspaceId}/p/${props.projectId}`,
  label: { en: "New Issue", zh: "新事项" }, target: () => ({ workspaceId: props.workspaceId, projectId: props.projectId }),
  capture: () => showNewIssue.value ? changedTextFields({ title: [newIssue.value.title, ""], body: [newIssue.value.body, ""] }) : null,
  canRestore: () => project.value !== null && !loading.value && canWrite.value && !formBusy.value,
  restore: async (fields, _target, isCurrent) => {
    const latest = await apiRequest<ContainerResource>(`/api/v1/workspaces/${props.workspaceId}/projects/${props.projectId}`, { authorizationCurrent: isCurrent });
    if (!isCurrent() || latest.id !== props.projectId || latest.deleted_at !== null) return false;
    const verified = await verifySessionTextDraftIdentity(isCurrent);
    if (!isCurrent() || !verified || !sessionCanWriteProject(verified, props.workspaceId, props.projectId) || formBusy.value) return false;
    project.value = latest; newIssue.value = { ...newIssue.value, ...fields }; showNewIssue.value = true;
  },
  uncertain: () => formBusy.value || hasUncertainWrite(`/api/v1/workspaces/${props.workspaceId}/projects/${props.projectId}/issues`),
});
const statusMap = computed(() => new Map(statuses.value.map((status) => [status.key, status])));
const boardRegion = ref<HTMLElement | null>(null);
const statusFilterItems = computed(() => [{ value: "all", label: locale.value === "zh-CN" ? "全部状态" : "All statuses" }, ...statusOrder.map(key => ({ value: key, label: statusDisplayName(statusMap.value.get(key) ?? { key }, locale.value) }))]);
const statusNavigation = computed(() => eligibleStatuses.value.map(key => ({ key, display_name: statusDisplayName(statusMap.value.get(key) ?? { key }, locale.value), loaded: columns[key].items.length, has_more: Boolean(columns[key].cursor), target_id: `board-status-${key}` })));

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
  pendingStatuses.value = {};
  pendingAssignees.value = {};
  resetAssignees();
  confirmedVersions.clear();
  dismissCasConflict();
  resetCounts();
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
  resetAssignees();
  projectionGeneration.invalidate();
  loadRequestId += 1;
  if (!projectIsActive()) {
    clearProjectProjection();
    return;
  }
  void load();
}

function resetAssignees(): void {
  assigneesGeneration += 1;
  assignees.value = [];
  assigneesCursor.value = null;
  assigneesLoaded.value = false;
  assigneesLoading.value = false;
  assigneesError.value = null;
}

async function loadAssignees(reset = true): Promise<void> {
  if (!canWrite.value || assigneesLoading.value || (!reset && assigneesCursor.value === null)) return;
  const request = ++assigneesGeneration;
  const isCurrent = () => request === assigneesGeneration && canWrite.value;
  assigneesLoading.value = true;
  assigneesError.value = null;
  if (reset) {
    assignees.value = [];
    assigneesCursor.value = null;
    assigneesLoaded.value = false;
  }
  const params = new URLSearchParams({ limit: "50" });
  if (!reset && assigneesCursor.value) params.set("cursor", assigneesCursor.value);
  try {
    const result = await apiRequest<ListResult<{ principal_id: string; display_name: string }>>(
      `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/assignees?${params}`,
      { authorizationCurrent: isCurrent },
    );
    if (!isCurrent()) return;
    const cursor = continuationCursor(result);
    assignees.value = [...new Map([...assignees.value, ...result.items].map(item => [item.principal_id, item])).values()];
    assigneesCursor.value = cursor;
    assigneesLoaded.value = true;
  } catch (caught) {
    if (!isCurrent()) return;
    if (cursorRequiresRestart(caught)) {
      assignees.value = [];
      assigneesCursor.value = null;
      assigneesLoaded.value = false;
    }
    assigneesError.value = caught;
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) clearProjectProjection();
  } finally {
    if (request === assigneesGeneration) assigneesLoading.value = false;
  }
}

function ensureAssigneesLoaded(): void {
  if (!assigneesLoaded.value && !assigneesError.value) void loadAssignees();
}

function onAssigneeSelection(issue: IssueSummary, principalId: string | null): void {
  if (principalId !== null && !assignees.value.some(candidate => candidate.principal_id === principalId)) return;
  void saveAssignee(issue, principalId);
}

function filterParams(): URLSearchParams {
  const params = new URLSearchParams();
  if (appliedSearch.value) params.set("q", appliedSearch.value);
  for (const priority of appliedPriorities.value) params.append("priority", priority);
  for (const label of appliedLabelIds.value) params.append("label", label);
  return params;
}

function query(status: StatusKey, cursor?: string): string {
  const params = filterParams();
  params.set("limit", "20");
  params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/issues?${params}`;
}

function resetCounts(): void {
  countsRequestId += 1;
  counts.value = null;
  countsLoading.value = false;
  countsError.value = null;
}

async function loadCounts(): Promise<void> {
  if (!projectIsActive()) return;
  const generation = projectionGeneration.capture();
  const requestId = ++countsRequestId;
  countsLoading.value = true;
  countsError.value = null;
  try {
    const result = await apiRequest<IssueCounts>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/issues/counts?${filterParams()}`);
    if (requestId !== countsRequestId || !projectionIsCurrent(generation)) return;
    counts.value = result;
  } catch (caught) {
    if (requestId !== countsRequestId || !projectionIsCurrent(generation)) return;
    counts.value = null;
    countsError.value = caught;
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) {
      try {
        await apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`);
      } catch (projectError) {
        if (requestId === countsRequestId && projectionIsCurrent(generation) && projectError instanceof ApiProblem && [403, 404].includes(projectError.status)) clearProjectProjection();
      }
    }
  } finally {
    if (requestId === countsRequestId) countsLoading.value = false;
  }
}

function countLabel(status: StatusKey): string {
  const name = statusDisplayName(statusMap.value.get(status) ?? { key: status }, locale.value);
  if (countsLoading.value) return `${name} · ${locale.value === "zh-CN" ? "正在读取总数" : "Loading total"}`;
  if (countsError.value || !counts.value) return `${name} · ${locale.value === "zh-CN" ? "总数不可用" : "Total unavailable"}`;
  return `${name} · ${locale.value === "zh-CN" ? "匹配事项总数" : "Matching issues total"}: ${counts.value.counts[status]}`;
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
  resetCounts();
  void loadCounts();
  for (const column of Object.values(columns)) column.reset();
  confirmedVersions.clear();
  loading.value = true;
  clearError();
  try {
    const [projectResult, statusResult] = await Promise.all([
      apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`),
      apiRequest<ListResult<ProjectStatusResource>>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/statuses`),
      ...requestedStatuses().map(status => loadColumn(status, false, throwOnFailure)),
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
  readback: () => Promise<void>,
): Promise<boolean> {
  const projection = projectionGeneration.capture();
  const conflict = captureCasConflict(caught, resource, draft);
  if (conflict === null) return false;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  casReadback = readback;
  casConflict.value = conflict;
  setErrorKey("error.conflict");
  try {
    await readback();
    if (projectionIsCurrent(projection) && casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(conflict);
  } catch {
    if (projectionIsCurrent(projection) && casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(conflict);
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
  const projection = projectionGeneration.capture();
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  const pending = { ...conflict, readbackState: "pending" as const };
  casConflict.value = pending;
  casReadbackInFlight = true;
  try {
    await readback();
    if (projectionIsCurrent(projection) && casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(pending);
  } catch {
    if (projectionIsCurrent(projection) && casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(pending);
  } finally {
    casReadbackInFlight = false;
  }
}

async function saveStatus(issue: IssueSummary, status: StatusKey): Promise<void> {
  const fenceKey = `issue-status:${issue.id}`;
  const pending = pendingStatuses.value[issue.id];
  if (pending && (pending.issue.version !== issue.version || pending.status !== status)) return;
  if (!canWrite.value || pendingPriorities.value[issue.id] || pendingAssignees.value[issue.id] || issue.status.key === status || saving.value.has(issue.id) || !writeFence.enter(fenceKey)) return;
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
      delete pendingStatuses.value[issue.id];
      await reconcileIssue(result.resource);
      if (projectionIsCurrent(generation)) void loadCounts();
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (prioritySaveIsUncertain(caught)) {
      pendingStatuses.value[issue.id] = { issue, status };
      await readbackIssue(issue.identifier).catch(() => {});
    } else delete pendingStatuses.value[issue.id];
    if (!projectionIsCurrent(generation)) return;
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) await readbackIssue(issue.identifier).catch(() => {});
    if (!projectionIsCurrent(generation)) return;
    const recovered = await recoverCasConflict(caught, localizedText(`${issue.identifier} status`, `${issue.identifier} 状态`), { status_key: status }, async () => {
      await readbackIssue(issue.identifier);
    });
    if (!projectionIsCurrent(generation)) return;
    if (!recovered) {
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
  select.value = issue.status.key;
  void saveStatus(issue, status);
}

async function savePriority(issue: IssueSummary, priority: PriorityKey): Promise<void> {
  const fenceKey = `issue-priority:${issue.id}`;
  const pending = pendingPriorities.value[issue.id];
  if (pending && (pending.issue.version !== issue.version || pending.priority !== priority)) return;
  if (!canWrite.value || pendingStatuses.value[issue.id] || pendingAssignees.value[issue.id] || issue.priority === priority || saving.value.has(issue.id) || !writeFence.enter(fenceKey)) return;
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
      await reconcileIssue(result.resource);
      if (projectionIsCurrent(generation)) void loadCounts();
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (prioritySaveIsUncertain(caught)) {
      pendingPriorities.value[issue.id] = { issue, priority };
      await readbackIssue(issue.identifier).catch(() => {});
    }
    else delete pendingPriorities.value[issue.id];
    if (!projectionIsCurrent(generation)) return;
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) await readbackIssue(issue.identifier).catch(() => {});
    if (!projectionIsCurrent(generation)) return;
    const recovered = await recoverCasConflict(caught, issue.identifier, { priority_key: priority }, () => readbackIssue(issue.identifier));
    if (projectionIsCurrent(generation) && !recovered) setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    const current = new Set(saving.value); current.delete(issue.id); saving.value = current;
  }
}

async function saveAssignee(issue: IssueSummary, principalId: string | null): Promise<void> {
  const fenceKey = `issue-assignee:${issue.id}`;
  const pending = pendingAssignees.value[issue.id];
  if (pending && (pending.issue.version !== issue.version || pending.principalId !== principalId)) return;
  if (!canWrite.value || pendingPriorities.value[issue.id] || pendingStatuses.value[issue.id]
    || (issue.assignee?.principal_id ?? null) === principalId || saving.value.has(issue.id) || !writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  saving.value = new Set(saving.value).add(issue.id);
  clearError();
  try {
    const result = await apiRequest<WriteResult<IssueSummary>>(`/api/v1/issues/${issue.identifier}`, {
      method: "PATCH", body: { expected_version: issue.version, assignee_principal_id: principalId },
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      delete pendingAssignees.value[issue.id];
      await reconcileIssue(result.resource);
      if (projectionIsCurrent(generation)) void loadCounts();
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (prioritySaveIsUncertain(caught)) {
      pendingAssignees.value[issue.id] = { issue, principalId };
      await readbackIssue(issue.identifier).catch(() => {});
    } else delete pendingAssignees.value[issue.id];
    if (!projectionIsCurrent(generation)) return;
    if (caught instanceof ApiProblem && caught.body.code === "ASSIGNEE_NOT_ELIGIBLE") resetAssignees();
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) await readbackIssue(issue.identifier).catch(() => {});
    if (!projectionIsCurrent(generation)) return;
    const recovered = await recoverCasConflict(caught, localizedText(`${issue.identifier} assignee`, `${issue.identifier} 负责人`),
      { assignee_principal_id: principalId }, () => readbackIssue(issue.identifier));
    if (projectionIsCurrent(generation) && !recovered) setError(caught);
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
      await reconcileIssue(result.resource);
      if (!projectionIsCurrent(generation)) return;
      void loadCounts();
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
  return sortBoardIssues([...columns[status].items]);
}

const hierarchyRequests = new Map<string, number>();
function knownIssueVersion(id: string): number {
  return Math.max(confirmedVersions.get(id) ?? 0,
    ...statusOrder.flatMap(key => columns[key].items.filter(item => item.id === id).map(item => item.version)));
}

async function refreshParentProgress(child: IssueSummary, generation: number): Promise<void> {
  const parents = child.hierarchy?.parents.filter(parent => parent.project_id === props.projectId
    && statusOrder.some(key => columns[key].items.some(item => item.identifier === parent.identifier))) ?? [];
  await Promise.all(parents.map(async parent => {
    const request = (hierarchyRequests.get(parent.identifier) ?? 0) + 1;
    hierarchyRequests.set(parent.identifier, request);
    const isCurrent = () => hierarchyRequests.get(parent.identifier) === request && projectionIsCurrent(generation);
    try {
      const refreshed = await refreshBoardIssueProgress({
        read: () => apiRequest<IssueSummary>(`/api/v1/issues/${parent.identifier}`, { authorizationCurrent: isCurrent }),
        knownVersion: () => knownIssueVersion(parent.id),
        isCurrent,
        apply: issue => reconcileIssue(issue, false),
      });
      if (refreshed || !isCurrent()) return;
    } catch {
      if (!isCurrent()) return;
    }
    for (const column of Object.values(columns)) {
      if (!column.items.some(item => item.identifier === parent.identifier)) continue;
      column.reconcile(items => items.map(item => {
        if (item.identifier !== parent.identifier) return item;
        const { hierarchy, ...remaining } = item;
        return remaining;
      }));
    }
  }));
}

async function reconcileIssue(issue: IssueSummary, refreshAncestors = true): Promise<void> {
  const generation = projectionGeneration.capture();
  if (issue.version < knownIssueVersion(issue.id)) return;
  const previous = statusOrder.flatMap(key => columns[key].items).find(item => item.id === issue.id);
  if (issue.hierarchy === undefined && previous?.hierarchy) issue = { ...issue, hierarchy: previous.hierarchy };
  const statusChanged = previous && previous.status.key !== issue.status.key;
  confirmedVersions.set(issue.id, issue.version);
  const matches = (!selectedStatus.value || selectedStatus.value === issue.status.key) && matchesBoardFilters(issue, { search: appliedSearch.value, priorities: appliedPriorities.value, labels: appliedLabelIds.value });
  const positions: Array<{ element: HTMLElement; top: number }> = [];
  const initialColumns: StatusKey[] = [];
  for (const key of statusOrder) {
    const column = columns[key];
    const include = matches && issue.status.key === key;
    if (!include && !column.items.some(item => item.id === issue.id)) continue;
    const element = document.getElementById(`board-column-${key}`);
    if (element) positions.push({ element, top: element.scrollTop });
    if (!column.loaded && column.error === null && requestedStatuses().includes(key)) initialColumns.push(key);
    column.reconcile(items => sortBoardIssues([...items.filter(item => item.id !== issue.id), ...(include ? [issue] : [])]));
  }
  await nextTick();
  if (!projectionIsCurrent(generation)) return;
  for (const { element, top } of positions) if (element.isConnected) element.scrollTop = top;
  // 目标列首屏若尚未读完，失效旧读取后补一页，保留刚确认的卡片。
  for (const key of initialColumns) void loadColumn(key);
  if (statusChanged && refreshAncestors) await refreshParentProgress(issue, generation);
}

async function readbackIssue(identifier: string): Promise<void> {
  const generation = projectionGeneration.capture();
  try {
    const issue = await apiRequest<IssueSummary>(`/api/v1/issues/${identifier}`);
    if (!projectionIsCurrent(generation)) return;
    await reconcileIssue(issue);
    if (projectionIsCurrent(generation)) void loadCounts();
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (caught instanceof ApiProblem && caught.status === 403) clearProjectProjection();
    if (caught instanceof ApiProblem && caught.status === 404) {
      try {
        await apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`);
      } catch (projectError) {
        if (projectionIsCurrent(generation) && projectError instanceof ApiProblem && [403, 404].includes(projectError.status)) clearProjectProjection();
        throw projectError;
      }
      if (!projectionIsCurrent(generation)) return;
      for (const column of Object.values(columns)) {
        if (column.items.some(item => item.identifier === identifier)) column.reconcile(items => items.filter(item => item.identifier !== identifier));
      }
      void loadCounts();
      return;
    }
    throw caught;
  }
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
  resetAssignees();
  resetCounts();
  clearTimeout(filterTimer);
  loadRequestId += 1;
  for (const column of Object.values(columns)) column.reset();
});
watch(() => projectInventoryBoundary(props.session.allowed_scope.projects), refreshProjectInventory);
watch(() => props.session.allowed_scope.projects, refreshProjectNames, { deep: true });
watch(() => props.session.session_id, resetAssignees);
watch(canWrite, writable => { if (!writable) resetAssignees(); });
watch(() => JSON.stringify([priorities.value, labelIds.value, selectedStatus.value]), () => {
  clearTimeout(filterTimer);
  projectionGeneration.invalidate();
  loadRequestId += 1;
  for (const column of Object.values(columns)) column.reset();
  resetCounts();
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
    void loadCounts();
    await Promise.all(requestedStatuses().map(status => loadColumn(status)));
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
      <div class="board-view-bar" role="group" :aria-label="locale === 'zh-CN' ? '项目视图' : 'Project view'">
        <button type="button" class="board-view-label" :class="{ 'board-view-inactive': viewMode !== 'board' }" :aria-pressed="viewMode === 'board'" :disabled="saving.size > 0 || hasPendingWrites" @click="setView('board')"><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="5" height="14" rx="1" /><rect x="12" y="3" width="5" height="8" rx="1" /></svg>{{ locale === 'zh-CN' ? '看板' : 'Board' }}</button>
        <button type="button" class="board-view-label" :class="{ 'board-view-inactive': viewMode !== 'list' }" :aria-pressed="viewMode === 'list'" :disabled="saving.size > 0 || hasPendingWrites" @click="setView('list')"><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4h10M7 10h10M7 16h10M3 4h.01M3 10h.01M3 16h.01" /></svg>{{ locale === 'zh-CN' ? '列表' : 'List' }}</button>

      </div>
      <div class="board-utility-bar">
        <form class="board-search" role="search" @submit.prevent="load()">
          <UInput v-model="search" class="board-search-field" type="search" :disabled="loading || saving.size > 0 || hasPendingWrites" :placeholder="t('board.search')" :aria-label="locale === 'zh-CN' ? '搜索事项' : 'Search issues'">
            <template #leading><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg></template>
          </UInput>
          <UButton color="neutral" variant="outline" type="submit" :disabled="loading || saving.size > 0 || hasPendingWrites">{{ locale === 'zh-CN' ? '搜索' : 'Search' }}</UButton>
        </form>
        <USelect :model-value="selectedStatus ?? 'all'" :items="statusFilterItems" :aria-label="t('issue.status')" :disabled="loading || saving.size > 0 || hasPendingWrites" @update:model-value="changeStatusFilter" />
        <IssueQueryFilters compact v-model:priorities="priorities" v-model:labels="labelIds" :projects="filterProjects" :disabled="loading || saving.size > 0 || hasPendingWrites" />
      </div>
    </header>
    <p v-if="filtersPending" class="muted-copy" role="status">{{ locale === 'zh-CN' ? '正在更新筛选结果…' : 'Updating filtered results…' }}</p>
    <ErrorNotice v-if="error" :error="error" />
    <div v-if="countsError" class="column-count-error" role="status">
      <span>{{ locale === 'zh-CN' ? '总数暂不可用。' : 'Totals are temporarily unavailable.' }} {{ errorText(countsError) }}</span>
      <button class="text-button" type="button" :disabled="countsLoading" @click="loadCounts">{{ locale === 'zh-CN' ? '重试总数' : 'Retry totals' }}</button>
    </div>
    <p v-for="pending in pendingPriorities" :key="pending.issue.id" class="warning-panel" role="status">{{ locale === 'zh-CN' ? '优先级保存结果尚未确认，请核实原操作后继续。' : 'Priority save is unconfirmed. Verify the original operation before continuing.' }} <UButton color="neutral" variant="ghost" type="button" :disabled="saving.has(pending.issue.id) || !canWrite" @click="savePriority(pending.issue, pending.priority)">{{ pending.issue.identifier }} · {{ locale === 'zh-CN' ? '核实保存' : 'Verify save' }}</UButton></p>
    <p v-for="pending in pendingStatuses" :key="pending.issue.id" class="warning-panel" role="status">{{ locale === 'zh-CN' ? '状态保存结果尚未确认，请核实原操作后继续。' : 'Status save is unconfirmed. Verify the original operation before continuing.' }} <UButton color="neutral" variant="ghost" type="button" :disabled="saving.has(pending.issue.id) || !canWrite" @click="saveStatus(pending.issue, pending.status)">{{ pending.issue.identifier }} · {{ locale === 'zh-CN' ? '核实保存' : 'Verify save' }}</UButton></p>
    <p v-for="pending in pendingAssignees" :key="pending.issue.id" class="warning-panel" role="status">{{ locale === 'zh-CN' ? '负责人保存结果尚未确认，请核实原操作后继续。' : 'Assignee save is unconfirmed. Verify the original operation before continuing.' }} <UButton color="neutral" variant="ghost" type="button" :disabled="saving.has(pending.issue.id) || !canWrite" @click="saveAssignee(pending.issue, pending.principalId)">{{ pending.issue.identifier }} · {{ locale === 'zh-CN' ? '核实保存' : 'Verify save' }}</UButton></p>
    <CasConflictNotice v-if="casConflict" :busy="formBusy || casReadbackInFlight" :conflict="casConflict" @dismiss="dismissCasConflict" @refresh="refreshCasFacts" />
    <PageState :loading="loading" :error="loading ? '' : ''" />

    <KanbanStatusNavigation v-if="!loading && viewMode === 'board'" :columns="statusNavigation" :region="boardRegion" />
    <p v-if="!loading && viewMode === 'board'" id="board-scroll-hint" class="board-scroll-hint">
      {{ locale === "zh-CN"
        ? "左右滑动查看全部 5 列；不方便拖拽时，可用卡片下方的状态菜单。"
        : "Swipe sideways to see all 5 columns. Use the status menu on each card when dragging is awkward." }}
    </p>
    <div
      v-if="!loading && viewMode === 'board'"
      ref="boardRegion"
      class="kanban-scroll"
      role="region"
      tabindex="0"
      aria-describedby="board-scroll-hint"
      :aria-label="locale === 'zh-CN' ? '项目看板横向浏览区' : 'Project Kanban horizontal navigation'"
    >
      <section class="kanban-board" :aria-label="locale === 'zh-CN' ? '项目看板' : 'Project Kanban board'">
        <article
          v-for="statusKey in eligibleStatuses"
          :key="statusKey"
          :id="`board-status-${statusKey}`"
          class="kanban-column"
          :data-status="statusKey"
          @dragover.prevent
          @drop="onDrop(statusKey)"
        >
          <header class="column-header">
            <h2>{{ statusDisplayName(statusMap.get(statusKey) ?? { key: statusKey }, locale) }}</h2>
            <UBadge color="neutral" variant="soft" size="md" :title="countLabel(statusKey)" :aria-label="countLabel(statusKey)" :aria-busy="countsLoading">{{ countsLoading ? '…' : counts ? counts.counts[statusKey] : '—' }}</UBadge>
          </header>
          <div :id="`board-column-${statusKey}`" class="column-content" tabindex="0" :aria-label="`${statusDisplayName(statusMap.get(statusKey) ?? { key: statusKey }, locale)} · ${locale === 'zh-CN' ? '事项列表' : 'Issues'}`" @scroll="onColumnScroll(statusKey, $event)">
            <article
              v-for="issue in issuesFor(statusKey)"
              :key="issue.id"
              class="issue-card"
              :class="{ saving: saving.has(issue.id) }"
              :draggable="canWrite && !saving.has(issue.id) && !pendingPriorities[issue.id] && !pendingStatuses[issue.id] && !pendingAssignees[issue.id]"
              :aria-busy="saving.has(issue.id)"
              @dragstart="onDragStart(issue, $event)"
            >
              <div class="card-topline">
                <code>{{ issue.identifier }}</code>
                <PrioritySelect v-if="canWrite" compact :value="issue.priority" :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id] || !!pendingStatuses[issue.id] || !!pendingAssignees[issue.id]" :label="`${issue.identifier} · ${t('issue.priority')}`" @change="savePriority(issue, $event)" />
                <span v-else class="priority-mark" :data-priority="issue.priority">{{ priorityLabel(issue.priority) }}</span>
              </div>
              <button class="issue-card-open" type="button" @click="openListIssue(issue.identifier)">
                <span class="card-heading">
                  <strong :title="issue.title">{{ issue.title }}</strong>
                </span>
                <span v-if="issue.labels.length || issue.needs_reassignment || issue.hierarchy?.children.total" class="card-summary">
                  <span v-if="issue.labels.length" class="label-line" :title="issue.labels.map(label => label.name).join(' · ')">
                    <UBadge v-for="label in issue.labels.slice(0, 3)" :key="label.id" class="label-chip" color="neutral" variant="soft" size="md" :title="label.name">{{ label.name }}</UBadge>
                    <span v-if="issue.labels.length > 3" class="card-label-count" :aria-label="`${locale === 'zh-CN' ? '更多标签' : 'More labels'}: ${issue.labels.slice(3).map(label => label.name).join(' · ')}`">+{{ issue.labels.length - 3 }}</span>
                  </span>
                  <IssueChildrenProgress :progress="issue.hierarchy?.children" />
                  <span v-if="issue.needs_reassignment" class="warning-chip">{{ locale === "zh-CN" ? "需重新指派" : "reassign" }}</span>
                </span>
              </button>
              <div class="card-meta">
                <div class="card-assignee">
                  <AssigneeMenu
                    v-if="canWrite"
                    :assignee="issue.assignee"
                    :candidates="assignees"
                    :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id] || !!pendingStatuses[issue.id] || !!pendingAssignees[issue.id]"
                    :loading="assigneesLoading"
                    :has-more="assigneesCursor !== null"
                    :load-error="assigneesError ? errorText(assigneesError) : null"
                    :label="`${issue.identifier} · ${t('issue.assignee')}`"
                    @open="ensureAssigneesLoaded"
                    @select="onAssigneeSelection(issue, $event)"
                    @load-more="loadAssignees(false)"
                    @retry="loadAssignees()"
                  />
                  <template v-else>
                    <UAvatar :text="issue.assignee ? [...issue.assignee.display_name][0] ?? '—' : '—'" size="2xs" />
                    <span :title="issue.assignee?.display_name ?? t('issue.unassigned')">{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span>
                  </template>
                </div>
              <select
                v-if="canWrite"
                class="card-status-select"
                :value="issue.status.key"
                :disabled="saving.has(issue.id) || !!pendingPriorities[issue.id] || !!pendingStatuses[issue.id] || !!pendingAssignees[issue.id]"
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
                  {{ statusDisplayName(statusMap.get(option) ?? { key: option }, locale) }}
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



    <ProjectIssueList v-if="!loading && viewMode === 'list'" :columns="columns" :statuses="statuses" :eligible-statuses="eligibleStatuses" :expanded-groups="expandedGroups" :matching-counts="appliedSearch || appliedPriorities.length || appliedLabelIds.length ? counts?.counts : undefined" @toggle="toggleListGroup" :can-write="canWrite" :saving="saving" :pending-ids="[...Object.keys(pendingPriorities), ...Object.keys(pendingStatuses), ...Object.keys(pendingAssignees)]" :assignees="assignees" :assignees-loading="assigneesLoading" :assignees-has-more="assigneesCursor !== null" :assignees-error="assigneesError" @open="openListIssue" @priority="savePriority" @status="onStatusSelection" @assignee="onAssigneeSelection" @people="ensureAssigneesLoaded" @people-more="loadAssignees(false)" @people-retry="loadAssignees()" @more="loadColumn" @scroll="onColumnScroll" />

    <ModalDialog v-if="showNewIssue" :busy="formBusy" :title="t('action.newIssue')" @close="showNewIssue = false">
      <form class="form-stack" @submit.prevent="createIssue">
        <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<UInput v-model="newIssue.title" required maxlength="256" autofocus /></label>
        <label>{{ t("issue.body") }}<UTextarea v-model="newIssue.body" :rows="7" :placeholder="t('comment.placeholder')" /></label>
        <div class="form-grid">
          <label>{{ t("issue.status") }}<USelect v-model="newIssue.status_key" :items="statusOrder.filter(key => key !== 'done').map(key => ({ value: key, label: statusDisplayName(statusMap.get(key) ?? { key }, locale) }))" /></label>
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
.board-view-bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 24px; border-bottom: 1px solid var(--color-border); padding-top: 6px; }
.board-view-label { display: inline-flex; align-items: center; gap: 8px; align-self: stretch; padding: 10px 0; border: 0; border-bottom: 2px solid var(--color-primary); background: transparent; color: var(--color-primary); font-size: 14px; font-weight: 600; cursor: pointer; }
.board-view-inactive { border-bottom-color: transparent; color: var(--color-text-muted); font-weight: 400; }
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
