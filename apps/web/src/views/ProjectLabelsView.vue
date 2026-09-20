<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import CasConflictNotice from "../components/CasConflictNotice.vue";
import ModalDialog from "../components/ModalDialog.vue";
import { apiRequest } from "../lib/api";
import { captureCasConflict, markCasReadbackComplete, markCasReadbackFailed, type CasConflictState } from "../lib/cas-recovery";
import { locale, t } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor, mergePageById } from "../lib/pagination";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { navigate } from "../lib/router";
import { projectInventoryBoundary } from "../lib/session-boundary";
import type { LabelResource, ListResult, WebSessionView, WriteResult } from "../types";

const props = defineProps<{ workspaceId: string; projectId: string; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();
const labels = ref<LabelResource[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const busy = ref(false);
const editing = ref<LabelResource | null>(null);
const deleting = ref<LabelResource | null>(null);
const draft = ref({ name: "", color: "" });
const conflict = ref<CasConflictState | null>(null);
const conflictLabelId = ref<string | null>(null);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;
let loadGeneration = 0;
const scope = computed(() => props.session.allowed_scope.projects?.find(p => p.project_id === props.projectId && p.workspace_id === props.workspaceId));
const canWrite = computed(() => scope.value?.role === "writer" || scope.value?.role === "owner"
  || (props.session.principal.is_owner && props.session.allowed_scope.projects === undefined));
protectNavigationDraft(() => busy.value || draft.value.name !== (editing.value?.name ?? "") || draft.value.color !== (editing.value?.color ?? ""));
const path = `/api/v1/workspaces/${props.workspaceId}/projects/${props.projectId}/labels`;
const ui = (en: string, zh: string): string => locale.value === "zh-CN" ? zh : en;

async function load(reset = true): Promise<void> {
  if (loading.value && !reset) return;
  const current = generation;
  const request = ++loadGeneration;
  const isCurrent = () => current === generation && request === loadGeneration;
  if (reset) cursor.value = null;
  loading.value = true;
  clearError();
  try {
    const result = await apiRequest<ListResult<LabelResource>>(`${path}?limit=50${!reset && cursor.value ? `&cursor=${encodeURIComponent(cursor.value)}` : ""}`);
    if (!isCurrent()) return;
    labels.value = mergePageById(labels.value, result.items, reset);
    cursor.value = continuationCursor(result);
    const project = result.items[0]?.project;
    emit("context", { label: `${scope.value?.workspace_display_name ?? project?.workspace_display_name ?? ""} / ${scope.value?.project_display_name ?? project?.display_name ?? ""}`, role: scope.value?.role ?? "owner" });
    if (conflict.value && conflictLabelId.value) {
      const latest = await apiRequest<LabelResource>(`/api/v1/labels/${conflictLabelId.value}`);
      if (!isCurrent()) return;
      labels.value = mergePageById(labels.value, [latest]);
      conflict.value = markCasReadbackComplete(conflict.value);
    }
  } catch (caught) {
    if (!isCurrent()) return;
    setError(caught);
    if (conflict.value) conflict.value = markCasReadbackFailed(conflict.value);
  } finally { if (isCurrent()) loading.value = false; }
}

function editLabel(label: LabelResource): void {
  editing.value = label;
  draft.value = { name: label.name, color: label.color ?? "" };
  conflict.value = null;
}

async function save(): Promise<void> {
  if (busy.value || !canWrite.value || !draft.value.name.trim() || conflict.value) return;
  const label = editing.value;
  if (label && !label.allowed_actions.includes("update")) return;
  const current = generation;
  const body = { name: draft.value.name.trim(), color: draft.value.color || null, ...(label ? { expected_version: label.version } : {}) };
  busy.value = true;
  clearError();
  try {
    await apiRequest<WriteResult<LabelResource>>(label ? `/api/v1/labels/${label.id}` : path, { method: label ? "PATCH" : "POST", body });
    if (current !== generation) return;
    editing.value = null;
    draft.value = { name: "", color: "" };
    await load();
  } catch (caught) {
    if (current !== generation) return;
    setError(caught);
    conflict.value = captureCasConflict(caught, label?.name ?? body.name, body);
    conflictLabelId.value = label?.id ?? null;
    if (conflict.value) await load();
  } finally { if (current === generation) busy.value = false; }
}

async function deleteLabel(): Promise<void> {
  const label = deleting.value;
  if (!label || busy.value || !canWrite.value || !label.allowed_actions.includes("delete")) return;
  const current = generation;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/labels/${label.id}?expected_version=${label.version}`, { method: "DELETE" });
    if (current !== generation) return;
    deleting.value = null;
    if (editing.value?.id === label.id) { editing.value = null; draft.value = { name: "", color: "" }; }
    await load();
  } catch (caught) {
    if (current !== generation) return;
    deleting.value = null;
    setError(caught);
    conflict.value = captureCasConflict(caught, label.name, { action: "delete", label_id: label.id });
    conflictLabelId.value = label.id;
    if (conflict.value) await load();
  } finally { if (current === generation) busy.value = false; }
}

function acceptLatest(): void {
  const latest = labels.value.find(item => item.id === editing.value?.id);
  if (latest) editing.value = latest;
  conflict.value = null;
  conflictLabelId.value = null;
}

watch(() => projectInventoryBoundary(props.session.allowed_scope.projects), () => {
  generation += 1;
  labels.value = []; cursor.value = null; loading.value = false; busy.value = false;
  if (scope.value || props.session.allowed_scope.projects === undefined) void load();
});
onMounted(() => load());
onUnmounted(() => { generation += 1; });
</script>

<template>
  <main class="page-shell labels-page">
    <button class="text-button" type="button" @click="navigate(`/app/w/${workspaceId}/p/${projectId}`)">← {{ ui("Back to board", "返回看板") }}</button>
    <h1>{{ ui("Project labels", "项目标签管理") }}</h1>
    <ErrorNotice v-if="error" :error="error" />
    <CasConflictNotice v-if="conflict" :conflict="conflict" :busy="loading || busy" @refresh="load()" @dismiss="acceptLatest" />
    <form v-if="canWrite" class="form-stack" @submit.prevent="save">
      <h2>{{ editing ? ui("Edit label", "编辑标签") : ui("Create label", "创建标签") }}</h2>
      <label>{{ ui("Name", "名称") }}<input v-model="draft.name" required :disabled="busy" /></label>
      <label>{{ ui("Color (optional)", "颜色（可选）") }}<input v-model="draft.color" pattern="#[0-9A-Fa-f]{6}" placeholder="#B84708" :disabled="busy" /></label>
      <div class="form-actions"><button v-if="editing" class="text-button" type="button" :disabled="busy" @click="editing = null; draft = { name: '', color: '' }; conflict = null">{{ t("action.cancel") }}</button><button class="primary-button" type="submit" :disabled="busy || !!conflict">{{ t("action.save") }}</button></div>
    </form>
    <div class="data-list">
      <div v-for="label in labels" :key="label.id" class="data-row"><span><strong>{{ label.name }}</strong><code>{{ label.color ?? '—' }}</code></span><div class="form-actions"><button v-if="canWrite && label.allowed_actions.includes('update')" class="text-button" type="button" :disabled="busy" @click="editLabel(label)">{{ ui("Edit", "编辑") }}</button><button v-if="canWrite && label.allowed_actions.includes('delete')" class="danger-text-button" type="button" :disabled="busy" @click="deleting = label">{{ t("action.delete") }}</button></div></div>
      <p v-if="!labels.length && !loading">{{ ui("No labels", "暂无标签") }}</p>
    </div>
    <button v-if="cursor || error" class="load-more" type="button" :disabled="loading" @click="load(!cursor)">{{ ui("Load more / retry", "加载更多 / 重试") }}</button>
    <p v-if="loading" role="status">{{ ui("Loading…", "加载中…") }}</p>
    <ModalDialog v-if="deleting" :title="ui('Delete project label', '删除项目标签')" :busy="busy" @close="deleting = null">
      <p>{{ deleting.name }} — {{ ui("This hides the shared label on all project issues. It can be restored from an issue's collaboration recovery.", "这会隐藏项目所有事项中的共享标签，可从事项的协作项恢复入口恢复。") }}</p>
      <button class="danger-text-button" type="button" :disabled="busy" @click="deleteLabel">{{ t("action.delete") }}</button>
    </ModalDialog>
  </main>
</template>
