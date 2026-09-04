<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import {
  type CasConflictState,
  captureCasConflict,
  markCasReadbackComplete,
  markCasReadbackFailed,
} from "../lib/cas-recovery";
import { locale, t } from "../lib/i18n";
import { continuationCursor, cursorRequiresRestart, mergePageById } from "../lib/pagination";
import { ProjectionGeneration } from "../lib/projection-generation";
import { navigate } from "../lib/router";
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
  projectKey: string;
  session: WebSessionView;
  workspaceKey: string;
}>();

const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();
const statusOrder: StatusKey[] = ["backlog", "todo", "in_progress", "done", "canceled"];
const project = ref<ContainerResource | null>(null);
const statuses = ref<ProjectStatusResource[]>([]);
const issues = ref<IssueSummary[]>([]);
const deletedIssues = ref<IssueTombstone[]>([]);
const deletedIssuesNextCursor = ref<string | null>(null);
const deletedIssuesLoadingMore = ref(false);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const search = ref("");
const saving = ref(new Set<string>());
const dragged = ref<IssueSummary | null>(null);
const completionIssue = ref<IssueSummary | null>(null);
const completionSummary = ref("");
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
    item.workspace_key === props.workspaceKey && item.project_key === props.projectKey
  ))?.role ?? "reader";
});
const canWrite = computed(() => projectIsActive() && (role.value === "writer" || role.value === "owner"));
const statusMap = computed(() => new Map(statuses.value.map((status) => [status.key, status])));

function projectIsActive(): boolean {
  const scope = props.session.allowed_scope.projects;
  return scope === undefined || scope.some((item) => (
    item.workspace_key === props.workspaceKey && item.project_key === props.projectKey
  ));
}

function cursorRestartText(): string {
  return locale.value === "zh-CN"
    ? "列表范围或可见权限已变化，原分页位置已失效。请刷新当前列表后继续。"
    : "The list scope or visibility changed, so the old cursor was retired. Refresh this list before continuing.";
}

function projectionIsCurrent(generation: number): boolean {
  return projectionGeneration.isCurrent(generation) && projectIsActive();
}

function clearProjectProjection(): void {
  project.value = null;
  statuses.value = [];
  issues.value = [];
  deletedIssues.value = [];
  deletedIssuesNextCursor.value = null;
  nextCursor.value = null;
  loading.value = false;
  loadingMore.value = false;
  completionIssue.value = null;
  showDeleted.value = false;
  showNewIssue.value = false;
  error.value = locale.value === "zh-CN"
    ? "此项目已不在当前可用项目列表中。"
    : "This Project is no longer in the current active Project inventory.";
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

function query(cursor?: string): string {
  const params = new URLSearchParams({ limit: "100" });
  if (search.value.trim()) params.set("q", search.value.trim());
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/workspaces/${encodeURIComponent(props.workspaceKey)}/projects/${encodeURIComponent(props.projectKey)}/issues?${params}`;
}

async function load(reset = true, throwOnFailure = false): Promise<void> {
  if (!projectIsActive()) {
    clearProjectProjection();
    return;
  }
  const generation = projectionGeneration.capture();
  const requestId = loadRequestId + 1;
  loadRequestId = requestId;
  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = "";
  try {
    const [projectResult, statusResult, issueResult] = await Promise.all([
      apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceKey)}/projects/${encodeURIComponent(props.projectKey)}`),
      apiRequest<ListResult<ProjectStatusResource>>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceKey)}/projects/${encodeURIComponent(props.projectKey)}/statuses`),
      apiRequest<ListResult<IssueSummary>>(query(reset ? undefined : nextCursor.value ?? undefined)),
    ]);
    if (requestId !== loadRequestId || !projectionIsCurrent(generation)) return;
    project.value = projectResult;
    statuses.value = statusResult.items;
    issues.value = mergePageById(issues.value, issueResult.items, reset);
    nextCursor.value = continuationCursor(issueResult);
    emit("context", { label: `${props.workspaceKey} / ${projectResult.display_name}`, role: role.value });
  } catch (caught) {
    if (requestId !== loadRequestId || !projectionIsCurrent(generation)) return;
    if (!reset && cursorRequiresRestart(caught)) {
      nextCursor.value = null;
      error.value = cursorRestartText();
    } else {
      error.value = errorText(caught);
    }
    if (caught instanceof ApiProblem && (caught.status === 403 || caught.status === 404)) {
      project.value = null;
      statuses.value = [];
      issues.value = [];
      nextCursor.value = null;
    }
    if (throwOnFailure) throw caught;
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

async function recoverCasConflict(
  caught: unknown,
  resource: string,
  draft: unknown,
  readback: () => Promise<void> = () => load(true, true),
): Promise<boolean> {
  const conflict = captureCasConflict(caught, resource, draft);
  if (conflict === null) return false;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  casReadback = readback;
  casConflict.value = conflict;
  error.value = t("error.conflict");
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
  if (!canWrite.value || issue.status.key === status || saving.value.has(issue.id) || !writeFence.enter(fenceKey)) return;
  if (status === "done") {
    writeFence.leave(fenceKey);
    completionIssue.value = issue;
    completionSummary.value = "";
    return;
  }
  saving.value = new Set(saving.value).add(issue.id);
  error.value = "";
  const generation = projectionGeneration.capture();
  try {
    const result = await apiRequest<WriteResult<IssueSummary>>(`/api/v1/issues/${issue.identifier}`, {
      body: { expected_version: issue.version, status_key: status },
      method: "PATCH",
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      issues.value = issues.value.map((item) => item.id === issue.id ? result.resource : item);
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, `${issue.identifier} ${locale.value === "zh-CN" ? "状态" : "status"}`, { status_key: status })) {
      error.value = errorText(caught);
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

async function completeIssue(): Promise<void> {
  const issue = completionIssue.value;
  if (issue === null || !completionSummary.value.trim()) return;
  const fenceKey = `issue-complete:${issue.id}`;
  if (!writeFence.enter(fenceKey)) return;
  formBusy.value = true;
  const generation = projectionGeneration.capture();
  try {
    const result = await apiRequest<WriteResult<IssueSummary>>(`/api/v1/issues/${issue.identifier}/commands/complete`, {
      body: { expected_version: issue.version, summary: completionSummary.value.trim() },
      method: "POST",
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      issues.value = issues.value.map((item) => item.id === issue.id ? result.resource : item);
      completionIssue.value = null;
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, `${issue.identifier} ${locale.value === "zh-CN" ? "完成记录" : "completion"}`, { summary: completionSummary.value })) {
      error.value = errorText(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    formBusy.value = false;
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
      `/api/v1/workspaces/${encodeURIComponent(props.workspaceKey)}/projects/${encodeURIComponent(props.projectKey)}/issues`,
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
      issues.value = [result.resource, ...issues.value];
      newIssue.value = { body: "", priority_key: "none", status_key: "backlog", title: "" };
      showNewIssue.value = false;
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    error.value = errorText(caught);
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
      `/api/v1/workspaces/${encodeURIComponent(props.workspaceKey)}/projects/${encodeURIComponent(props.projectKey)}/issues?${params}`,
    );
    if (projectionIsCurrent(generation)) {
      deletedIssues.value = mergePageById(deletedIssues.value, result.items, reset);
      deletedIssuesNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!reset && cursorRequiresRestart(caught)) {
      deletedIssuesNextCursor.value = null;
      error.value = cursorRestartText();
    } else {
      error.value = errorText(caught);
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
    if (!await recoverCasConflict(caught, `${issue.identifier} ${locale.value === "zh-CN" ? "恢复" : "restore"}`, { action: "restore" }, () => loadDeleted(true, true))) {
      error.value = errorText(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    formBusy.value = false;
  }
}

function issuesFor(status: StatusKey): IssueSummary[] {
  return issues.value.filter((issue) => issue.status.key === status);
}

function priorityLabel(priority: PriorityKey): string {
  if (locale.value !== "zh-CN") return priority;
  return ({ none: "无", low: "低", medium: "中", high: "高", urgent: "紧急" } as const)[priority];
}

function onDragStart(issue: IssueSummary, event: DragEvent): void {
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
});
watch(() => props.session.allowed_scope.projects, refreshProjectInventory, { deep: true });
</script>

<template>
  <main class="board-page">
    <header class="board-toolbar">
      <div class="board-title">
        <p class="eyebrow">{{ workspaceKey }} / {{ projectKey }}</p>
        <h1>{{ project?.display_name ?? projectKey }}</h1>
      </div>
      <form class="board-search" role="search" @submit.prevent="load()">
        <input v-model="search" type="search" :placeholder="t('board.search')" :aria-label="locale === 'zh-CN' ? '搜索事项' : 'Search issues'" />
      </form>
      <div class="board-toolbar-actions">
        <span v-if="!canWrite" class="read-only-badge">{{ t("board.readOnly") }}</span>
        <button v-if="canWrite" class="text-button" type="button" @click="loadDeleted(true)">{{ locale === "zh-CN" ? "已删除" : "Deleted" }}</button>
        <button v-if="canWrite" class="primary-button" type="button" @click="showNewIssue = true">{{ t("action.newIssue") }}</button>
      </div>
    </header>

    <p v-if="error" class="inline-alert" role="alert">{{ error }}</p>
    <CasConflictNotice v-if="casConflict" :busy="formBusy || casReadbackInFlight" :conflict="casConflict" @dismiss="dismissCasConflict" @refresh="refreshCasFacts" />
    <PageState :loading="loading" :error="loading ? '' : ''" />

    <section v-if="!loading" class="kanban-board" :aria-label="locale === 'zh-CN' ? '项目看板' : 'Project Kanban board'">
      <article
        v-for="statusKey in statusOrder"
        :key="statusKey"
        class="kanban-column"
        @dragover.prevent
        @drop="onDrop(statusKey)"
      >
        <header class="column-header">
          <h2>{{ statusMap.get(statusKey)?.display_name ?? statusKey }}</h2>
          <span>{{ issuesFor(statusKey).length }}</span>
        </header>
        <div class="column-content">
          <article
            v-for="issue in issuesFor(statusKey)"
            :key="issue.id"
            class="issue-card"
            :class="{ saving: saving.has(issue.id), blocked: issue.is_blocked }"
            :draggable="canWrite && !saving.has(issue.id)"
            :aria-busy="saving.has(issue.id)"
            @dragstart="onDragStart(issue, $event)"
          >
            <button class="issue-card-open" type="button" @click="navigate(`/app/issues/${issue.identifier}`)">
              <span class="card-meta">
                <code>{{ issue.identifier }}</code>
                <span v-if="issue.priority !== 'none'" class="priority-mark">{{ priorityLabel(issue.priority) }}</span>
              </span>
              <strong>{{ issue.title }}</strong>
              <span v-if="issue.labels.length" class="label-line">
                <span v-for="label in issue.labels.slice(0, 3)" :key="label.id" class="label-chip">{{ label.name }}</span>
              </span>
              <span class="card-footer">
                <span>{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span>
                <span v-if="issue.is_blocked" class="warning-chip">{{ locale === "zh-CN" ? "已阻塞" : "blocked" }}</span>
                <span v-if="issue.needs_reassignment" class="warning-chip">{{ locale === "zh-CN" ? "需重新指派" : "reassign" }}</span>
              </span>
            </button>
            <select
              v-if="canWrite"
              class="card-status-select"
              :value="issue.status.key"
              :aria-label="locale === 'zh-CN' ? '变更状态' : 'Change status'"
              @click.stop
              @change.stop="onStatusSelection(issue, $event)"
            >
              <option v-for="option in statusOrder" :key="option" :value="option">
                {{ statusMap.get(option)?.display_name ?? option }}
              </option>
            </select>
          </article>
          <p v-if="issuesFor(statusKey).length === 0" class="column-empty">{{ t("board.empty") }}</p>
        </div>
      </article>
    </section>

    <button v-if="nextCursor" class="load-more" type="button" :disabled="loadingMore" @click="load(false)">
      {{ loadingMore ? "…" : (locale === "zh-CN" ? "加载更多" : "Load more") }}
    </button>

    <ModalDialog v-if="showNewIssue" :busy="formBusy" :title="t('action.newIssue')" @close="showNewIssue = false">
      <form class="form-stack" @submit.prevent="createIssue">
        <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<input v-model="newIssue.title" required maxlength="256" /></label>
        <label>{{ t("issue.body") }}<textarea v-model="newIssue.body" rows="7" :placeholder="t('comment.placeholder')" /></label>
        <div class="form-grid">
          <label>{{ t("issue.status") }}<select v-model="newIssue.status_key"><option v-for="key in statusOrder.filter((item) => item !== 'done')" :key="key" :value="key">{{ statusMap.get(key)?.display_name ?? key }}</option></select></label>
          <label>{{ t("issue.priority") }}<select v-model="newIssue.priority_key"><option v-for="key in ['none','low','medium','high','urgent']" :key="key" :value="key">{{ priorityLabel(key as PriorityKey) }}</option></select></label>
        </div>
        <div class="form-actions"><button class="secondary-button" type="button" @click="showNewIssue = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="formBusy">{{ t("action.save") }}</button></div>
      </form>
    </ModalDialog>

    <ModalDialog v-if="completionIssue" :busy="formBusy" :title="t('complete.title')" @close="completionIssue = null">
      <form class="form-stack" @submit.prevent="completeIssue">
        <p><code>{{ completionIssue.identifier }}</code> · {{ completionIssue.title }}</p>
        <label>{{ t("complete.summary") }}<textarea v-model="completionSummary" required rows="6" maxlength="8192" /></label>
        <div class="form-actions"><button class="secondary-button" type="button" @click="completionIssue = null">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="formBusy">{{ t("complete.title") }}</button></div>
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
