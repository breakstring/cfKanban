<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import AssigneeSelect from "../components/AssigneeSelect.vue";
import CasConflictNotice from "../components/CasConflictNotice.vue";
import CompletionRecord from "../components/CompletionRecord.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import IssueAttachments from "../components/IssueAttachments.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { forgetIssueAttachmentUploadDraft } from "../lib/attachment-upload-drafts";
import {
  type CasConflictState,
  captureCasConflict,
  markCasReadbackComplete,
  markCasReadbackFailed,
} from "../lib/cas-recovery";
import { isVerifiedServiceAccessFailure, projectInventoryBoundary } from "../lib/session-boundary";
import { locale, t } from "../lib/i18n";
import { localizedText, type LocalizedText, useLocalizedError } from "../lib/localized-error";
import { continuationCursor, cursorRequiresRestart, mergePageById } from "../lib/pagination";
import { ProjectionGeneration } from "../lib/projection-generation";
import { navigate } from "../lib/router";
import { canCreateIssueRelation } from "../lib/session-capabilities";
import { WriteFence } from "../lib/write-fence";
import type {
  IssueComment,
  IssueDetail,
  IssueRelation,
  LabelResource,
  ListResult,
  PriorityKey,
  ProjectStatusResource,
  StatusKey,
  WebSessionView,
  WriteResult,
} from "../types";

const props = defineProps<{ identifier: string; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();

const issue = ref<IssueDetail | null>(null);
const statuses = ref<ProjectStatusResource[]>([]);
const labels = ref<LabelResource[]>([]);
const labelsNextCursor = ref<string | null>(null);
const labelsLoadingMore = ref(false);
const deletedLabels = ref<LabelResource[]>([]);
const deletedLabelsNextCursor = ref<string | null>(null);
const comments = ref<IssueComment[]>([]);
const commentNextCursor = ref<string | null>(null);
const commentLoadingMore = ref(false);
const deletedComments = ref<IssueComment[]>([]);
const deletedCommentsNextCursor = ref<string | null>(null);
const relations = ref<IssueRelation[]>([]);
const relationsNextCursor = ref<string | null>(null);
const relationsLoadingMore = ref(false);
const deletedRelations = ref<IssueRelation[]>([]);
const deletedRelationsNextCursor = ref<string | null>(null);
const deletedCollectionLoading = ref<"comments" | "labels" | "relations" | null>(null);
const loading = ref(true);
const busy = ref(false);
const { clearError, error, setError, setErrorKey, setLocalizedError } = useLocalizedError();
const casConflict = ref<CasConflictState | null>(null);
const editMode = ref(false);
const edit = ref({ body: "", priority_key: "none" as PriorityKey, title: "" });
const comment = ref("");
const completionSummary = ref("");
const blockReason = ref("");
const showComplete = ref(false);
const showBlocked = ref(false);
const showDelete = ref(false);
const showRelation = ref(false);
const showCollaborationRecovery = ref(false);
const showLabelManager = ref(false);
const relation = ref({ kind: "related", target_identifier: "" });
const relationTarget = ref<IssueDetail | null>(null);
const newLabel = ref({ color: "", name: "" });
const projectionGeneration = new ProjectionGeneration();
const writeFence = new WriteFence();
let issueProjectScope: { projectId: string; workspaceId: string } | null = null;
let loadRequestId = 0;
let casRecoveryGeneration = 0;
let casReadback: (() => Promise<void>) | null = null;
let casReadbackInFlight = false;

const canUpdate = computed(() => issue.value?.allowed_actions.includes("update") ?? false);
const canDelete = computed(() => issue.value?.allowed_actions.includes("delete") ?? false);
const canRestore = computed(() => issue.value?.allowed_actions.includes("restore") ?? false);
const relationTargetCanWrite = computed(() => canCreateIssueRelation(issue.value, relationTarget.value));
const statusMap = computed(() => new Map(statuses.value.map((status) => [status.key, status])));

function statusDisplayName(key: StatusKey): string {
  return statusMap.value.get(key)?.display_name ?? key;
}

function ui(english: string, chinese: string): string {
  return locale.value === "zh-CN" ? chinese : english;
}

function priorityLabel(priority: PriorityKey): string {
  if (locale.value !== "zh-CN") return priority;
  return ({ none: "无", low: "低", medium: "中", high: "高", urgent: "紧急" } as const)[priority];
}

function relationKindLabel(kind: string): string {
  if (locale.value !== "zh-CN") return kind;
  return ({ blocks: "阻塞", parent: "父子", related: "相关", duplicate: "重复" } as Record<string, string>)[kind] ?? kind;
}

function commandConflictResource(identifier: string, command: string): LocalizedText {
  const chinese = ({
    "assign-to-me": "指派给我",
    "clear-blocked": "清除阻塞",
    complete: "完成",
    "report-blocked": "报告阻塞",
  } as Record<string, string>)[command] ?? command;
  return localizedText(`${identifier} ${command}`, `${identifier} ${chinese}`);
}

function handleCursorError(caught: unknown, retire: () => void): void {
  if (cursorRequiresRestart(caught)) {
    retire();
    setLocalizedError(
      "The list scope or visibility changed, so the old cursor was retired. Refresh this Issue before continuing.",
      "列表范围或可见权限已变化，原分页位置已失效。请刷新当前事项后继续。",
    );
    return;
  }
  setError(caught);
}

function projectIsActive(scope = issueProjectScope): boolean {
  if (scope === null) return true;
  const projects = props.session.allowed_scope.projects;
  return projects === undefined || projects.some((item) => (
    item.workspace_id === scope.workspaceId && item.project_id === scope.projectId
  ));
}

function projectionIsCurrent(generation: number): boolean {
  return projectionGeneration.isCurrent(generation) && projectIsActive();
}

function clearIssueProjection(): void {
  issue.value = null;
  statuses.value = [];
  labels.value = [];
  labelsNextCursor.value = null;
  deletedLabels.value = [];
  deletedLabelsNextCursor.value = null;
  comments.value = [];
  deletedComments.value = [];
  deletedCommentsNextCursor.value = null;
  commentNextCursor.value = null;
  relations.value = [];
  relationsNextCursor.value = null;
  deletedRelations.value = [];
  deletedRelationsNextCursor.value = null;
  relationTarget.value = null;
  loading.value = false;
  commentLoadingMore.value = false;
}

function refreshProjectNames(): void {
  const current = issue.value;
  if (current === null) return;
  const scope = props.session.allowed_scope.projects?.find((item) => item.project_id === current.project.id && item.workspace_id === current.workspace.id);
  if (scope === undefined) return;
  issue.value = { ...current, project: { ...current.project, display_name: scope.project_display_name }, workspace: { ...current.workspace, display_name: scope.workspace_display_name } };
  emit("context", { label: `${scope.workspace_display_name} / ${scope.project_display_name}`, role: roleForProject() });
}

function refreshProjectInventory(): void {
  projectionGeneration.invalidate();
  loadRequestId += 1;
  deletedComments.value = [];
  deletedCommentsNextCursor.value = null;
  deletedLabels.value = [];
  deletedLabelsNextCursor.value = null;
  deletedRelations.value = [];
  deletedRelationsNextCursor.value = null;
  relationTarget.value = null;
  showCollaborationRecovery.value = false;
  const current = issue.value;
  if (current !== null) {
    issueProjectScope = { projectId: current.project.id, workspaceId: current.workspace.id };
  }
  const scope = props.session.allowed_scope.projects;
  if (issueProjectScope !== null && scope !== undefined && !projectIsActive()) {
    clearIssueProjection();
    setLocalizedError(
      "This Issue's Project is no longer in the current active Project inventory.",
      "此事项所属项目已不在当前可用项目列表中。",
    );
    return;
  }
  void load(true);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function roleForProject(current = issue.value): string {
  if (props.session.principal.is_owner) return "owner";
  if (current === null) return "reader";
  return props.session.allowed_scope.projects?.find((item) => (
    item.workspace_id === current.workspace.id && item.project_id === current.project.id
  ))?.role ?? "reader";
}

function mergeComments(...groups: IssueComment[][]): IssueComment[] {
  return [...new Map(groups.flat().map((entry) => [entry.id, entry])).values()].sort((left, right) => (
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  ));
}

async function load(preserveLocalDrafts = editMode.value, throwOnFailure = false): Promise<void> {
  const generation = projectionGeneration.capture();
  const requestId = loadRequestId + 1;
  loadRequestId = requestId;
  loading.value = true;
  clearError();
  try {
    const result = await apiRequest<IssueDetail>(`/api/v1/issues/${encodeURIComponent(props.identifier)}`);
    const resultScope = { projectId: result.project.id, workspaceId: result.workspace.id };
    if (requestId !== loadRequestId || !projectionGeneration.isCurrent(generation) || !projectIsActive(resultScope)) {
      return;
    }
    const [statusResult, labelResult, commentResult, relationResult] = await Promise.all([
      apiRequest<ListResult<ProjectStatusResource>>(
        `/api/v1/workspaces/${encodeURIComponent(result.workspace.id)}/projects/${encodeURIComponent(result.project.id)}/statuses`,
      ),
      apiRequest<ListResult<LabelResource>>(
        `/api/v1/workspaces/${encodeURIComponent(result.workspace.id)}/projects/${encodeURIComponent(result.project.id)}/labels?limit=100`,
      ),
      apiRequest<ListResult<IssueComment>>(`/api/v1/issues/${encodeURIComponent(result.identifier)}/comments?limit=100`),
      apiRequest<ListResult<IssueRelation>>(`/api/v1/issues/${encodeURIComponent(result.identifier)}/relations?limit=100`),
    ]);
    if (requestId !== loadRequestId || !projectionGeneration.isCurrent(generation) || !projectIsActive(resultScope)) {
      return;
    }
    issueProjectScope = resultScope;
    issue.value = result;
    if (!preserveLocalDrafts) {
      edit.value = { body: result.body ?? "", priority_key: result.priority, title: result.title };
    }
    emit("context", { label: `${result.workspace.display_name} / ${result.project.display_name}`, role: roleForProject(result) });
    statuses.value = statusResult.items;
    labels.value = labelResult.items;
    labelsNextCursor.value = continuationCursor(labelResult);
    // Remote projections are replaced from the current first page. Local edit,
    // comment, completion, block, and relation drafts live in separate refs and
    // do not require retaining rows that the server no longer returns.
    comments.value = commentResult.items;
    commentNextCursor.value = continuationCursor(commentResult);
    relations.value = relationResult.items;
    relationsNextCursor.value = continuationCursor(relationResult);
  } catch (caught) {
    if (requestId !== loadRequestId || !projectionGeneration.isCurrent(generation)) return;
    setError(caught);
    if (caught instanceof ApiProblem && (caught.status === 403 || caught.status === 404)) {
      if (isVerifiedServiceAccessFailure(caught.status, caught.body)) {
        forgetIssueAttachmentUploadDraft(props.session.session_id, props.session.principal.id, props.identifier);
      }
      issue.value = null;
      statuses.value = [];
      labels.value = [];
      labelsNextCursor.value = null;
      comments.value = [];
      commentNextCursor.value = null;
      relations.value = [];
      relationsNextCursor.value = null;
    }
    if (throwOnFailure) throw caught;
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

async function loadMoreComments(): Promise<void> {
  const current = issue.value;
  if (current === null || commentNextCursor.value === null) return;
  const generation = projectionGeneration.capture();
  commentLoadingMore.value = true;
  try {
    const result = await apiRequest<ListResult<IssueComment>>(
      `/api/v1/issues/${encodeURIComponent(current.identifier)}/comments?limit=100&cursor=${encodeURIComponent(commentNextCursor.value)}`,
    );
    if (projectionIsCurrent(generation)) {
      comments.value = mergeComments(comments.value, result.items);
      commentNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    handleCursorError(caught, () => { commentNextCursor.value = null; });
  } finally {
    commentLoadingMore.value = false;
  }
}

async function loadMoreLabels(): Promise<void> {
  const current = issue.value;
  if (current === null || labelsNextCursor.value === null || labelsLoadingMore.value) return;
  const generation = projectionGeneration.capture();
  labelsLoadingMore.value = true;
  try {
    const result = await apiRequest<ListResult<LabelResource>>(
      `/api/v1/workspaces/${encodeURIComponent(current.workspace.id)}/projects/${encodeURIComponent(current.project.id)}/labels?limit=100&cursor=${encodeURIComponent(labelsNextCursor.value)}`,
    );
    if (projectionIsCurrent(generation)) {
      labels.value = mergePageById(labels.value, result.items);
      labelsNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)) handleCursorError(caught, () => { labelsNextCursor.value = null; });
  } finally {
    labelsLoadingMore.value = false;
  }
}

async function loadMoreRelations(): Promise<void> {
  const current = issue.value;
  if (current === null || relationsNextCursor.value === null || relationsLoadingMore.value) return;
  const generation = projectionGeneration.capture();
  relationsLoadingMore.value = true;
  try {
    const result = await apiRequest<ListResult<IssueRelation>>(
      `/api/v1/issues/${encodeURIComponent(current.identifier)}/relations?limit=100&cursor=${encodeURIComponent(relationsNextCursor.value)}`,
    );
    if (projectionIsCurrent(generation)) {
      relations.value = mergePageById(relations.value, result.items);
      relationsNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)) handleCursorError(caught, () => { relationsNextCursor.value = null; });
  } finally {
    relationsLoadingMore.value = false;
  }
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

async function refreshCurrentFacts(): Promise<void> {
  const generation = projectionGeneration.capture();
  const result = await apiRequest<IssueDetail>(`/api/v1/issues/${encodeURIComponent(props.identifier)}`);
  const resultScope = { projectId: result.project.id, workspaceId: result.workspace.id };
  if (!projectionGeneration.isCurrent(generation) || !projectIsActive(resultScope)) return;
  issueProjectScope = resultScope;
  issue.value = result;
  emit("context", { label: `${result.workspace.display_name} / ${result.project.display_name}`, role: roleForProject(result) });
}

async function updateIssue(payload: Record<string, unknown>): Promise<void> {
  const current = issue.value;
  if (current === null || busy.value || !canUpdate.value) return;
  const fenceKey = `issue-update:${current.id}`;
  if (!writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<IssueDetail>>(`/api/v1/issues/${current.identifier}`, {
      body: { expected_version: current.version, ...payload },
      method: "PATCH",
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      issue.value = result.resource;
      editMode.value = false;
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, current.identifier, payload, refreshCurrentFacts)) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

function onStatusSelection(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const status = select.value as StatusKey;
  if (issue.value === null) return;
  select.value = issue.value.status.key;
  if (status === issue.value.status.key) return;
  if (status === "done") showComplete.value = true;
  else void updateIssue({ status_key: status });
}

async function saveEdit(): Promise<void> {
  await updateIssue({
    body: edit.value.body,
    priority_key: edit.value.priority_key,
    title: edit.value.title.trim(),
  });
}

async function runCommand(command: string, payload: Record<string, unknown> = {}): Promise<void> {
  const current = issue.value;
  if (current === null || busy.value || !canUpdate.value) return;
  const fenceKey = `issue-command:${current.id}:${command}`;
  if (!writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<IssueDetail & { completion_comment_id?: string }>>(
      `/api/v1/issues/${current.identifier}/commands/${command}`,
      { body: { expected_version: current.version, ...payload }, method: "POST" },
    );
    if (!projectionIsCurrent(generation)) return;
    dismissCasConflict();
    issue.value = result.resource;
    showComplete.value = false;
    showBlocked.value = false;
    completionSummary.value = "";
    blockReason.value = "";
    if (command === "complete" && result.resource.completion_comment_id) {
      try {
        const completion = await apiRequest<IssueComment>(`/api/v1/comments/${result.resource.completion_comment_id}`);
        if (projectionIsCurrent(generation)) comments.value = mergeComments(comments.value, [completion]);
      } catch (caught) {
        if (projectionIsCurrent(generation)) setError(caught);
      }
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, commandConflictResource(current.identifier, command), payload, refreshCurrentFacts)) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function deleteOrRestore(): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  const fenceKey = `issue-delete-restore:${current.id}`;
  if (!writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  try {
    if (current.deleted_at === null) {
      await apiRequest(`/api/v1/issues/${current.identifier}?expected_version=${current.version}`, { method: "DELETE" });
      if (projectionIsCurrent(generation)) {
        showDelete.value = false;
        navigate(`/app/w/${encodeURIComponent(current.workspace.id)}/p/${encodeURIComponent(current.project.id)}`);
      }
      return;
    } else {
      await apiRequest(`/api/v1/issues/${current.identifier}/commands/restore`, {
        body: { expected_version: current.version }, method: "POST",
      });
    }
    if (projectionIsCurrent(generation)) await load();
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (!await recoverCasConflict(caught, current.deleted_at === null
      ? localizedText(`${current.identifier} delete`, `${current.identifier} 删除`)
      : localizedText(`${current.identifier} restore`, `${current.identifier} 恢复`), {
      action: current.deleted_at === null ? "delete" : "restore",
    })) setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function addComment(): Promise<void> {
  const current = issue.value;
  if (current === null || !comment.value.trim()) return;
  const fenceKey = `comment-create:${current.id}`;
  if (!writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<IssueComment>>(`/api/v1/issues/${current.identifier}/comments`, {
      body: { body: comment.value }, method: "POST",
    });
    if (projectionIsCurrent(generation)) {
      comment.value = "";
      comments.value = mergeComments(comments.value, [result.resource]);
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function toggleLabel(labelId: string, add: boolean): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  const fenceKey = `issue-label:${current.id}:${labelId}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/issues/${current.identifier}/commands/${add ? "add-label" : "remove-label"}`, {
      body: { expected_version: current.version, label_id: labelId }, method: "POST",
    });
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`${current.identifier} labels`, `${current.identifier} 标签`), { action: add ? "add" : "remove", label_id: labelId })) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function deleteComment(entry: IssueComment): Promise<void> {
  const fenceKey = `comment-delete:${entry.id}`;
  if (!writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  try {
    await apiRequest(`/api/v1/comments/${entry.id}?expected_version=${entry.version}`, { method: "DELETE" });
    if (projectionIsCurrent(generation)) {
      comments.value = comments.value.filter((commentEntry) => commentEntry.id !== entry.id);
      await load();
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)
      && !await recoverCasConflict(caught, localizedText(`Comment ${entry.id}`, `评论 ${entry.id}`), { action: "delete" })) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function loadCollaborationRecovery(throwOnFailure = false): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  clearError();
  try {
    const [commentResult, labelResult, relationResult] = await Promise.all([
      apiRequest<ListResult<IssueComment>>(`/api/v1/issues/${current.identifier}/comments?deleted=only&limit=100`),
      apiRequest<ListResult<LabelResource>>(
        `/api/v1/workspaces/${encodeURIComponent(current.workspace.id)}/projects/${encodeURIComponent(current.project.id)}/labels?deleted=only&limit=100`,
      ),
      apiRequest<ListResult<IssueRelation>>(`/api/v1/issues/${current.identifier}/relations?deleted=only&limit=100`),
    ]);
    if (projectionIsCurrent(generation)) {
      deletedComments.value = commentResult.items;
      deletedCommentsNextCursor.value = continuationCursor(commentResult);
      deletedLabels.value = labelResult.items;
      deletedLabelsNextCursor.value = continuationCursor(labelResult);
      deletedRelations.value = relationResult.items;
      deletedRelationsNextCursor.value = continuationCursor(relationResult);
      showCollaborationRecovery.value = true;
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)) setError(caught);
    if (throwOnFailure) throw caught;
  } finally {
    busy.value = false;
  }
}

async function loadMoreDeletedComments(): Promise<void> {
  const current = issue.value;
  if (current === null || deletedCommentsNextCursor.value === null || deletedCollectionLoading.value !== null) return;
  const generation = projectionGeneration.capture();
  deletedCollectionLoading.value = "comments";
  try {
    const result = await apiRequest<ListResult<IssueComment>>(
      `/api/v1/issues/${encodeURIComponent(current.identifier)}/comments?deleted=only&limit=100&cursor=${encodeURIComponent(deletedCommentsNextCursor.value)}`,
    );
    if (projectionIsCurrent(generation)) {
      deletedComments.value = mergePageById(deletedComments.value, result.items);
      deletedCommentsNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)) handleCursorError(caught, () => { deletedCommentsNextCursor.value = null; });
  } finally {
    deletedCollectionLoading.value = null;
  }
}

async function loadMoreDeletedLabels(): Promise<void> {
  const current = issue.value;
  if (current === null || deletedLabelsNextCursor.value === null || deletedCollectionLoading.value !== null) return;
  const generation = projectionGeneration.capture();
  deletedCollectionLoading.value = "labels";
  try {
    const result = await apiRequest<ListResult<LabelResource>>(
      `/api/v1/workspaces/${encodeURIComponent(current.workspace.id)}/projects/${encodeURIComponent(current.project.id)}/labels?deleted=only&limit=100&cursor=${encodeURIComponent(deletedLabelsNextCursor.value)}`,
    );
    if (projectionIsCurrent(generation)) {
      deletedLabels.value = mergePageById(deletedLabels.value, result.items);
      deletedLabelsNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)) handleCursorError(caught, () => { deletedLabelsNextCursor.value = null; });
  } finally {
    deletedCollectionLoading.value = null;
  }
}

async function loadMoreDeletedRelations(): Promise<void> {
  const current = issue.value;
  if (current === null || deletedRelationsNextCursor.value === null || deletedCollectionLoading.value !== null) return;
  const generation = projectionGeneration.capture();
  deletedCollectionLoading.value = "relations";
  try {
    const result = await apiRequest<ListResult<IssueRelation>>(
      `/api/v1/issues/${encodeURIComponent(current.identifier)}/relations?deleted=only&limit=100&cursor=${encodeURIComponent(deletedRelationsNextCursor.value)}`,
    );
    if (projectionIsCurrent(generation)) {
      deletedRelations.value = mergePageById(deletedRelations.value, result.items);
      deletedRelationsNextCursor.value = continuationCursor(result);
    }
  } catch (caught) {
    if (projectionIsCurrent(generation)) handleCursorError(caught, () => { deletedRelationsNextCursor.value = null; });
  } finally {
    deletedCollectionLoading.value = null;
  }
}

async function restoreComment(entry: IssueComment): Promise<void> {
  const fenceKey = `comment-restore:${entry.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/comments/${entry.id}/commands/restore`, {
      body: { expected_version: entry.version }, method: "POST",
    });
    await load();
    await loadCollaborationRecovery();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Comment ${entry.id}`, `评论 ${entry.id}`), { action: "restore" }, () => loadCollaborationRecovery(true))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function createLabel(): Promise<void> {
  const current = issue.value;
  if (current === null || !newLabel.value.name.trim()) return;
  const fenceKey = `label-create:${current.project.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(
      `/api/v1/workspaces/${encodeURIComponent(current.workspace.id)}/projects/${encodeURIComponent(current.project.id)}/labels`,
      {
        body: {
          color: newLabel.value.color.trim() || null,
          name: newLabel.value.name.trim(),
        },
        method: "POST",
      },
    );
    newLabel.value = { color: "", name: "" };
    await load();
  } catch (caught) { setError(caught); } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function deleteLabel(label: LabelResource): Promise<void> {
  const fenceKey = `label-delete:${label.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/labels/${label.id}?expected_version=${label.version}`, { method: "DELETE" });
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Label ${label.name}`, `标签 ${label.name}`), { action: "delete", label_id: label.id })) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function restoreLabel(label: LabelResource): Promise<void> {
  const fenceKey = `label-restore:${label.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/labels/${label.id}/commands/restore`, {
      body: { expected_version: label.version }, method: "POST",
    });
    await load();
    await loadCollaborationRecovery();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Label ${label.name}`, `标签 ${label.name}`), { action: "restore", label_id: label.id }, () => loadCollaborationRecovery(true))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function previewRelationTarget(): Promise<void> {
  const identifier = relation.value.target_identifier.trim().toUpperCase();
  const generation = projectionGeneration.capture();
  relationTarget.value = null;
  if (!/^CFK-[1-9][0-9]*$/.test(identifier)) return;
  try {
    const target = await apiRequest<IssueDetail>(`/api/v1/issues/${identifier}`);
    if (projectionIsCurrent(generation)) relationTarget.value = target;
  } catch (caught) {
    if (projectionIsCurrent(generation)) setError(caught);
  }
}

async function createRelation(): Promise<void> {
  const current = issue.value;
  if (current === null || !relation.value.target_identifier.trim()) return;
  const fenceKey = `relation-create:${current.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  clearError();
  try {
    const targetIdentifier = relation.value.target_identifier.trim().toUpperCase();
    if (relationTarget.value?.identifier !== targetIdentifier) {
      await previewRelationTarget();
    }
    const target = relationTarget.value;
    if (target === null || target.identifier !== targetIdentifier) return;
    if (!canCreateIssueRelation(current, target)) {
      setLocalizedError(
        "Both Relation endpoints must be in one Workspace and writable in the current Session.",
        "关系两端必须位于同一工作区，且当前会话必须能写入两端项目。",
      );
      return;
    }
    await apiRequest(`/api/v1/issues/${current.identifier}/relations`, {
      body: {
        kind: relation.value.kind,
        source_expected_version: current.version,
        target_expected_version: target.version,
        target_identifier: targetIdentifier,
      },
      method: "POST",
    });
    showRelation.value = false;
    relation.value = { kind: "related", target_identifier: "" };
    relationTarget.value = null;
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`${current.identifier} Relation`, `${current.identifier} 关系`), relation.value)) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function deleteRelation(item: IssueRelation): Promise<void> {
  const fenceKey = `relation-delete:${item.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    const params = new URLSearchParams({
      expected_version: String(item.version),
      source_expected_version: String(item.source.version),
      target_expected_version: String(item.target.version),
    });
    await apiRequest(`/api/v1/relations/${item.id}?${params}`, { method: "DELETE" });
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Relation ${item.id}`, `关系 ${item.id}`), { action: "delete", kind: item.kind })) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function restoreRelation(item: IssueRelation): Promise<void> {
  const fenceKey = `relation-restore:${item.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/relations/${item.id}/commands/restore`, {
      body: {
        expected_version: item.version,
        source_expected_version: item.source.version,
        target_expected_version: item.target.version,
      },
      method: "POST",
    });
    await load();
    await loadCollaborationRecovery();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Relation ${item.id}`, `关系 ${item.id}`), { action: "restore", kind: item.kind }, () => loadCollaborationRecovery(true))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

function backToBoard(): void {
  const current = issue.value;
  if (current === null) return navigate("/app");
  navigate(`/app/w/${encodeURIComponent(current.workspace.id)}/p/${encodeURIComponent(current.project.id)}`);
}

onMounted(load);
onUnmounted(() => {
  projectionGeneration.invalidate();
  loadRequestId += 1;
});
watch(() => projectInventoryBoundary(props.session.allowed_scope.projects), refreshProjectInventory);
watch(() => props.session.allowed_scope.projects, refreshProjectNames, { deep: true });
</script>

<template>
  <main class="issue-page page-shell">
    <PageState :loading="loading" :error="error && !issue ? error : ''" :action-label="t('action.refresh')" @retry="load" />
    <template v-if="issue">
      <button class="back-link button-with-icon" type="button" @click="backToBoard"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4-6 6 6 6M2 10h15" /></svg>{{ t("action.back") }}</button>
      <ErrorNotice v-if="error" :error="error" />
      <CasConflictNotice v-if="casConflict" :busy="busy || casReadbackInFlight" :conflict="casConflict" @dismiss="dismissCasConflict" @refresh="refreshCasFacts" />

      <header class="issue-title-row">
        <div>
          <p class="issue-identifier">{{ issue.identifier }}</p>
          <h1>{{ issue.title }}</h1>
          <p class="issue-subtitle">{{ issue.workspace.display_name }} / {{ issue.project.display_name }} · v{{ issue.version }}</p>
          <div class="issue-summary">
            <span class="status-summary" :data-status="issue.status.key">{{ issue.status.display_name }}</span>
            <span v-if="issue.priority !== 'none'" class="priority-mark" :data-priority="issue.priority">{{ priorityLabel(issue.priority) }}</span>
            <span>{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span>
            <span v-if="issue.is_blocked" class="warning-chip">{{ ui("Blocked", "已阻塞") }}</span>
            <a class="issue-properties-link" href="#issue-properties">{{ locale === 'zh-CN' ? '查看属性' : 'View properties' }}</a>
          </div>
        </div>
        <div class="issue-actions">
          <button v-if="canUpdate" class="secondary-button" type="button" @click="editMode = !editMode">{{ t("action.edit") }}</button>
          <button v-if="canRestore" class="primary-button" type="button" @click="deleteOrRestore">{{ t("action.restore") }}</button>
          <button v-else-if="canDelete" class="text-button muted" type="button" @click="showDelete = true">{{ t("action.delete") }}</button>
        </div>
      </header>

      <section class="issue-layout">
        <div class="issue-main">
          <form v-if="editMode" class="editor-panel form-stack" @submit.prevent="saveEdit">
            <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<input v-model="edit.title" maxlength="256" required /></label>
            <label>{{ t("issue.body") }}<textarea v-model="edit.body" rows="12" /></label>
            <label>{{ t("issue.priority") }}<select v-model="edit.priority_key"><option v-for="key in ['none','low','medium','high','urgent']" :key="key" :value="key">{{ priorityLabel(key as PriorityKey) }}</option></select></label>
            <div class="form-actions"><button class="secondary-button" type="button" @click="editMode = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy">{{ t("action.save") }}</button></div>
          </form>
          <section v-else class="content-section">
            <h2>{{ t("issue.body") }}</h2>
            <MarkdownContent :source="issue.body || ''" />
          </section>

          <IssueAttachments :key="`${session.session_id}:${issue.identifier}`" :identifier="issue.identifier" :can-upload="canUpdate" :session-id="session.session_id" :principal-id="session.principal.id" />

          <section class="content-section">
            <div class="section-heading-row compact">
              <h2>{{ t("issue.activity") }}</h2>
              <span>{{ comments.length }}</span>
            </div>
            <div class="comment-stream">
              <article v-for="entry in comments" :key="entry.id" class="comment-entry" :class="{ completion: entry.kind === 'completion' }">
                <header><strong>{{ entry.author.display_name }}</strong><span>{{ formatTime(entry.created_at) }}</span><span v-if="entry.kind === 'completion'" class="success-chip">{{ locale === "zh-CN" ? "完成记录" : "completion" }}</span><button v-if="entry.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleteComment(entry)">{{ t("action.delete") }}</button></header>
                <CompletionRecord v-if="entry.kind === 'completion'" :value="entry.completion"><MarkdownContent :source="entry.body || ''" /></CompletionRecord>
                <MarkdownContent v-else :source="entry.body || ''" />
              </article>
              <p v-if="!comments.length" class="empty-copy">{{ locale === "zh-CN" ? "还没有评论。" : "No comments yet." }}</p>
            </div>
            <button v-if="commentNextCursor" class="load-more" type="button" :disabled="commentLoadingMore" @click="loadMoreComments">{{ commentLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多活动" : "Load more activity") }}</button>
            <form v-if="canUpdate" class="comment-form" @submit.prevent="addComment">
              <label>{{ t("comment.add") }}<textarea v-model="comment" rows="5" :placeholder="t('comment.placeholder')" /></label>
              <button class="primary-button" type="submit" :disabled="busy || !comment.trim()">{{ t("action.comment") }}</button>
            </form>
          </section>
        </div>

        <aside id="issue-properties" class="issue-sidebar" :aria-label="locale === 'zh-CN' ? '事项属性' : 'Issue properties'">
          <dl class="metadata-list">
            <div><dt>{{ t("issue.status") }}</dt><dd><select v-if="canUpdate" :aria-label="t('issue.status')" :value="issue.status.key" :disabled="busy" @change="onStatusSelection"><option v-for="status in statuses" :key="status.key" :value="status.key">{{ status.display_name }}</option></select><span v-else>{{ issue.status.display_name }}</span></dd></div>
            <div><dt>{{ t("issue.priority") }}</dt><dd>{{ priorityLabel(issue.priority) }}</dd></div>
            <div><dt>{{ t("issue.assignee") }}</dt><dd>
              <AssigneeSelect v-if="canUpdate" :key="`${session.session_id}:${issue.project.id}`" :workspace-id="issue.workspace.id" :project-id="issue.project.id" :assignee="issue.assignee" :disabled="busy" @select="updateIssue({ assignee_principal_id: $event })" />
              <span v-else>{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span>
            </dd></div>
            <div><dt>{{ locale === "zh-CN" ? "更新时间" : "Updated" }}</dt><dd>{{ formatTime(issue.updated_at) }}</dd></div>
          </dl>

          <div v-if="canUpdate" class="sidebar-actions">
            <button v-if="issue.status.key === 'done'" class="secondary-button" type="button" :disabled="busy" @click="updateIssue({ status_key: 'todo' })">{{ ui(`Reopen to ${statusDisplayName("todo")}`, `重新打开到${statusDisplayName("todo")}`) }}</button>
            <button v-else class="primary-button" type="button" :disabled="busy" @click="showComplete = true">{{ t("complete.title") }}</button>
          </div>

          <section v-if="issue.is_blocked || canUpdate" class="sidebar-section issue-blocking">
            <div class="section-heading-row compact"><h2>{{ ui("Blockers", "阻塞情况") }}</h2><span v-if="issue.is_blocked" class="warning-chip">{{ ui("Blocked", "已阻塞") }}</span></div>
            <template v-if="issue.is_blocked">
              <p v-if="issue.blocked_reason" class="blocked-reason">{{ issue.blocked_reason }}</p>
              <p v-else class="muted-copy">{{ ui("An unfinished prerequisite is blocking this Issue. Complete it or remove the blocking relation to unblock.", "此事项正在等待前置事项完成。完成前置事项或移除对应阻塞关系后，会自动解除。") }}</p>
              <button v-if="canUpdate && issue.blocked_reason" class="text-button" type="button" :disabled="busy" @click="runCommand('clear-blocked')">{{ ui("Clear manual blocker", "解除人工阻塞") }}</button>
              <p v-if="issue.blocked_reason" class="muted-copy">{{ ui("Clearing this reason keeps any unfinished prerequisite blockers.", "解除人工阻塞不会移除尚未完成的前置依赖。") }}</p>
              <a v-if="relations.some(item => item.kind === 'blocks' && item.target.identifier === issue?.identifier)" href="#issue-relations">{{ ui("View prerequisite relations", "查看前置依赖") }}</a>
            </template>
            <template v-else>
              <p class="muted-copy">{{ ui("Mark work that cannot continue, such as waiting for information. Its workflow status stays unchanged.", "等待资料等原因导致无法继续时，可标记阻塞；不会改变当前状态。") }}</p>
              <button class="text-button" type="button" :disabled="busy" @click="showBlocked = true">{{ ui("Mark as blocked", "标记阻塞") }}</button>
            </template>
          </section>

          <section class="sidebar-section">
            <div class="section-heading-row compact"><h2>{{ t("issue.labels") }}</h2><button v-if="canUpdate" class="text-button" type="button" @click="showLabelManager = true">{{ locale === "zh-CN" ? "管理" : "Manage" }}</button></div>
            <div class="label-picker">
              <button v-for="label in labels" :key="label.id" class="label-toggle" :class="{ active: issue.labels.some((item) => item.id === label.id) }" type="button" :disabled="!canUpdate || busy" @click="toggleLabel(label.id, !issue.labels.some((item) => item.id === label.id))">{{ label.name }}</button>
              <span v-if="!labels.length" class="muted-copy">—</span>
            </div>
            <button v-if="labelsNextCursor" class="text-button" type="button" :disabled="labelsLoadingMore" @click="loadMoreLabels">{{ labelsLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多标签" : "Load more labels") }}</button>
          </section>

          <section id="issue-relations" class="sidebar-section">
            <div class="section-heading-row compact"><h2>{{ locale === "zh-CN" ? "关系" : "Relations" }}</h2><button v-if="canUpdate" class="text-button" type="button" @click="showRelation = true">+ {{ locale === "zh-CN" ? "添加" : "Add" }}</button></div>
            <div v-for="item in relations" :key="item.id" class="relation-row-wrap"><button class="relation-row" type="button" @click="navigate(`/app/issues/${item.source.identifier === issue.identifier ? item.target.identifier : item.source.identifier}`)"><span>{{ item.kind === "blocks" ? (item.target.identifier === issue.identifier ? ui("Blocked by", "前置依赖") : ui("Blocks", "阻塞下游")) : relationKindLabel(item.kind) }}</span><code>{{ item.source.identifier === issue.identifier ? item.target.identifier : item.source.identifier }}</code></button><button v-if="item.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleteRelation(item)">{{ t("action.delete") }}</button></div>
            <p v-if="!relations.length" class="muted-copy">—</p>
            <button v-if="relationsNextCursor" class="text-button" type="button" :disabled="relationsLoadingMore" @click="loadMoreRelations">{{ relationsLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多关系" : "Load more relations") }}</button>
            <button v-if="canUpdate" class="text-button" type="button" @click="loadCollaborationRecovery()">{{ locale === "zh-CN" ? "恢复已删除的协作项" : "Restore deleted collaboration items" }}</button>
          </section>
        </aside>
      </section>

      <ModalDialog v-if="showComplete" :busy="busy" :title="t('complete.title')" @close="showComplete = false">
        <p class="muted-copy">{{ ui("Confirm to mark this Issue as done. You can add a completion note, or leave it empty.", "确认后将事项设为已完成。可以补充完成说明，也可以留空直接完成。") }}</p>
        <form class="form-stack" @submit.prevent="runCommand('complete', { summary: completionSummary.trim() })"><label>{{ t("complete.summary") }}<textarea v-model="completionSummary" rows="6" maxlength="8192" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showComplete = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy">{{ t("complete.title") }}</button></div></form>
      </ModalDialog>
      <ModalDialog v-if="showBlocked" :busy="busy" :title="ui('Mark as blocked', '标记阻塞')" @close="showBlocked = false">
        <p class="muted-copy">{{ ui("This adds a blocker flag without changing the workflow status. Find these Issues with the Blocked filter on the board.", "这会添加阻塞标记，不改变事项状态。可在看板按“仅阻塞”筛选查找。") }}</p>
        <form class="form-stack" @submit.prevent="runCommand('report-blocked', { reason: blockReason.trim() })"><label>{{ locale === "zh-CN" ? "阻塞原因" : "Reason" }}<textarea v-model="blockReason" required rows="5" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showBlocked = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy || !blockReason.trim()">{{ t("action.save") }}</button></div></form>
      </ModalDialog>
      <ModalDialog v-if="showDelete" :busy="busy" :title="locale === 'zh-CN' ? '删除事项？' : 'Delete issue?'" @close="showDelete = false">
        <p>{{ issue.identifier }} · {{ issue.title }}</p><p class="muted-copy">{{ locale === "zh-CN" ? "这是可恢复的软删除。" : "This is a recoverable soft delete." }}</p><div class="form-actions"><button class="secondary-button" type="button" @click="showDelete = false">{{ t("action.cancel") }}</button><button class="danger-button" type="button" :disabled="busy" @click="deleteOrRestore">{{ t("action.delete") }}</button></div>
      </ModalDialog>
      <ModalDialog v-if="showRelation" :busy="busy" :title="locale === 'zh-CN' ? '添加关系' : 'Add relation'" @close="showRelation = false">
        <form class="form-stack" @submit.prevent="createRelation"><label>{{ locale === "zh-CN" ? "类型" : "Kind" }}<select v-model="relation.kind"><option v-for="key in ['blocks','parent','related','duplicate']" :key="key" :value="key">{{ relationKindLabel(key) }}</option></select></label><label>{{ locale === "zh-CN" ? "目标事项" : "Target Issue" }}<input v-model="relation.target_identifier" required pattern="CFK-[1-9][0-9]*" placeholder="CFK-42" @input="relationTarget = null" @blur="previewRelationTarget" /></label><article v-if="relationTarget" class="target-preview"><small>{{ relationTarget.workspace.display_name }} / {{ relationTarget.project.display_name }}</small><strong>{{ relationTarget.identifier }} · {{ relationTarget.title }}</strong></article><p v-else class="muted-copy">{{ locale === "zh-CN" ? "离开输入框后会先核对目标项目与标题。" : "Leave the field to verify the target Project and title before creating the relation." }}</p><p v-if="relationTarget && !relationTargetCanWrite" class="warning-panel">{{ locale === "zh-CN" ? "关系两端必须位于同一工作区，且当前会话必须能写入两端项目。" : "Both Relation endpoints must be in one Workspace and writable in the current Session." }}</p><div class="form-actions"><button class="secondary-button" type="button" @click="showRelation = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy || !relationTargetCanWrite">{{ t("action.save") }}</button></div></form>
      </ModalDialog>
      <ModalDialog v-if="showLabelManager" :busy="busy" :title="locale === 'zh-CN' ? '管理标签' : 'Manage labels'" @close="showLabelManager = false">
        <form class="form-stack" @submit.prevent="createLabel"><label>{{ locale === "zh-CN" ? "名称" : "Name" }}<input v-model="newLabel.name" required maxlength="64" /></label><label>{{ locale === "zh-CN" ? "颜色（可选）" : "Color (optional)" }}<input v-model="newLabel.color" pattern="#[0-9A-Fa-f]{6}" placeholder="#D97706" /></label><div class="form-actions"><button class="primary-button" type="submit" :disabled="busy">{{ locale === "zh-CN" ? "创建标签" : "Create label" }}</button></div></form>
        <div class="data-list"><div v-for="label in labels" :key="label.id" class="data-row"><span><strong>{{ label.name }}</strong><code>{{ label.color ?? "—" }}</code></span><button v-if="label.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleteLabel(label)">{{ t("action.delete") }}</button></div></div>
      </ModalDialog>
      <ModalDialog v-if="showCollaborationRecovery" :busy="busy" :title="locale === 'zh-CN' ? '恢复协作项' : 'Restore collaboration items'" @close="showCollaborationRecovery = false">
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "评论" : "Comments" }}</h3><div class="data-list"><div v-for="entry in deletedComments" :key="entry.id" class="data-row"><span><code>{{ entry.id }}</code><small>{{ formatTime(entry.deleted_at ?? entry.created_at) }}</small></span><button v-if="entry.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreComment(entry)">{{ t("action.restore") }}</button></div><p v-if="!deletedComments.length" class="empty-copy">—</p><button v-if="deletedCommentsNextCursor" class="load-more" type="button" :disabled="deletedCollectionLoading !== null" @click="loadMoreDeletedComments">{{ deletedCollectionLoading === "comments" ? "…" : (locale === "zh-CN" ? "加载更多已删除评论" : "Load more deleted comments") }}</button></div></section>
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "标签" : "Labels" }}</h3><div class="data-list"><div v-for="label in deletedLabels" :key="label.id" class="data-row"><span><strong>{{ label.name }}</strong><code>{{ label.id }}</code></span><button v-if="label.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreLabel(label)">{{ t("action.restore") }}</button></div><p v-if="!deletedLabels.length" class="empty-copy">—</p><button v-if="deletedLabelsNextCursor" class="load-more" type="button" :disabled="deletedCollectionLoading !== null" @click="loadMoreDeletedLabels">{{ deletedCollectionLoading === "labels" ? "…" : (locale === "zh-CN" ? "加载更多已删除标签" : "Load more deleted labels") }}</button></div></section>
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "关系" : "Relations" }}</h3><div class="data-list"><div v-for="item in deletedRelations" :key="item.id" class="data-row"><span><strong>{{ relationKindLabel(item.kind) }}</strong><code>{{ item.source.identifier }} → {{ item.target.identifier }}</code></span><button v-if="item.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreRelation(item)">{{ t("action.restore") }}</button></div><p v-if="!deletedRelations.length" class="empty-copy">—</p><button v-if="deletedRelationsNextCursor" class="load-more" type="button" :disabled="deletedCollectionLoading !== null" @click="loadMoreDeletedRelations">{{ deletedCollectionLoading === "relations" ? "…" : (locale === "zh-CN" ? "加载更多已删除关系" : "Load more deleted relations") }}</button></div></section>
      </ModalDialog>
    </template>
  </main>
</template>
