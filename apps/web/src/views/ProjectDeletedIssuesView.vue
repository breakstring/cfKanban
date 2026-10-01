<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import ProjectSettingsHeader from "../components/ProjectSettingsHeader.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { captureCasConflict, markCasReadbackComplete, markCasReadbackFailed, type CasConflictState } from "../lib/cas-recovery";
import { locale, t } from "../lib/i18n";
import { localizedText, useLocalizedError } from "../lib/localized-error";
import { protectNavigationDraft } from "../lib/navigation-draft";
import { continuationCursor, cursorRequiresRestart, mergePageById } from "../lib/pagination";
import { projectInventoryBoundary } from "../lib/session-boundary";
import { WriteFence } from "../lib/write-fence";
import type { ContainerResource, IssueTombstone, ListResult, WebSessionView } from "../types";

const props = defineProps<{ workspaceId: string; projectId: string; session: WebSessionView; returnTo?: string }>();
const emit = defineEmits<{ navigate: [path: string]; context: [value: { label: string; role: string }] }>();
const project = ref<ContainerResource | null>(null);
const issues = ref<IssueTombstone[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const busy = ref(false);
const loaded = ref(false);
const conflict = ref<CasConflictState | null>(null);
const { error, clearError, setError, setLocalizedError } = useLocalizedError();
const writeFence = new WriteFence();
let generation = 0;
let loadRequest = 0;
let casRecoveryGeneration = 0;
const scope = computed(() => props.session.allowed_scope.projects?.find(item => item.workspace_id === props.workspaceId && item.project_id === props.projectId));
const role = computed(() => scope.value?.role ?? (props.session.principal.is_owner && props.session.allowed_scope.projects === undefined ? "owner" : null));
const canWrite = computed(() => role.value === "writer" || role.value === "owner");
const backPath = computed(() => props.returnTo ?? `/app/w/${props.workspaceId}/p/${props.projectId}`);
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
protectNavigationDraft(() => writeFence.active);

function dismissConflict(): void {
  casRecoveryGeneration += 1;
  conflict.value = null;
}

function clearProjection(): void {
  generation += 1;
  loadRequest += 1;
  project.value = null;
  issues.value = [];
  cursor.value = null;
  loaded.value = false;
  loading.value = false;
  dismissConflict();
}

async function load(): Promise<void> {
  clearProjection();
  clearError();
  if (!canWrite.value) {
    setLocalizedError("You need project write access to view deleted issues.", "查看已删除事项需要项目写入权限。");
    return;
  }
  const current = generation;
  loading.value = true;
  try {
    const result = await apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`);
    if (current !== generation || !canWrite.value) return;
    if (result.deleted_at !== null) {
      setLocalizedError("Restore the project before restoring its issues.", "请先恢复所属项目，再恢复事项。");
      return;
    }
    project.value = result;
    emit("context", { label: `${result.workspace_display_name ?? ""} / ${result.display_name}`, role: role.value! });
    await loadDeleted(true);
  } catch (caught) {
    if (current === generation) setError(caught);
  } finally {
    if (current === generation) loading.value = false;
  }
}

async function loadDeleted(reset = true, throwOnFailure = false): Promise<void> {
  if (!project.value || !canWrite.value || (!reset && (loading.value || cursor.value === null))) return;
  const current = generation;
  const request = ++loadRequest;
  const isCurrent = () => current === generation && request === loadRequest && canWrite.value;
  const previousCursor = cursor.value;
  if (reset) cursor.value = null;
  loading.value = true;
  clearError();
  try {
    const params = new URLSearchParams({ deleted: "only", limit: "100" });
    if (!reset && previousCursor) params.set("cursor", previousCursor);
    const result = await apiRequest<ListResult<IssueTombstone>>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/issues?${params}`);
    if (!isCurrent()) return;
    issues.value = mergePageById(issues.value, result.items, reset);
    cursor.value = continuationCursor(result);
    loaded.value = true;
  } catch (caught) {
    if (!isCurrent()) return;
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) {
      clearProjection();
      setError(caught);
    } else if (!reset && cursorRequiresRestart(caught)) {
      cursor.value = null;
      setLocalizedError("The list changed. Refresh it before continuing.", "列表已变化，请刷新后继续。");
    } else setError(caught);
    if (throwOnFailure) throw caught;
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

async function refreshConflict(): Promise<void> {
  const previous = conflict.value;
  if (!previous || loading.value || busy.value) return;
  const current = generation;
  const recoveryGeneration = ++casRecoveryGeneration;
  conflict.value = { ...previous, readbackState: "pending" };
  try {
    await loadDeleted(true, true);
    if (current === generation && recoveryGeneration === casRecoveryGeneration) conflict.value = markCasReadbackComplete(previous);
  } catch {
    if (current === generation && recoveryGeneration === casRecoveryGeneration) conflict.value = markCasReadbackFailed(previous);
  }
}

async function restoreIssue(issue: IssueTombstone): Promise<void> {
  if (!project.value || !canWrite.value || busy.value || loading.value || conflict.value || !issue.restorable || !issue.allowed_actions.includes("restore")) return;
  const key = `issue-restore:${issue.id}`;
  if (!writeFence.enter(key)) return;
  const current = generation;
  busy.value = true;
  clearError();
  try {
    await apiRequest(`/api/v1/issues/${issue.identifier}/commands/restore`, { method: "POST", body: { expected_version: issue.version } });
    if (current !== generation || !canWrite.value) return;
    issues.value = issues.value.filter(item => item.id !== issue.id);
    await loadDeleted(true);
  } catch (caught) {
    if (current !== generation || !canWrite.value) return;
    if (caught instanceof ApiProblem && [403, 404].includes(caught.status)) {
      clearProjection();
      setError(caught);
      return;
    }
    setError(caught);
    const captured = captureCasConflict(caught, localizedText(`${issue.identifier} restore`, `${issue.identifier} 恢复`), { action: "restore" });
    if (captured) {
      const recoveryGeneration = ++casRecoveryGeneration;
      conflict.value = captured;
      try {
        await loadDeleted(true, true);
        if (current === generation && recoveryGeneration === casRecoveryGeneration) conflict.value = markCasReadbackComplete(captured);
      } catch {
        if (current === generation && recoveryGeneration === casRecoveryGeneration) conflict.value = markCasReadbackFailed(captured);
      }
    }
  } finally {
    writeFence.leave(key);
    busy.value = false;
  }
}

function restoreUnavailableText(issue: IssueTombstone): string {
  if (issue.parent_status.workspace === "deleted") return ui("Restore the parent workspace first", "请先恢复所属工作区");
  if (issue.parent_status.project === "deleted") return ui("Restore the parent project first", "请先恢复所属项目");
  return ui("Restore unavailable. Check project permissions and capacity.", "当前不可恢复，请核对项目权限和容量。");
}

watch(() => [props.workspaceId, props.projectId, projectInventoryBoundary(props.session.allowed_scope.projects)], () => void load(), { immediate: true, flush: "sync" });
onUnmounted(clearProjection);
</script>

<template>
  <main class="page-shell">
    <ProjectSettingsHeader :workspace-id="workspaceId" :project-id="projectId" section="deleted" :project="project" :session="session" :return-to="backPath" @navigate="emit('navigate', $event)" />
    <div class="section-heading-row"><h2>{{ ui('Deleted issues', '已删除事项') }}</h2><UButton color="neutral" variant="ghost" v-if="project && canWrite" class="text-button" type="button" :disabled="loading || busy || !!conflict" @click="loadDeleted(true)">{{ ui('Refresh', '刷新') }}</UButton></div>
    <ErrorNotice v-if="error" :error="error" />
    <CasConflictNotice v-if="conflict" :conflict="conflict" :busy="loading || busy" @refresh="refreshConflict" @dismiss="dismissConflict" />
    <div v-if="project && canWrite" class="tombstone-list">
      <div v-for="issue in issues" :key="issue.id" class="tombstone-row">
        <span><code>{{ issue.identifier }}</code><strong>{{ issue.title }}</strong></span>
        <UButton color="neutral" variant="outline" v-if="issue.restorable && issue.allowed_actions.includes('restore')" class="secondary-button" type="button" :disabled="busy || loading || !!conflict" @click="restoreIssue(issue)">{{ t('action.restore') }}</UButton>
        <small v-else class="warning-chip">{{ restoreUnavailableText(issue) }}</small>
      </div>
      <p v-if="loaded && !issues.length && !loading && !error" class="empty-copy">{{ ui('No deleted issues.', '没有已删除的事项。') }}</p>
      <UButton color="neutral" variant="outline" v-if="cursor && !error" class="load-more" type="button" :disabled="loading || busy || !!conflict" @click="loadDeleted(false)">{{ ui('Load more deleted issues', '加载更多已删除事项') }}</UButton>
    </div>
    <UButton color="neutral" variant="outline" v-if="error && canWrite && !conflict" class="secondary-button" type="button" :disabled="loading || busy" @click="project ? loadDeleted(!cursor) : load()">{{ ui('Retry', '重试') }}</UButton>
    <p v-if="loading" role="status">{{ ui('Loading…', '加载中…') }}</p>
  </main>
</template>
