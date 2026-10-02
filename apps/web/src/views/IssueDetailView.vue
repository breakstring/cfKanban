<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";

import AssigneeSelect from "../components/AssigneeSelect.vue";
import CasConflictNotice from "../components/CasConflictNotice.vue";
import CopyButton from "../components/CopyButton.vue";
import IssueShare from "../components/IssueShare.vue";
import CompletionRecord from "../components/CompletionRecord.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import IssueAttachments from "../components/IssueAttachments.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
import { ApiProblem, apiRequest, hasUncertainWrite } from "../lib/api";
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
import { labelNameKey, resolveInputLabel } from "../lib/label-input";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { changedTextFields, useSessionTextDraft, verifySessionTextDraftIdentity } from "../lib/session-drafts";
import { priorityOrder, prioritySaveIsUncertain, priorityText } from "../lib/priority";
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
const emit = defineEmits<{ context: [value: { label: string; role: string; workspaceId?: string; projectId?: string }] }>();

const issue = ref<IssueDetail | null>(null);
const shareOrigin = globalThis.location?.origin;
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
const pendingPriority = ref<{ expected_version: number; priority_key: PriorityKey } | null>(null);
const priorityReadbackFailed = ref(false);
const writeBusy = computed(() => busy.value || pendingPriority.value !== null);
const { clearError, error, setError, setErrorKey, setLocalizedError } = useLocalizedError();
const casConflict = ref<CasConflictState | null>(null);
const editMode = ref(false);
const edit = ref({ body: "", priority_key: "none" as PriorityKey, title: "" });
const comment = ref("");
const completionSummary = ref("");
const showComplete = ref(false);
const showDelete = ref(false);
const showRelation = ref(false);
const showCollaborationRecovery = ref(false);
const labelInput = ref("");
const labelComposing = ref(false);
const relation = ref({ kind: "related", target_identifier: "" });
const relationTarget = ref<IssueDetail | null>(null);
let leavingAfterDeletion = false;

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
protectNavigationDraft(() => !leavingAfterDeletion && (writeBusy.value || (editMode.value && (edit.value.title !== issue.value?.title || edit.value.body !== (issue.value?.body ?? "") || edit.value.priority_key !== issue.value?.priority)) || !!comment.value.trim() || !!completionSummary.value.trim() || !!labelInput.value.trim() || !!relation.value.target_identifier.trim()));
const draftPath = `/app/issues/${props.identifier}`;
const draftCanRestore = () => issue.value?.identifier === props.identifier && issue.value.deleted_at === null && canUpdate.value && !loading.value && !writeBusy.value;
async function readTextDraftIssue(isCurrent: () => boolean): Promise<IssueDetail | null> {
  const latest = await apiRequest<IssueDetail>(`/api/v1/issues/${props.identifier}`, { authorizationCurrent: isCurrent });
  if (!isCurrent() || latest.identifier !== props.identifier || latest.deleted_at !== null || !latest.allowed_actions.includes("update")) return null;
  const verified = await verifySessionTextDraftIdentity(isCurrent);
  return isCurrent() && verified && draftCanRestore() ? latest : null;
}
useSessionTextDraft({
  key: `issue-edit:${props.identifier}`, path: draftPath, label: { en: `${props.identifier} edit`, zh: `${props.identifier} 编辑` },
  capture: () => editMode.value && issue.value ? changedTextFields({ title: [edit.value.title, issue.value.title], body: [edit.value.body, issue.value.body ?? ""] }) : null,
  canRestore: draftCanRestore,
  restore: async (fields, _target, isCurrent) => {
    const latest = await readTextDraftIssue(isCurrent);
    if (!latest || !isCurrent()) return false;
    const local = editMode.value && issue.value ? changedTextFields({ title: [edit.value.title, issue.value.title], body: [edit.value.body, issue.value.body ?? ""] }) : null;
    issue.value = latest; editMode.value = true;
    edit.value = { body: latest.body ?? "", title: latest.title, priority_key: latest.priority, ...local, ...fields };
  },
  uncertain: () => writeFence.active || hasUncertainWrite(`/api/v1/issues/${props.identifier}`),
});
useSessionTextDraft({
  key: `issue-comment:${props.identifier}`, path: draftPath, label: { en: `${props.identifier} comment`, zh: `${props.identifier} 评论` },
  capture: () => comment.value !== "" ? { comment: comment.value } : null,
  canRestore: draftCanRestore, restore: async (fields, _target, isCurrent) => {
    const latest = await readTextDraftIssue(isCurrent); if (!latest || !isCurrent()) return false;
    issue.value = latest; comment.value = fields.comment ?? "";
  },
  uncertain: () => writeFence.active || hasUncertainWrite(`/api/v1/issues/${props.identifier}/comments`),
});
useSessionTextDraft({
  key: `issue-completion:${props.identifier}`, path: draftPath, label: { en: `${props.identifier} completion summary`, zh: `${props.identifier} 完成摘要` },
  capture: () => completionSummary.value !== "" ? { summary: completionSummary.value } : null,
  canRestore: () => draftCanRestore() && issue.value?.status.key !== "done",
  restore: async (fields, _target, isCurrent) => {
    const latest = await readTextDraftIssue(isCurrent); if (!latest || !isCurrent() || latest.status.key === "done") return false;
    issue.value = latest; completionSummary.value = fields.summary ?? ""; showComplete.value = true;
  },
  uncertain: () => writeFence.active || hasUncertainWrite(`/api/v1/issues/${props.identifier}/commands/complete`),
});
const statusMap = computed(() => new Map(statuses.value.map((status) => [status.key, status])));

function statusDisplayName(key: StatusKey): string {
  return statusMap.value.get(key)?.display_name ?? key;
}

function ui(english: string, chinese: string): string {
  return locale.value === "zh-CN" ? chinese : english;
}

function priorityLabel(priority: PriorityKey): string {
  return priorityText(priority, locale.value === "zh-CN");
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
  pendingPriority.value = null;
  priorityReadbackFailed.value = false;
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
  emit("context", { label: `${scope.workspace_display_name} / ${scope.project_display_name}`, role: roleForProject(), workspaceId: scope.workspace_id, projectId: scope.project_id });
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
    emit("context", { label: `${result.workspace.display_name} / ${result.project.display_name}`, role: roleForProject(result), workspaceId: result.workspace.id, projectId: result.project.id });
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
  emit("context", { label: `${result.workspace.display_name} / ${result.project.display_name}`, role: roleForProject(result), workspaceId: result.workspace.id, projectId: result.project.id });
}

async function updateIssue(payload: Record<string, unknown>, closeEditor = false): Promise<void> {
  const current = issue.value;
  if (current === null || busy.value || !canUpdate.value) return;
  if (pendingPriority.value && (payload.expected_version !== pendingPriority.value.expected_version || payload.priority_key !== pendingPriority.value.priority_key)) return;
  const priorityOnly = Object.keys(payload).every(key => key === "priority_key" || key === "expected_version");
  const requestBody = { expected_version: current.version, ...payload };
  const wasPending = pendingPriority.value !== null;
  const fenceKey = `issue-update:${current.id}`;
  if (!writeFence.enter(fenceKey)) return;
  const generation = projectionGeneration.capture();
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<IssueDetail>>(`/api/v1/issues/${current.identifier}`, {
      body: requestBody,
      method: "PATCH",
    });
    if (projectionIsCurrent(generation)) {
      dismissCasConflict();
      issue.value = result.resource;
      priorityReadbackFailed.value = false;
      if (priorityOnly) pendingPriority.value = null;
      if (closeEditor) editMode.value = false;
      else if (edit.value.priority_key === current.priority) edit.value.priority_key = result.resource.priority;
      if (wasPending) await refreshPriorityFacts();
    }
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
    if (priorityOnly) pendingPriority.value = prioritySaveIsUncertain(caught)
      ? { expected_version: requestBody.expected_version as number, priority_key: payload.priority_key as PriorityKey }
      : null;
    if (!await recoverCasConflict(caught, current.identifier, payload, refreshCurrentFacts)) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function refreshPriorityFacts(): Promise<void> {
  const generation = projectionGeneration.capture();
  busy.value = true;
  clearError();
  try {
    await refreshCurrentFacts();
    if (projectionIsCurrent(generation)) priorityReadbackFailed.value = false;
  } catch (caught) {
    if (projectionIsCurrent(generation)) {
      priorityReadbackFailed.value = true;
      setError(caught);
    }
  } finally { busy.value = false; }
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
  }, true);
}

function savePriority(priority: PriorityKey): void {
  if (priority !== issue.value?.priority) void updateIssue({ priority_key: priority });
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
    completionSummary.value = "";
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
        leavingAfterDeletion = true;
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

function onLabelEnter(event: KeyboardEvent): void {
  if (event.isComposing || labelComposing.value || event.keyCode === 229) return;
  event.preventDefault();
  void addInputLabel();
}

async function addInputLabel(): Promise<void> {
  const current = issue.value;
  const name = labelInput.value.trim();
  if (!current || !name || busy.value || !canUpdate.value) return;
  if (Array.from(name).length > 64) {
    setLocalizedError("Use at most 64 characters for a label name.", "标签名称最多 64 个字符。");
    return;
  }
  if (current.labels.some(label => labelNameKey(label.name) === labelNameKey(name))) { labelInput.value = ""; return; }
  const generation = projectionGeneration.capture();
  busy.value = true;
  clearError();
  try {
    const path = `/api/v1/workspaces/${current.workspace.id}/projects/${current.project.id}/labels`;
    const label = await resolveInputLabel(name,
      cursor => apiRequest<ListResult<LabelResource>>(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
      async value => {
        if (!projectionIsCurrent(generation)) throw new Error(ui("Project access changed.", "项目访问权限已变化。"));
        return (await apiRequest<WriteResult<LabelResource>>(path, { method: "POST", body: { name: value } })).resource;
      });
    if (!projectionIsCurrent(generation)) return;
    labels.value = mergePageById(labels.value, [label]);
    await setIssueLabel(current, label.id, true, generation);
    if (projectionIsCurrent(generation)) labelInput.value = "";
  } catch (caught) {
    if (projectionIsCurrent(generation) && !await recoverCasConflict(caught, current.identifier, { label: name })) setError(caught);
  } finally { busy.value = false; }
}

async function setIssueLabel(current: IssueDetail, labelId: string, add: boolean, generation: number): Promise<void> {
  const result = await apiRequest<WriteResult<IssueDetail>>(`/api/v1/issues/${current.identifier}/commands/${add ? "add-label" : "remove-label"}`, {
    body: { expected_version: current.version, label_id: labelId }, method: "POST",
  });
  if (projectionIsCurrent(generation)) issue.value = result.resource;
}

async function toggleLabel(labelId: string, add: boolean): Promise<void> {
  const current = issue.value;
  if (current === null || busy.value || !canUpdate.value) return;
  const generation = projectionGeneration.capture();
  const fenceKey = `issue-label:${current.id}:${labelId}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await setIssueLabel(current, labelId, add, generation);
  } catch (caught) {
    if (!projectionIsCurrent(generation)) return;
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
  if (current === null) { navigate("/app"); return; }
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
  <main class="issue-page page-shell issue-page--nuxt">
    <p v-if="priorityReadbackFailed" class="warning-panel" role="status">{{ ui("Priority was saved, but the latest Issue could not be read. Retry reading the current state.", "优先级已保存，但最新事项读取失败，请重试读取当前状态。") }} <UButton color="neutral" variant="ghost" type="button" :disabled="busy" @click="refreshPriorityFacts">{{ ui("Retry reading", "重试读取") }}</UButton></p>
    <p v-if="pendingPriority" class="warning-panel" role="status">{{ ui("Priority save is unconfirmed. Verify the original operation before continuing.", "优先级保存结果尚未确认，请核实原操作后继续。") }} <UButton color="neutral" variant="ghost" type="button" :disabled="busy || !canUpdate" @click="updateIssue(pendingPriority)">{{ ui("Verify save", "核实保存") }}</UButton></p>
    <PageState :loading="loading" :error="error && !issue ? error : ''" :action-label="t('action.refresh')" @retry="load" />
    <template v-if="issue">
      <UButton color="neutral" variant="ghost" type="button" @click="backToBoard"><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4-6 6 6 6M2 10h15" /></svg>{{ t("action.back") }}</UButton>
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
            <a class="issue-properties-link" href="#issue-properties">{{ locale === 'zh-CN' ? '查看属性' : 'View properties' }}</a>
          </div>
        </div>
        <div class="issue-actions">
          <IssueShare :identifier="issue.identifier" :origin="shareOrigin" />
          <UButton color="neutral" variant="outline" v-if="canUpdate" type="button" @click="editMode = !editMode">{{ t("action.edit") }}</UButton>
          <UButton color="primary" variant="solid" v-if="canRestore" type="button" @click="deleteOrRestore">{{ t("action.restore") }}</UButton>
          <UButton color="neutral" variant="ghost" v-else-if="canDelete" type="button" @click="showDelete = true">{{ t("action.delete") }}</UButton>
        </div>
      </header>

      <section class="issue-layout">
        <div class="issue-main">
          <form v-if="editMode" class="editor-panel form-stack" @submit.prevent="saveEdit">
            <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<UInput v-model="edit.title" maxlength="256" required /></label>
            <label>{{ t("issue.body") }}<UTextarea v-model="edit.body" :rows="12" /></label>
            <label>{{ t("issue.priority") }}<USelect v-model="edit.priority_key" :items="priorityOrder.map(key => ({ value: key, label: priorityLabel(key) }))" :aria-label="t('issue.priority')" /></label>
            <div class="form-actions"><UButton color="neutral" variant="outline" type="button" @click="editMode = false">{{ t("action.cancel") }}</UButton><UButton color="primary" variant="solid" type="submit" :disabled="writeBusy">{{ t("action.save") }}</UButton></div>
          </form>
          <section v-else id="issue-description" class="content-section">
            <div class="section-heading-row"><h2>{{ t("issue.body") }}</h2><CopyButton :value="issue.body || ''" :label="ui('Copy description Markdown', '复制描述 Markdown')" /></div>
            <MarkdownContent :source="issue.body || ''" />
          </section>

          <IssueAttachments :key="`${session.session_id}:${issue.identifier}`" :identifier="issue.identifier" :can-upload="canUpdate" :session-id="session.session_id" :principal-id="session.principal.id" />

          <section id="issue-activity" class="content-section">
            <div class="section-heading-row compact">
              <h2>{{ t("issue.activity") }}</h2>
              <span>{{ comments.length }}</span>
            </div>
            <div class="comment-stream">
              <article v-for="entry in comments" :key="entry.id" class="comment-entry" :class="{ completion: entry.kind === 'completion' }">
                <header><strong>{{ entry.author.display_name }}</strong><span>{{ formatTime(entry.created_at) }}</span><CopyButton :value="entry.body || ''" :label="ui('Copy comment Markdown', '复制评论 Markdown')" /><UBadge v-if="entry.kind === 'completion'" color="success" variant="soft" size="md">{{ locale === "zh-CN" ? "完成记录" : "completion" }}</UBadge><UButton color="error" variant="ghost" v-if="entry.allowed_actions.includes('delete')" type="button" :disabled="writeBusy" @click="deleteComment(entry)">{{ t("action.delete") }}</UButton></header>
                <CompletionRecord v-if="entry.kind === 'completion'" :value="entry.completion"><MarkdownContent :source="entry.body || ''" /></CompletionRecord>
                <MarkdownContent v-else :source="entry.body || ''" />
              </article>
              <p v-if="!comments.length" class="empty-copy">{{ locale === "zh-CN" ? "还没有评论。" : "No comments yet." }}</p>
            </div>
            <UButton color="neutral" variant="ghost" v-if="commentNextCursor" class="load-more" type="button" :disabled="commentLoadingMore" @click="loadMoreComments">{{ commentLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多活动" : "Load more activity") }}</UButton>
            <form v-if="canUpdate" class="comment-form" @submit.prevent="addComment">
              <label>{{ t("comment.add") }}<UTextarea v-model="comment" :rows="5" :placeholder="t('comment.placeholder')" /></label>
              <UButton color="primary" variant="solid" type="submit" :disabled="writeBusy || !comment.trim()">{{ t("action.comment") }}</UButton>
            </form>
          </section>
        </div>

        <aside id="issue-properties" class="issue-sidebar" :aria-label="locale === 'zh-CN' ? '事项属性' : 'Issue properties'">
          <dl class="metadata-list">
            <div><dt>{{ t("issue.status") }}</dt><dd><select v-if="canUpdate" :aria-label="t('issue.status')" :value="issue.status.key" :disabled="writeBusy" @change="onStatusSelection"><option v-for="status in statuses" :key="status.key" :value="status.key">{{ status.display_name }}</option></select><span v-else>{{ issue.status.display_name }}</span></dd></div>
            <div><dt>{{ t("issue.priority") }}</dt><dd><PrioritySelect v-if="canUpdate" :value="issue.priority" :disabled="writeBusy" :label="t('issue.priority')" @change="savePriority" /><span v-else>{{ priorityLabel(issue.priority) }}</span></dd></div>
            <div><dt>{{ t("issue.assignee") }}</dt><dd>
              <AssigneeSelect v-if="canUpdate" :key="`${session.session_id}:${issue.project.id}`" :workspace-id="issue.workspace.id" :project-id="issue.project.id" :assignee="issue.assignee" :disabled="writeBusy" @select="updateIssue({ assignee_principal_id: $event })" />
              <span v-else>{{ issue.assignee?.display_name ?? t("issue.unassigned") }}</span>
            </dd></div>
            <div><dt>{{ locale === "zh-CN" ? "更新时间" : "Updated" }}</dt><dd>{{ formatTime(issue.updated_at) }}</dd></div>
          </dl>

          <div v-if="canUpdate" class="sidebar-actions">
            <UButton color="neutral" variant="outline" v-if="issue.status.key === 'done'" type="button" :disabled="writeBusy" @click="updateIssue({ status_key: 'todo' })">{{ ui(`Reopen to ${statusDisplayName("todo")}`, `重新打开到${statusDisplayName("todo")}`) }}</UButton>
            <UButton color="primary" variant="solid" v-else type="button" :disabled="writeBusy" @click="showComplete = true">{{ t("complete.title") }}</UButton>
          </div>



          <section class="sidebar-section">
            <div class="section-heading-row compact"><h2>{{ t("issue.labels") }}</h2><UButton color="neutral" variant="ghost" v-if="canUpdate" type="button" @click="navigate(`/app/w/${issue.workspace.id}/p/${issue.project.id}/labels`)">{{ ui("Manage", "管理") }}</UButton></div>
            <label v-if="canUpdate" class="label-input">{{ ui("Add label", "添加标签") }}
              <UInput v-model="labelInput" :disabled="writeBusy" :placeholder="ui('Type a name and press Enter', '输入名称后按 Enter 添加')" @compositionstart="labelComposing = true" @compositionend="labelComposing = false" @keydown.enter="onLabelEnter" />
            </label>
            <div v-if="canUpdate && labelInput.trim()" class="label-suggestions">
              <UButton color="neutral" variant="ghost" v-for="label in labels.filter(item => labelNameKey(item.name).includes(labelNameKey(labelInput)) && !issue?.labels.some(added => added.id === item.id)).slice(0, 6)" :key="label.id" type="button" :disabled="writeBusy" @click="labelInput = label.name; addInputLabel()">{{ label.name }}</UButton>
            </div>
            <div class="label-picker">
              <span v-for="label in issue.labels" :key="label.id" class="label-chip" :title="label.name">{{ label.name }}<UButton color="neutral" variant="ghost" v-if="canUpdate" type="button" :disabled="writeBusy" :aria-label="`${ui('Remove label', '移除标签')} ${label.name}`" @click="toggleLabel(label.id, false)">×</UButton></span>
              <span v-if="!issue.labels.length" class="muted-copy">—</span>
            </div>
          </section>

          <section id="issue-relations" class="sidebar-section">
            <div class="section-heading-row compact"><h2>{{ locale === "zh-CN" ? "关系" : "Relations" }}</h2><UButton color="neutral" variant="ghost" v-if="canUpdate" type="button" @click="showRelation = true">+ {{ locale === "zh-CN" ? "添加" : "Add" }}</UButton></div>
            <div v-for="item in relations" :key="item.id" class="relation-row-wrap"><UButton color="neutral" variant="ghost" class="relation-row" type="button" @click="navigate(`/app/issues/${item.source.identifier === issue.identifier ? item.target.identifier : item.source.identifier}`)"><span>{{ item.kind === "blocks" ? (item.target.identifier === issue.identifier ? ui("Blocked by", "前置依赖") : ui("Blocks", "阻塞下游")) : relationKindLabel(item.kind) }}</span><code>{{ item.source.identifier === issue.identifier ? item.target.identifier : item.source.identifier }}</code></UButton><UButton color="error" variant="ghost" v-if="item.allowed_actions.includes('delete')" type="button" :disabled="writeBusy" @click="deleteRelation(item)">{{ t("action.delete") }}</UButton></div>
            <p v-if="!relations.length" class="muted-copy">—</p>
            <UButton color="neutral" variant="ghost" v-if="relationsNextCursor" type="button" :disabled="relationsLoadingMore" @click="loadMoreRelations">{{ relationsLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多关系" : "Load more relations") }}</UButton>
            <UButton color="neutral" variant="ghost" v-if="canUpdate" type="button" @click="loadCollaborationRecovery()">{{ locale === "zh-CN" ? "恢复已删除的协作项" : "Restore deleted collaboration items" }}</UButton>
          </section>
        </aside>
      </section>

      <ModalDialog v-if="showComplete" :busy="busy" :title="t('complete.title')" @close="showComplete = false">
        <p class="muted-copy">{{ ui("Confirm to mark this Issue as done. You can add a completion note, or leave it empty.", "确认后将事项设为已完成。可以补充完成说明，也可以留空直接完成。") }}</p>
        <form class="form-stack" @submit.prevent="runCommand('complete', { summary: completionSummary.trim() })"><label>{{ t("complete.summary") }}<UTextarea v-model="completionSummary" :rows="6" maxlength="8192" /></label><div class="form-actions"><UButton color="neutral" variant="outline" type="button" @click="showComplete = false">{{ t("action.cancel") }}</UButton><UButton color="primary" variant="solid" type="submit" :disabled="writeBusy">{{ t("complete.title") }}</UButton></div></form>
      </ModalDialog>

      <ModalDialog v-if="showDelete" :busy="busy" :title="locale === 'zh-CN' ? '删除事项？' : 'Delete issue?'" @close="showDelete = false">
        <p>{{ issue.identifier }} · {{ issue.title }}</p><p class="muted-copy">{{ locale === "zh-CN" ? "这是可恢复的软删除。" : "This is a recoverable soft delete." }}</p><div class="form-actions"><UButton color="neutral" variant="outline" type="button" @click="showDelete = false">{{ t("action.cancel") }}</UButton><UButton color="error" variant="solid" type="button" :disabled="writeBusy" @click="deleteOrRestore">{{ t("action.delete") }}</UButton></div>
      </ModalDialog>
      <ModalDialog v-if="showRelation" :busy="busy" :title="locale === 'zh-CN' ? '添加关系' : 'Add relation'" @close="showRelation = false">
        <form class="form-stack" @submit.prevent="createRelation"><label>{{ locale === "zh-CN" ? "类型" : "Kind" }}<USelect v-model="relation.kind" :items="['blocks','parent','related','duplicate'].map(key => ({ value: key, label: relationKindLabel(key) }))" /></label><label>{{ locale === "zh-CN" ? "目标事项" : "Target Issue" }}<UInput v-model="relation.target_identifier" required pattern="CFK-[1-9][0-9]*" placeholder="CFK-42" @input="relationTarget = null" @blur="previewRelationTarget" /></label><article v-if="relationTarget" class="target-preview"><small>{{ relationTarget.workspace.display_name }} / {{ relationTarget.project.display_name }}</small><strong>{{ relationTarget.identifier }} · {{ relationTarget.title }}</strong></article><p v-else class="muted-copy">{{ locale === "zh-CN" ? "离开输入框后会先核对目标项目与标题。" : "Leave the field to verify the target Project and title before creating the relation." }}</p><p v-if="relationTarget && !relationTargetCanWrite" class="warning-panel">{{ locale === "zh-CN" ? "关系两端必须位于同一工作区，且当前会话必须能写入两端项目。" : "Both Relation endpoints must be in one Workspace and writable in the current Session." }}</p><div class="form-actions"><UButton color="neutral" variant="outline" type="button" @click="showRelation = false">{{ t("action.cancel") }}</UButton><UButton color="primary" variant="solid" type="submit" :disabled="writeBusy || !relationTargetCanWrite">{{ t("action.save") }}</UButton></div></form>
      </ModalDialog>

      <ModalDialog v-if="showCollaborationRecovery" :busy="busy" :title="locale === 'zh-CN' ? '恢复协作项' : 'Restore collaboration items'" @close="showCollaborationRecovery = false">
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "评论" : "Comments" }}</h3><div class="data-list"><div v-for="entry in deletedComments" :key="entry.id" class="data-row"><span><code>{{ entry.id }}</code><small>{{ formatTime(entry.deleted_at ?? entry.created_at) }}</small></span><UButton color="neutral" variant="outline" v-if="entry.allowed_actions.includes('restore')" type="button" @click="restoreComment(entry)">{{ t("action.restore") }}</UButton></div><p v-if="!deletedComments.length" class="empty-copy">—</p><UButton color="neutral" variant="ghost" v-if="deletedCommentsNextCursor" class="load-more" type="button" :disabled="deletedCollectionLoading !== null" @click="loadMoreDeletedComments">{{ deletedCollectionLoading === "comments" ? "…" : (locale === "zh-CN" ? "加载更多已删除评论" : "Load more deleted comments") }}</UButton></div></section>
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "标签" : "Labels" }}</h3><div class="data-list"><div v-for="label in deletedLabels" :key="label.id" class="data-row"><span><strong>{{ label.name }}</strong><code>{{ label.id }}</code></span><UButton color="neutral" variant="outline" v-if="label.allowed_actions.includes('restore')" type="button" @click="restoreLabel(label)">{{ t("action.restore") }}</UButton></div><p v-if="!deletedLabels.length" class="empty-copy">—</p><UButton color="neutral" variant="ghost" v-if="deletedLabelsNextCursor" class="load-more" type="button" :disabled="deletedCollectionLoading !== null" @click="loadMoreDeletedLabels">{{ deletedCollectionLoading === "labels" ? "…" : (locale === "zh-CN" ? "加载更多已删除标签" : "Load more deleted labels") }}</UButton></div></section>
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "关系" : "Relations" }}</h3><div class="data-list"><div v-for="item in deletedRelations" :key="item.id" class="data-row"><span><strong>{{ relationKindLabel(item.kind) }}</strong><code>{{ item.source.identifier }} → {{ item.target.identifier }}</code></span><UButton color="neutral" variant="outline" v-if="item.allowed_actions.includes('restore')" type="button" @click="restoreRelation(item)">{{ t("action.restore") }}</UButton></div><p v-if="!deletedRelations.length" class="empty-copy">—</p><UButton color="neutral" variant="ghost" v-if="deletedRelationsNextCursor" class="load-more" type="button" :disabled="deletedCollectionLoading !== null" @click="loadMoreDeletedRelations">{{ deletedCollectionLoading === "relations" ? "…" : (locale === "zh-CN" ? "加载更多已删除关系" : "Load more deleted relations") }}</UButton></div></section>
      </ModalDialog>
    </template>
  </main>
</template>

<style scoped>
.issue-page--nuxt { max-width: 1360px; padding-top: 24px; }
.ui-action-icon { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.issue-title-row { padding-top: 24px; padding-bottom: 24px; margin-bottom: 0; border-bottom: 1px solid var(--color-border); gap: 24px; }
.issue-title-row h1 { font-family: var(--font-ui); font-size: clamp(24px, 2.5vw, 32px); line-height: 1.4; font-weight: 650; }
.issue-identifier { margin-bottom: 8px; color: var(--color-text-muted); font-size: 13px; }
.issue-subtitle { margin-top: 10px; font-size: 13px; }
.issue-summary { margin-top: 14px; font-size: 13px; }
.issue-actions { gap: 8px; }
.issue-layout { gap: 32px; margin-top: 28px; }
.issue-main { min-width: 0; }
.issue-sidebar { padding: 20px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface); }
.content-section { margin-bottom: 24px; }
.content-section h2, .sidebar-section h2 { font-size: 14px; font-weight: 650; }
.metadata-list { gap: 16px; }
.metadata-list dt { margin-bottom: 6px; font-size: 12px; }
.metadata-list dd { font-size: 13px; }
.metadata-list select { min-height: 36px; font-size: 13px; }
.sidebar-section { margin-top: 20px; padding-top: 20px; }
.sidebar-actions :deep(button) { width: 100%; justify-content: center; }
.comment-entry { border: 1px solid var(--color-border); border-radius: 10px; padding: 16px; background: var(--color-surface); }
.comment-entry header { gap: 8px 12px; font-size: 12px; }
.comment-entry header > :last-child:is(button) { margin-left: auto; }
.comment-entry.completion { border-color: color-mix(in srgb, var(--color-success) 25%, var(--color-border)); background: var(--color-surface); }
.comment-form { padding: 20px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface); }
.comment-form > label, .editor-panel > label, .label-input { display: grid; gap: 8px; }
.comment-form > :last-child { justify-self: start; }
.comment-form :deep(.relative), .editor-panel :deep(.relative), .label-input :deep(.relative) { width: 100%; }
.editor-panel { padding: 20px; border: 1px solid var(--color-border); border-radius: 12px; }
.label-picker .label-chip { color: var(--color-text-muted); background: var(--color-surface-muted); border-radius: 5px; }
.label-picker .label-chip :deep(button) { min-height: 24px; padding: 0 4px; }
.relation-row { min-width: 0; justify-content: flex-start; }
@media (max-width: 940px) {
  .issue-page--nuxt :deep(button), .issue-page--nuxt :deep(input), .issue-page--nuxt :deep(select) { min-height: 44px; }
  .issue-layout { gap: 20px; }
}
@media (max-width: 640px) {
  .issue-page--nuxt { padding-top: 16px; }
  .issue-title-row { padding-top: 20px; }
  .issue-sidebar, .comment-form, .editor-panel { padding: 16px; }
}
</style>
