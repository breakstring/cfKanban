<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import ProjectActivity from "../components/ProjectActivity.vue";
import ProjectSettingsHeader from "../components/ProjectSettingsHeader.vue";
import { apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { projectInventoryBoundary } from "../lib/session-boundary";
import type { ContainerResource, WebSessionView } from "../types";

const props = defineProps<{ workspaceId: string; projectId: string; session: WebSessionView; returnTo?: string }>();
const emit = defineEmits<{ navigate: [path: string]; context: [value: { label: string; role: string }] }>();
const project = ref<ContainerResource | null>(null);
const loading = ref(false);
const { error, clearError, setError, setLocalizedError } = useLocalizedError();
let generation = 0;
const scope = computed(() => props.session.allowed_scope.projects?.find(item => item.workspace_id === props.workspaceId && item.project_id === props.projectId));
const accessible = computed(() => !!scope.value || (props.session.principal.is_owner && props.session.allowed_scope.projects === undefined));
const role = computed(() => scope.value?.role ?? "owner");
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const backPath = computed(() => props.returnTo ?? `/app/w/${props.workspaceId}/p/${props.projectId}`);

async function load(): Promise<void> {
  const current = ++generation;
  project.value = null;
  loading.value = false;
  clearError();
  if (!accessible.value) {
    setLocalizedError("This project is no longer available.", "此项目已不在当前可访问范围。");
    return;
  }
  loading.value = true;
  try {
    const result = await apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`);
    if (current !== generation || !accessible.value) return;
    if (result.deleted_at !== null) {
      setLocalizedError("This project is archived.", "此项目已归档。");
      return;
    }
    project.value = result;
    emit("context", { label: `${result.workspace_display_name ?? ""} / ${result.display_name}`, role: role.value });
  } catch (caught) {
    if (current === generation) setError(caught);
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(() => [props.workspaceId, props.projectId, projectInventoryBoundary(props.session.allowed_scope.projects)], () => void load(), { immediate: true, flush: "sync" });
onUnmounted(() => { generation += 1; });
</script>

<template>
  <main class="page-shell">
    <ProjectSettingsHeader :workspace-id="workspaceId" :project-id="projectId" section="activity" :project="project" :session="session" :return-to="backPath" @navigate="emit('navigate', $event)" />
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="loading" role="status">{{ ui('Loading…', '加载中…') }}</p>
    <UButton color="neutral" variant="outline" v-if="error && accessible" class="secondary-button" type="button" :disabled="loading" @click="load">{{ ui('Retry', '重试') }}</UButton>
    <ProjectActivity v-if="project && accessible" :key="projectInventoryBoundary(session.allowed_scope.projects)" :project-id="projectId" />
  </main>
</template>
