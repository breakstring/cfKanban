<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import MarkdownContent from "../components/MarkdownContent.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import type {
  IssueComment,
  IssueDetail,
  IssueRelation,
  LabelResource,
  ListResult,
  PriorityKey,
  StatusKey,
  WebSessionView,
  WriteResult,
} from "../types";

const props = defineProps<{ identifier: string; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();

const issue = ref<IssueDetail | null>(null);
const labels = ref<LabelResource[]>([]);
const deletedLabels = ref<LabelResource[]>([]);
const comments = ref<IssueComment[]>([]);
const commentNextCursor = ref<string | null>(null);
const commentLoadingMore = ref(false);
const deletedComments = ref<IssueComment[]>([]);
const relations = ref<IssueRelation[]>([]);
const deletedRelations = ref<IssueRelation[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
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
const assigneePrincipalId = ref("");
const newLabel = ref({ color: "", name: "" });

const canUpdate = computed(() => issue.value?.allowed_actions.includes("update") ?? false);
const canDelete = computed(() => issue.value?.allowed_actions.includes("delete") ?? false);
const canRestore = computed(() => issue.value?.allowed_actions.includes("restore") ?? false);

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function roleForProject(): string {
  if (props.session.principal.is_owner) return "owner";
  const current = issue.value;
  if (current === null) return "reader";
  return props.session.allowed_scope.projects?.find((item) => (
    item.workspace_key === current.workspace.key && item.project_key === current.project.key
  ))?.role ?? "reader";
}

function mergeComments(...groups: IssueComment[][]): IssueComment[] {
  return [...new Map(groups.flat().map((entry) => [entry.id, entry])).values()].sort((left, right) => (
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  ));
}

async function load(preserveLocalState = editMode.value): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await apiRequest<IssueDetail>(`/api/v1/issues/${encodeURIComponent(props.identifier)}`);
    issue.value = result;
    if (!preserveLocalState) {
      edit.value = { body: result.body ?? "", priority_key: result.priority, title: result.title };
    }
    emit("context", { label: `${result.workspace.key} / ${result.project.display_name}`, role: roleForProject() });
    const [labelResult, commentResult, relationResult] = await Promise.all([
      apiRequest<ListResult<LabelResource>>(
        `/api/v1/workspaces/${encodeURIComponent(result.workspace.key)}/projects/${encodeURIComponent(result.project.key)}/labels?limit=100`,
      ),
      apiRequest<ListResult<IssueComment>>(`/api/v1/issues/${encodeURIComponent(result.identifier)}/comments?limit=100`),
      apiRequest<ListResult<IssueRelation>>(`/api/v1/issues/${encodeURIComponent(result.identifier)}/relations?limit=100`),
    ]);
    labels.value = labelResult.items;
    comments.value = preserveLocalState
      ? mergeComments(comments.value, commentResult.items)
      : commentResult.items;
    commentNextCursor.value = commentResult.has_more ? commentResult.next_cursor : null;
    relations.value = relationResult.items;
  } catch (caught) {
    error.value = errorText(caught);
    if (caught instanceof ApiProblem && (caught.status === 403 || caught.status === 404)) {
      issue.value = null;
      labels.value = [];
      comments.value = [];
      commentNextCursor.value = null;
      relations.value = [];
    }
  } finally {
    loading.value = false;
  }
}

async function loadMoreComments(): Promise<void> {
  const current = issue.value;
  if (current === null || commentNextCursor.value === null) return;
  commentLoadingMore.value = true;
  try {
    const result = await apiRequest<ListResult<IssueComment>>(
      `/api/v1/issues/${encodeURIComponent(current.identifier)}/comments?limit=100&cursor=${encodeURIComponent(commentNextCursor.value)}`,
    );
    comments.value = mergeComments(comments.value, result.items);
    commentNextCursor.value = result.has_more ? result.next_cursor : null;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    commentLoadingMore.value = false;
  }
}

async function refreshCurrentFacts(): Promise<void> {
  const result = await apiRequest<IssueDetail>(`/api/v1/issues/${encodeURIComponent(props.identifier)}`);
  issue.value = result;
  emit("context", { label: `${result.workspace.key} / ${result.project.display_name}`, role: roleForProject() });
}

async function updateIssue(payload: Record<string, unknown>): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await apiRequest<WriteResult<IssueDetail>>(`/api/v1/issues/${current.identifier}`, {
      body: { expected_version: current.version, ...payload },
      method: "PATCH",
    });
    issue.value = result.resource;
    editMode.value = false;
  } catch (caught) {
    error.value = caught instanceof ApiProblem && caught.body.code === "VERSION_CONFLICT"
      ? t("error.conflict")
      : errorText(caught);
    if (caught instanceof ApiProblem && caught.body.code === "VERSION_CONFLICT") {
      try { await refreshCurrentFacts(); } catch { /* Keep the last visible fact and the local draft. */ }
    }
  } finally {
    busy.value = false;
  }
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
  if (current === null) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await apiRequest<WriteResult<IssueDetail & { completion_comment_id?: string }>>(
      `/api/v1/issues/${current.identifier}/commands/${command}`,
      { body: { expected_version: current.version, ...payload }, method: "POST" },
    );
    issue.value = result.resource;
    showComplete.value = false;
    showBlocked.value = false;
    completionSummary.value = "";
    blockReason.value = "";
    if (command === "complete" && result.resource.completion_comment_id) {
      try {
        const completion = await apiRequest<IssueComment>(`/api/v1/comments/${result.resource.completion_comment_id}`);
        comments.value = mergeComments(comments.value, [completion]);
      } catch (caught) {
        error.value = errorText(caught);
      }
    }
  } catch (caught) {
    error.value = caught instanceof ApiProblem && caught.body.code === "VERSION_CONFLICT"
      ? t("error.conflict")
      : errorText(caught);
    if (caught instanceof ApiProblem && caught.body.code === "VERSION_CONFLICT") {
      try { await refreshCurrentFacts(); } catch { /* Keep the command draft for manual recovery. */ }
    }
  } finally {
    busy.value = false;
  }
}

async function deleteOrRestore(): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  busy.value = true;
  try {
    if (current.deleted_at === null) {
      await apiRequest(`/api/v1/issues/${current.identifier}?expected_version=${current.version}`, { method: "DELETE" });
      showDelete.value = false;
      navigate(`/app/w/${encodeURIComponent(current.workspace.key)}/p/${encodeURIComponent(current.project.key)}`);
      return;
    } else {
      await apiRequest(`/api/v1/issues/${current.identifier}/commands/restore`, {
        body: { expected_version: current.version }, method: "POST",
      });
    }
    await load();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function addComment(): Promise<void> {
  const current = issue.value;
  if (current === null || !comment.value.trim()) return;
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<IssueComment>>(`/api/v1/issues/${current.identifier}/comments`, {
      body: { body: comment.value }, method: "POST",
    });
    comment.value = "";
    comments.value = mergeComments(comments.value, [result.resource]);
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function toggleLabel(labelId: string, add: boolean): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/issues/${current.identifier}/commands/${add ? "add-label" : "remove-label"}`, {
      body: { expected_version: current.version, label_id: labelId }, method: "POST",
    });
    await load();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function deleteComment(entry: IssueComment): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/comments/${entry.id}?expected_version=${entry.version}`, { method: "DELETE" });
    comments.value = comments.value.filter((commentEntry) => commentEntry.id !== entry.id);
    await load();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function loadCollaborationRecovery(): Promise<void> {
  const current = issue.value;
  if (current === null) return;
  busy.value = true;
  error.value = "";
  try {
    const [commentResult, labelResult, relationResult] = await Promise.all([
      apiRequest<ListResult<IssueComment>>(`/api/v1/issues/${current.identifier}/comments?deleted=only&limit=100`),
      apiRequest<ListResult<LabelResource>>(
        `/api/v1/workspaces/${encodeURIComponent(current.workspace.key)}/projects/${encodeURIComponent(current.project.key)}/labels?deleted=only&limit=100`,
      ),
      apiRequest<ListResult<IssueRelation>>(`/api/v1/issues/${current.identifier}/relations?deleted=only&limit=100`),
    ]);
    deletedComments.value = commentResult.items;
    deletedLabels.value = labelResult.items;
    deletedRelations.value = relationResult.items;
    showCollaborationRecovery.value = true;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function restoreComment(entry: IssueComment): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/comments/${entry.id}/commands/restore`, {
      body: { expected_version: entry.version }, method: "POST",
    });
    await load();
    await loadCollaborationRecovery();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function createLabel(): Promise<void> {
  const current = issue.value;
  if (current === null || !newLabel.value.name.trim()) return;
  busy.value = true;
  try {
    await apiRequest(
      `/api/v1/workspaces/${encodeURIComponent(current.workspace.key)}/projects/${encodeURIComponent(current.project.key)}/labels`,
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
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function deleteLabel(label: LabelResource): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/labels/${label.id}?expected_version=${label.version}`, { method: "DELETE" });
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function restoreLabel(label: LabelResource): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/labels/${label.id}/commands/restore`, {
      body: { expected_version: label.version }, method: "POST",
    });
    await load();
    await loadCollaborationRecovery();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function previewRelationTarget(): Promise<void> {
  const identifier = relation.value.target_identifier.trim().toUpperCase();
  relationTarget.value = null;
  if (!/^CFK-[1-9][0-9]*$/.test(identifier)) return;
  try {
    relationTarget.value = await apiRequest<IssueDetail>(`/api/v1/issues/${identifier}`);
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function createRelation(): Promise<void> {
  const current = issue.value;
  if (current === null || !relation.value.target_identifier.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    const targetIdentifier = relation.value.target_identifier.trim().toUpperCase();
    if (relationTarget.value?.identifier !== targetIdentifier) {
      await previewRelationTarget();
    }
    const target = relationTarget.value;
    if (target === null || target.identifier !== targetIdentifier) return;
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
    error.value = caught instanceof ApiProblem && caught.body.code === "VERSION_CONFLICT"
      ? t("error.conflict")
      : errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function deleteRelation(item: IssueRelation): Promise<void> {
  busy.value = true;
  try {
    const params = new URLSearchParams({
      expected_version: String(item.version),
      source_expected_version: String(item.source.version),
      target_expected_version: String(item.target.version),
    });
    await apiRequest(`/api/v1/relations/${item.id}?${params}`, { method: "DELETE" });
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function restoreRelation(item: IssueRelation): Promise<void> {
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
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function assignByPrincipalId(): Promise<void> {
  const value = assigneePrincipalId.value.trim();
  if (!value) return;
  await updateIssue({ assignee_principal_id: value });
  if (!error.value) assigneePrincipalId.value = "";
}

function backToBoard(): void {
  const current = issue.value;
  if (current === null) return navigate("/app");
  navigate(`/app/w/${encodeURIComponent(current.workspace.key)}/p/${encodeURIComponent(current.project.key)}`);
}

onMounted(load);
</script>

<template>
  <main class="issue-page page-shell">
    <PageState :loading="loading" :error="error && !issue ? error : ''" :action-label="t('action.refresh')" @retry="load" />
    <template v-if="issue">
      <button class="back-link" type="button" @click="backToBoard">← {{ t("action.back") }}</button>
      <p v-if="error" class="inline-alert" role="alert">{{ error }}</p>

      <header class="issue-title-row">
        <div>
          <p class="issue-identifier">{{ issue.identifier }}</p>
          <h1>{{ issue.title }}</h1>
          <p class="issue-subtitle">{{ issue.workspace.display_name }} / {{ issue.project.display_name }} · v{{ issue.version }}</p>
        </div>
        <div class="issue-actions">
          <button v-if="canUpdate" class="secondary-button" type="button" @click="editMode = !editMode">{{ t("action.edit") }}</button>
          <button v-if="canRestore" class="primary-button" type="button" @click="deleteOrRestore">{{ t("action.restore") }}</button>
          <button v-else-if="canDelete" class="danger-button" type="button" @click="showDelete = true">{{ t("action.delete") }}</button>
        </div>
      </header>

      <section class="issue-layout">
        <div class="issue-main">
          <form v-if="editMode" class="editor-panel form-stack" @submit.prevent="saveEdit">
            <label>{{ locale === "zh-CN" ? "标题" : "Title" }}<input v-model="edit.title" maxlength="256" required /></label>
            <label>{{ t("issue.body") }}<textarea v-model="edit.body" rows="12" /></label>
            <label>{{ t("issue.priority") }}<select v-model="edit.priority_key"><option v-for="key in ['none','low','medium','high','urgent']" :key="key" :value="key">{{ key }}</option></select></label>
            <div class="form-actions"><button class="secondary-button" type="button" @click="editMode = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy">{{ t("action.save") }}</button></div>
          </form>
          <section v-else class="content-section">
            <h2>{{ t("issue.body") }}</h2>
            <MarkdownContent :source="issue.body || ''" />
          </section>

          <section class="content-section">
            <div class="section-heading-row compact">
              <h2>{{ t("issue.activity") }}</h2>
              <span>{{ comments.length }}</span>
            </div>
            <div class="comment-stream">
              <article v-for="entry in comments" :key="entry.id" class="comment-entry" :class="{ completion: entry.kind === 'completion' }">
                <header><strong>{{ entry.author.display_name }}</strong><span>{{ formatTime(entry.created_at) }}</span><span v-if="entry.kind === 'completion'" class="success-chip">{{ locale === "zh-CN" ? "完成记录" : "completion" }}</span><button v-if="entry.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleteComment(entry)">{{ t("action.delete") }}</button></header>
                <MarkdownContent :source="entry.body || ''" />
              </article>
              <p v-if="!comments.length" class="empty-copy">{{ locale === "zh-CN" ? "还没有评论。" : "No comments yet." }}</p>
            </div>
            <button v-if="commentNextCursor" class="load-more" type="button" :disabled="commentLoadingMore" @click="loadMoreComments">{{ commentLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多 Activity" : "Load more activity") }}</button>
            <form v-if="canUpdate" class="comment-form" @submit.prevent="addComment">
              <label>{{ t("comment.add") }}<textarea v-model="comment" rows="5" :placeholder="t('comment.placeholder')" /></label>
              <button class="primary-button" type="submit" :disabled="busy || !comment.trim()">{{ t("action.comment") }}</button>
            </form>
          </section>
        </div>

        <aside class="issue-sidebar">
          <dl class="metadata-list">
            <div><dt>{{ t("issue.status") }}</dt><dd><select v-if="canUpdate" :value="issue.status.key" @change="updateIssue({ status_key: ($event.target as HTMLSelectElement).value as StatusKey })"><option v-for="key in ['backlog','todo','in_progress','canceled']" :key="key" :value="key">{{ key }}</option><option v-if="issue.status.key === 'done'" value="done" disabled>done · {{ locale === "zh-CN" ? "通过完成记录进入" : "entered through completion" }}</option></select><span v-else>{{ issue.status.display_name }}</span></dd></div>
            <div><dt>{{ t("issue.priority") }}</dt><dd>{{ issue.priority }}</dd></div>
            <div><dt>{{ t("issue.assignee") }}</dt><dd>{{ issue.assignee?.display_name ?? t("issue.unassigned") }}<button v-if="canUpdate && issue.assignee" class="text-button" type="button" @click="updateIssue({ assignee_principal_id: null })">{{ locale === "zh-CN" ? "取消指派" : "Unassign" }}</button></dd></div>
            <div><dt>{{ locale === "zh-CN" ? "更新时间" : "Updated" }}</dt><dd>{{ formatTime(issue.updated_at) }}</dd></div>
          </dl>

          <div v-if="canUpdate" class="sidebar-actions">
            <button class="secondary-button" type="button" :disabled="busy" @click="runCommand('assign-to-me')">{{ locale === "zh-CN" ? "指派给我" : "Assign to me" }}</button>
            <form class="compact-inline-form" @submit.prevent="assignByPrincipalId"><input v-model="assigneePrincipalId" required :placeholder="locale === 'zh-CN' ? 'Principal ID' : 'Principal ID'" /><button class="text-button" type="submit" :disabled="busy">{{ locale === "zh-CN" ? "按 ID 指派" : "Assign by ID" }}</button></form>
            <button v-if="issue.status.key === 'done'" class="secondary-button" type="button" :disabled="busy" @click="updateIssue({ status_key: 'todo' })">{{ locale === "zh-CN" ? "重新打开到待办" : "Reopen to todo" }}</button>
            <button v-else class="secondary-button" type="button" :disabled="busy" @click="showComplete = true">{{ t("complete.title") }}</button>
            <button v-if="issue.is_blocked" class="text-button" type="button" :disabled="busy" @click="runCommand('clear-blocked')">{{ locale === "zh-CN" ? "清除阻塞" : "Clear blocked" }}</button>
            <button v-else class="text-button" type="button" :disabled="busy" @click="showBlocked = true">{{ locale === "zh-CN" ? "报告阻塞" : "Report blocked" }}</button>
          </div>

          <section class="sidebar-section">
            <div class="section-heading-row compact"><h2>{{ t("issue.labels") }}</h2><button v-if="canUpdate" class="text-button" type="button" @click="showLabelManager = true">{{ locale === "zh-CN" ? "管理" : "Manage" }}</button></div>
            <div class="label-picker">
              <button v-for="label in labels" :key="label.id" class="label-toggle" :class="{ active: issue.labels.some((item) => item.id === label.id) }" type="button" :disabled="!canUpdate || busy" @click="toggleLabel(label.id, !issue.labels.some((item) => item.id === label.id))">{{ label.name }}</button>
              <span v-if="!labels.length" class="muted-copy">—</span>
            </div>
          </section>

          <section class="sidebar-section">
            <div class="section-heading-row compact"><h2>{{ locale === "zh-CN" ? "Relations（关系）" : "Relations" }}</h2><button v-if="canUpdate" class="text-button" type="button" @click="showRelation = true">+ {{ locale === "zh-CN" ? "添加" : "Add" }}</button></div>
            <div v-for="item in relations" :key="item.id" class="relation-row-wrap"><button class="relation-row" type="button" @click="navigate(`/app/issues/${item.source.identifier === issue.identifier ? item.target.identifier : item.source.identifier}`)"><span>{{ item.kind }}</span><code>{{ item.source.identifier === issue.identifier ? item.target.identifier : item.source.identifier }}</code></button><button v-if="item.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleteRelation(item)">{{ t("action.delete") }}</button></div>
            <p v-if="!relations.length" class="muted-copy">—</p>
            <button v-if="canUpdate" class="text-button" type="button" @click="loadCollaborationRecovery">{{ locale === "zh-CN" ? "恢复已删除的协作项" : "Restore deleted collaboration items" }}</button>
          </section>
        </aside>
      </section>

      <ModalDialog v-if="showComplete" :busy="busy" :title="t('complete.title')" @close="showComplete = false">
        <form class="form-stack" @submit.prevent="runCommand('complete', { summary: completionSummary.trim() })"><label>{{ t("complete.summary") }}<textarea v-model="completionSummary" required rows="6" maxlength="8192" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showComplete = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy || !completionSummary.trim()">{{ t("complete.title") }}</button></div></form>
      </ModalDialog>
      <ModalDialog v-if="showBlocked" :busy="busy" :title="locale === 'zh-CN' ? '报告阻塞' : 'Report blocked'" @close="showBlocked = false">
        <form class="form-stack" @submit.prevent="runCommand('report-blocked', { reason: blockReason.trim() })"><label>{{ locale === "zh-CN" ? "阻塞原因" : "Reason" }}<textarea v-model="blockReason" required rows="5" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showBlocked = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy || !blockReason.trim()">{{ t("action.save") }}</button></div></form>
      </ModalDialog>
      <ModalDialog v-if="showDelete" :busy="busy" :title="locale === 'zh-CN' ? '删除 Issue？' : 'Delete issue?'" @close="showDelete = false">
        <p>{{ issue.identifier }} · {{ issue.title }}</p><p class="muted-copy">{{ locale === "zh-CN" ? "这是可恢复的软删除。" : "This is a recoverable soft delete." }}</p><div class="form-actions"><button class="secondary-button" type="button" @click="showDelete = false">{{ t("action.cancel") }}</button><button class="danger-button" type="button" :disabled="busy" @click="deleteOrRestore">{{ t("action.delete") }}</button></div>
      </ModalDialog>
      <ModalDialog v-if="showRelation" :busy="busy" :title="locale === 'zh-CN' ? '添加 Relation' : 'Add relation'" @close="showRelation = false">
        <form class="form-stack" @submit.prevent="createRelation"><label>{{ locale === "zh-CN" ? "类型" : "Kind" }}<select v-model="relation.kind"><option v-for="key in ['blocks','parent','related','duplicate']" :key="key" :value="key">{{ key }}</option></select></label><label>{{ locale === "zh-CN" ? "目标 Issue" : "Target Issue" }}<input v-model="relation.target_identifier" required pattern="CFK-[1-9][0-9]*" placeholder="CFK-42" @input="relationTarget = null" @blur="previewRelationTarget" /></label><article v-if="relationTarget" class="target-preview"><small>{{ relationTarget.workspace.key }} / {{ relationTarget.project.key }}</small><strong>{{ relationTarget.identifier }} · {{ relationTarget.title }}</strong></article><p v-else class="muted-copy">{{ locale === "zh-CN" ? "离开输入框后会先核对目标 Project 与标题。" : "Leave the field to verify the target Project and title before creating the relation." }}</p><div class="form-actions"><button class="secondary-button" type="button" @click="showRelation = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy || !relationTarget">{{ t("action.save") }}</button></div></form>
      </ModalDialog>
      <ModalDialog v-if="showLabelManager" :busy="busy" :title="locale === 'zh-CN' ? '管理 Labels' : 'Manage labels'" @close="showLabelManager = false">
        <form class="form-stack" @submit.prevent="createLabel"><label>{{ locale === "zh-CN" ? "名称" : "Name" }}<input v-model="newLabel.name" required maxlength="64" /></label><label>{{ locale === "zh-CN" ? "颜色（可选）" : "Color (optional)" }}<input v-model="newLabel.color" pattern="#[0-9A-Fa-f]{6}" placeholder="#2563EB" /></label><div class="form-actions"><button class="primary-button" type="submit" :disabled="busy">{{ locale === "zh-CN" ? "创建 Label" : "Create label" }}</button></div></form>
        <div class="data-list"><div v-for="label in labels" :key="label.id" class="data-row"><span><strong>{{ label.name }}</strong><code>{{ label.color ?? "—" }}</code></span><button v-if="label.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleteLabel(label)">{{ t("action.delete") }}</button></div></div>
      </ModalDialog>
      <ModalDialog v-if="showCollaborationRecovery" :busy="busy" :title="locale === 'zh-CN' ? '恢复协作项' : 'Restore collaboration items'" @close="showCollaborationRecovery = false">
        <section class="recovery-section"><h3>{{ locale === "zh-CN" ? "评论" : "Comments" }}</h3><div class="data-list"><div v-for="entry in deletedComments" :key="entry.id" class="data-row"><span><code>{{ entry.id }}</code><small>{{ formatTime(entry.deleted_at ?? entry.created_at) }}</small></span><button v-if="entry.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreComment(entry)">{{ t("action.restore") }}</button></div><p v-if="!deletedComments.length" class="empty-copy">—</p></div></section>
        <section class="recovery-section"><h3>Labels</h3><div class="data-list"><div v-for="label in deletedLabels" :key="label.id" class="data-row"><span><strong>{{ label.name }}</strong><code>{{ label.id }}</code></span><button v-if="label.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreLabel(label)">{{ t("action.restore") }}</button></div><p v-if="!deletedLabels.length" class="empty-copy">—</p></div></section>
        <section class="recovery-section"><h3>Relations</h3><div class="data-list"><div v-for="item in deletedRelations" :key="item.id" class="data-row"><span><strong>{{ item.kind }}</strong><code>{{ item.source.identifier }} → {{ item.target.identifier }}</code></span><button v-if="item.allowed_actions.includes('restore')" class="secondary-button" type="button" @click="restoreRelation(item)">{{ t("action.restore") }}</button></div><p v-if="!deletedRelations.length" class="empty-copy">—</p></div></section>
      </ModalDialog>
    </template>
  </main>
</template>
