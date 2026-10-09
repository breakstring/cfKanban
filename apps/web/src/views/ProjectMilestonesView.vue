<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import ModalDialog from "../components/ModalDialog.vue";
import { ApiProblem, apiRequest, errorText, hasUncertainWrite } from "../lib/api";
import { boardFilters, boardPath, boardReturnPath } from "../lib/board-navigation";
import { captureCasConflict, markCasReadbackComplete, markCasReadbackFailed, type CasConflictState } from "../lib/cas-recovery";
import { ColumnPagination } from "../lib/column-pagination";
import { locale, t } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { isMilestoneWriteResult } from "../lib/milestones";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { mergePageById } from "../lib/pagination";
import { prioritySaveIsUncertain } from "../lib/priority";
import { navigate } from "../lib/router";
import { isVerifiedServiceAccessFailure, sessionBoundaryKey, sessionCanWriteProject } from "../lib/session-boundary";
import { changedTextFields, useSessionTextDraft, verifySessionTextDraftIdentity } from "../lib/session-drafts";
import type { ContainerResource, ListResult, MilestoneResource, WebSessionView, WriteResult } from "../types";

const props = defineProps<{ workspaceId: string; projectId: string; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();
const page = reactive(new ColumnPagination<MilestoneResource>());
const project = ref<ContainerResource | null>(null);
const status = ref<"all" | "open" | "closed">("all");
const busy = ref(false);
const showEditor = ref(false);
const editing = ref<MilestoneResource | null>(null);
const draft = ref({ title: "", description: "", due_date: "" });
const conflict = ref<CasConflictState | null>(null);
const conflictId = ref<string | null>(null);
const pending = ref<{ path: string; method: "POST" | "PATCH"; body: Record<string, unknown>; closesEditor: boolean } | null>(null);
const { error, clearError, setError, setLocalizedError } = useLocalizedError();
let generation = 0;
let projectRequest = 0;
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const scope = computed(() => props.session.allowed_scope.projects?.find(item => item.workspace_id === props.workspaceId && item.project_id === props.projectId));
const active = computed(() => props.session.allowed_scope.projects === undefined || scope.value !== undefined);
const canWrite = computed(() => active.value && project.value?.deleted_at === null && sessionCanWriteProject(props.session, props.workspaceId, props.projectId));
const collectionPath = `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/milestones`;
const returnTo = boardReturnPath(props.workspaceId, props.projectId, window.location.search);
const boardView = computed(() => boardFilters(new URL(returnTo, window.location.origin).search));
const boardOnly = computed(() => { const { view: _view, ...filters } = boardView.value; return filters; });
const dirty = computed(() => showEditor.value && (draft.value.title !== (editing.value?.title ?? "") || draft.value.description !== (editing.value?.description ?? "") || draft.value.due_date !== (editing.value?.due_date ?? "")));
protectNavigationDraft(() => busy.value || pending.value !== null || conflict.value !== null || dirty.value);
useSessionTextDraft({
  key: `milestone-text:${props.workspaceId}:${props.projectId}`, path: `/app/w/${props.workspaceId}/p/${props.projectId}/milestones`,
  label: { en: "Milestone", zh: "里程碑" }, target: () => ({ milestoneId: editing.value?.id ?? "" }),
  capture: () => showEditor.value ? changedTextFields({ title: [draft.value.title, editing.value?.title ?? ""], description: [draft.value.description, editing.value?.description ?? ""], due_date: [draft.value.due_date, editing.value?.due_date ?? ""] }) : null,
  canRestore: () => canWrite.value && !busy.value && !page.loading,
  restore: async (fields, target, isCurrent) => {
    const verified = await verifySessionTextDraftIdentity(isCurrent);
    if (!isCurrent() || !verified || !sessionCanWriteProject(verified, props.workspaceId, props.projectId)) return false;
    const currentProject = await apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`, { authorizationCurrent: isCurrent });
    if (!isCurrent() || currentProject.deleted_at !== null) return false;
    project.value = currentProject;
    const latest = target.milestoneId ? await apiRequest<MilestoneResource>(`/api/v1/milestones/${encodeURIComponent(target.milestoneId)}`, { authorizationCurrent: isCurrent }) : null;
    if (!isCurrent() || (latest && (latest.project_id !== props.projectId || latest.workspace_id !== props.workspaceId || !latest.allowed_actions.includes("update")))) return false;
    openEditor(latest); draft.value = { ...draft.value, ...fields };
  },
  uncertain: () => busy.value || pending.value !== null || hasUncertainWrite(editing.value ? `/api/v1/milestones/${editing.value.id}` : collectionPath),
});

async function load(reset = true): Promise<void> {
  if (!active.value) return;
  const current = generation;
  const isCurrent = () => current === generation && active.value;
  const request = ++projectRequest;
  if (reset) clearError();
  await Promise.all([
    page.load(cursor => {
      const params = new URLSearchParams({ limit: "20" });
      if (status.value !== "all") params.set("status", status.value);
      if (cursor) params.set("cursor", cursor);
      return apiRequest<ListResult<MilestoneResource>>(`${collectionPath}?${params}`, { authorizationCurrent: isCurrent });
    }, reset).then(() => {
      if (!isCurrent() || !(page.error instanceof ApiProblem) || !isVerifiedServiceAccessFailure(page.error.status, page.error.body)) return;
      const caught = page.error; page.reset(); page.error = caught;
    }),
    (async () => {
      try {
        const result = await apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`, { authorizationCurrent: isCurrent });
        if (!isCurrent() || request !== projectRequest) return;
        project.value = result;
        emit("context", { label: `${result.workspace_display_name ?? scope.value?.workspace_display_name ?? ""} / ${result.display_name}`, role: scope.value?.role ?? "owner" });
      } catch (caught) { if (isCurrent() && request === projectRequest) { project.value = null; setError(caught); } }
    })(),
  ]);
}
function openEditor(item: MilestoneResource | null = null): void {
  if (busy.value || pending.value !== null || !canWrite.value || (item && !item.allowed_actions.includes("update"))) return;
  editing.value = item;
  draft.value = { title: item?.title ?? "", description: item?.description ?? "", due_date: item?.due_date ?? "" };
  conflict.value = null; conflictId.value = null; showEditor.value = true;
}
function closeEditor(): void { if (!busy.value && pending.value === null) { showEditor.value = false; editing.value = null; conflict.value = null; } }
async function refreshConflict(): Promise<void> {
  const captured = conflict.value;
  const id = conflictId.value;
  if (!captured || !id || !active.value) return;
  const current = generation;
  try {
    const latest = await apiRequest<MilestoneResource>(`/api/v1/milestones/${encodeURIComponent(id)}`, { authorizationCurrent: () => current === generation && active.value });
    if (current !== generation || conflict.value !== captured) return;
    page.items = status.value === "all" || status.value === latest.status_key ? mergePageById(page.items, [latest]) : page.items.filter(item => item.id !== latest.id);
    if (editing.value?.id === latest.id) editing.value = latest;
    conflict.value = markCasReadbackComplete(captured);
  } catch { if (current === generation && conflict.value === captured) conflict.value = markCasReadbackFailed(captured); }
}
function dismissConflict(): void { if (conflict.value?.readbackState === "complete") { conflict.value = null; conflictId.value = null; } }
async function write(intent: { path: string; method: "POST" | "PATCH"; body: Record<string, unknown>; closesEditor: boolean }): Promise<void> {
  if (busy.value || !canWrite.value || conflict.value) return;
  if (pending.value && pending.value !== intent) return;
  const current = generation;
  busy.value = true; clearError();
  try {
    const result = await apiRequest<WriteResult<MilestoneResource>>(intent.path, { method: intent.method, body: intent.body, validateResponse: value => isMilestoneWriteResult(value, props.workspaceId, props.projectId) });
    if (current !== generation) return;
    pending.value = null;
    if (intent.closesEditor) closeEditorAfterSave();
    page.items = mergePageById(page.items, [result.resource]);
    await load();
  } catch (caught) {
    if (current !== generation) return;
    pending.value = prioritySaveIsUncertain(caught) ? intent : null;
    setError(caught);
    conflict.value = captureCasConflict(caught, ui("Milestone", "里程碑"), intent.body);
    conflictId.value = intent.method === "PATCH" ? intent.path.split("/").at(-1) ?? null : null;
    if (conflict.value) await refreshConflict();
  } finally { if (current === generation) busy.value = false; }
}
function closeEditorAfterSave(): void { showEditor.value = false; editing.value = null; draft.value = { title: "", description: "", due_date: "" }; conflict.value = null; conflictId.value = null; }
async function save(): Promise<void> {
  if (pending.value || !draft.value.title.trim() || (editing.value && !editing.value.allowed_actions.includes("update"))) return;
  if (new TextEncoder().encode(draft.value.description).length > 8192) { setLocalizedError("Description must be at most 8 KiB.", "描述不得超过 8 KiB。"); return; }
  const item = editing.value;
  await write({ path: item ? `/api/v1/milestones/${encodeURIComponent(item.id)}` : collectionPath, method: item ? "PATCH" : "POST", body: { title: draft.value.title.trim(), description: draft.value.description, due_date: draft.value.due_date || null, ...(item ? { expected_version: item.version } : {}) }, closesEditor: true });
}
function changeStatus(item: MilestoneResource): void {
  if (!item.allowed_actions.includes("update") || pending.value) return;
  void write({ path: `/api/v1/milestones/${encodeURIComponent(item.id)}`, method: "PATCH", body: { expected_version: item.version, status_key: item.status_key === "open" ? "closed" : "open" }, closesEditor: false });
}
function viewIssues(item: MilestoneResource): void {
  navigate(boardPath(props.workspaceId, props.projectId, { search: "", priorities: [], labels: [], milestone: item.id, view: "list", expanded: ["backlog", "todo", "in_progress", "done", "canceled"] }));
}
watch(status, () => { generation += 1; void load(); });
watch(() => sessionBoundaryKey(props.session), () => {
  generation += 1; projectRequest += 1; project.value = null; page.reset(); busy.value = false; clearError();
  if (active.value) void load();
});
onMounted(() => load());
onUnmounted(() => { generation += 1; projectRequest += 1; page.reset(); });
</script>

<template>
  <main class="page-shell milestones-page">
    <header class="milestones-header"><div><p class="eyebrow">{{ project?.workspace_display_name }}</p><h1>{{ project?.display_name ?? scope?.project_display_name }} · {{ ui('Milestones', '里程碑') }}</h1></div><UButton v-if="canWrite" color="primary" type="button" :disabled="busy || !!pending || !!conflict" @click="openEditor()">{{ ui('New milestone', '新建里程碑') }}</UButton></header>
    <div class="milestones-toolbar"><div class="milestone-views" role="group" :aria-label="ui('Project view', '项目视图')"><UButton color="neutral" variant="ghost" type="button" @click="navigate(boardPath(workspaceId, projectId, boardOnly))">{{ ui('Board', '看板') }}</UButton><UButton color="neutral" variant="ghost" type="button" @click="navigate(boardPath(workspaceId, projectId, { ...boardView, view: 'list' }))">{{ ui('List', '列表') }}</UButton><span aria-current="page">{{ ui('Milestones', '里程碑') }}</span></div><USelect v-model="status" :disabled="busy || !!pending" :items="[{ value: 'all', label: ui('All milestones', '全部里程碑') }, { value: 'open', label: ui('Open', '开放') }, { value: 'closed', label: ui('Closed', '已关闭') }]" :aria-label="ui('Milestone status', '里程碑状态')" /><UButton color="neutral" variant="ghost" type="button" :disabled="page.loading || busy" @click="load()">{{ ui('Refresh', '刷新') }}</UButton></div>
    <p class="muted-copy">{{ ui('Milestones are optional delivery goals for this project. Issues may remain unassigned; parent and child Issues have independent assignments.', '里程碑是本项目可选的交付目标。事项可以不归属里程碑；父子事项各自设置归属。') }}</p>
    <ErrorNotice v-if="error" :error="error" />
    <ErrorNotice v-if="page.error" :error="errorText(page.error)" />
    <p v-if="pending && !showEditor" class="warning-panel" role="status">{{ ui('Save is unconfirmed. Verify the original operation before continuing.', '保存结果尚未确认，请核实原操作后继续。') }} <UButton color="neutral" variant="ghost" :disabled="busy || !canWrite" @click="write(pending!)">{{ ui('Verify save', '核实保存') }}</UButton></p>
    <CasConflictNotice v-if="conflict && !showEditor" :conflict="conflict" :busy="busy" @refresh="refreshConflict" @dismiss="dismissConflict" />
    <div class="milestone-list">
      <article v-for="item in page.items" :key="item.id" class="milestone-row"><div class="milestone-heading"><h2>{{ item.title }}</h2><span>{{ item.status_key === 'closed' ? ui('Closed', '已关闭') : ui('Open', '开放') }}</span><span>{{ ui('Target date', '目标日期') }}: {{ item.due_date ?? ui('Not set', '未设置') }}</span></div><MarkdownContent v-if="item.description" :source="item.description" /><dl class="milestone-progress"><div><dt>{{ ui('Total', '总数') }}</dt><dd>{{ item.progress.total }}</dd></div><div><dt>{{ ui('Done', '已完成') }}</dt><dd>{{ item.progress.done }}</dd></div><div><dt>{{ ui('Unfinished', '未完成') }}</dt><dd>{{ item.progress.unfinished }}</dd></div><div><dt>{{ ui('Canceled', '已取消') }}</dt><dd>{{ item.progress.canceled }}</dd></div></dl><div class="form-actions"><UButton color="neutral" variant="outline" type="button" @click="viewIssues(item)">{{ ui('View Issues', '查看事项') }}</UButton><UButton v-if="canWrite && item.allowed_actions.includes('update')" color="neutral" variant="ghost" type="button" :disabled="busy || !!pending || !!conflict" @click="openEditor(item)">{{ ui('Edit', '编辑') }}</UButton><UButton v-if="canWrite && item.allowed_actions.includes('update')" color="neutral" variant="ghost" type="button" :disabled="busy || !!pending || !!conflict" @click="changeStatus(item)">{{ item.status_key === 'open' ? ui('Close milestone', '关闭里程碑') : ui('Reopen milestone', '重新开放') }}</UButton></div></article>
    </div>
    <p v-if="page.loading" role="status">{{ ui('Loading milestones…', '正在加载里程碑…') }}</p><p v-else-if="page.loaded && !page.items.length && !page.error" class="empty-copy">{{ ui('No matching milestones. Issues can be used without milestones.', '暂无匹配的里程碑，事项可以独立使用。') }}</p><UButton v-if="page.cursor || page.error" color="neutral" variant="outline" type="button" :disabled="page.loading" @click="load(!page.cursor)">{{ page.error ? ui('Retry', '重试') : ui('Load more', '加载更多') }}</UButton>
    <ModalDialog v-if="showEditor" :title="editing ? ui('Edit milestone', '编辑里程碑') : ui('New milestone', '新建里程碑')" :busy="busy || !!pending" @close="closeEditor">
      <ErrorNotice v-if="error" :error="error" /><CasConflictNotice v-if="conflict" :conflict="conflict" :busy="busy" @refresh="refreshConflict" @dismiss="dismissConflict" />
      <p v-if="pending" class="warning-panel" role="status">{{ ui('Save is unconfirmed. Verify the original operation before continuing.', '保存结果尚未确认，请核实原操作后继续。') }} <UButton color="neutral" variant="ghost" :disabled="busy || !canWrite" @click="write(pending!)">{{ ui('Verify save', '核实保存') }}</UButton></p>
      <form class="form-stack" @submit.prevent="save"><label>{{ ui('Title', '名称') }}<UInput v-model="draft.title" required maxlength="200" :disabled="busy || !!pending || !canWrite" /></label><label>{{ ui('Description', '目标说明') }}<UTextarea v-model="draft.description" :rows="6" :disabled="busy || !!pending || !canWrite" /></label><label>{{ ui('Target date (optional)', '目标日期（可选）') }}<UInput v-model="draft.due_date" type="date" :disabled="busy || !!pending || !canWrite" /></label><p class="muted-copy">{{ ui('Closing a milestone does not change Issue status or membership.', '关闭里程碑不会修改事项状态或归属。') }}</p><div class="form-actions"><UButton color="neutral" variant="outline" type="button" :disabled="busy || !!pending" @click="closeEditor">{{ t('action.cancel') }}</UButton><UButton color="primary" type="submit" :disabled="busy || !!pending || !!conflict || !canWrite">{{ t('action.save') }}</UButton></div></form>
    </ModalDialog>
  </main>
</template>

<style scoped>
.milestones-page { max-width: 1100px; }
.milestones-header, .milestones-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.milestones-header h1 { margin: 0; font-size: 24px; }
.milestones-toolbar { justify-content: flex-start; padding-block: 12px; margin-top: 12px; border-top: 1px solid var(--color-border); }
.milestone-views { display: flex; align-items: center; gap: 12px; }
.milestone-views > span { color: var(--color-primary); font-weight: 600; }
.milestone-list { display: grid; gap: 0; }
.milestone-row { padding-block: 20px; border-bottom: 1px solid var(--color-border); }
.milestone-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
.milestone-heading h2 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
.milestone-heading span { font-size: 13px; color: var(--color-text-muted); }
.milestone-progress { display: flex; flex-wrap: wrap; gap: 16px; margin-block: 12px; }
.milestone-progress > div { display: flex; gap: 8px; font-size: 13px; }
.milestone-progress dt { color: var(--color-text-muted); }
.milestone-progress dd { margin: 0; font-weight: 600; }
</style>
