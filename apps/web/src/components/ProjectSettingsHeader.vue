<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed } from "vue";
import { boardReturnPath } from "../lib/board-navigation";
import { locale } from "../lib/i18n";
import { projectSettingsPath, projectSettingsSections, type ProjectSettingsSection } from "../lib/project-settings";
import type { ContainerResource, WebSessionView } from "../types";

const props = defineProps<{
  workspaceId: string;
  projectId: string;
  section: ProjectSettingsSection;
  project: ContainerResource | null;
  session: WebSessionView;
  returnTo?: string;
}>();
const emit = defineEmits<{ navigate: [path: string] }>();
const scope = computed(() => props.session.allowed_scope.projects?.find(item => item.workspace_id === props.workspaceId && item.project_id === props.projectId));
const backPath = computed(() => boardReturnPath(props.workspaceId, props.projectId, props.returnTo
  ? new URLSearchParams({ from: props.returnTo }).toString()
  : window.location.search));
const projectName = computed(() => props.project?.display_name ?? scope.value?.project_display_name ?? "");
const workspaceName = computed(() => props.project?.workspace_display_name ?? scope.value?.workspace_display_name ?? "");
const sections = computed(() => projectSettingsSections(props.session, props.workspaceId, props.projectId, props.project));
const archived = computed(() => props.project?.deleted_at != null);
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
function label(section: ProjectSettingsSection): string {
  return {
    management: ui("Management", "项目管理"),
    labels: ui("Labels", "标签"),
    activity: ui("Activity", "项目活动"),
    deleted: ui("Deleted issues", "已删除事项"),
  }[section];
}
function open(section: ProjectSettingsSection): void {
  if (section === props.section || !sections.value.includes(section)) return;
  emit("navigate", projectSettingsPath(props.workspaceId, props.projectId, section, backPath.value, props.project?.deleted_at != null));
}
</script>

<template>
  <header class="project-settings-header">
    <UButton color="neutral" variant="ghost" type="button" class="project-settings-back" @click="emit('navigate', archived ? '/app' : backPath)">← {{ archived ? ui('Choose project', '选择项目') : ui('Back to board', '返回看板') }}</UButton>
    <div class="project-settings-heading">
      <div>
        <p v-if="projectName" class="eyebrow">{{ workspaceName ? `${workspaceName} / ` : '' }}{{ projectName }}</p>
        <h1>{{ ui('Project settings', '项目设置') }}</h1>
      </div>
      <div v-if="$slots.actions" class="project-settings-actions"><slot name="actions" /></div>
    </div>
    <nav v-if="sections.length" class="project-settings-tabs" :aria-label="ui('Project settings sections', '项目设置分区')">
      <UButton v-for="item in sections" :key="item" color="neutral" variant="ghost" type="button" class="project-settings-tab" :class="{ active: item === section }" :aria-current="item === section ? 'page' : undefined" @click="open(item)">{{ label(item) }}</UButton>
    </nav>
  </header>
</template>

<style scoped>
.project-settings-header { margin-bottom: 28px; }
.project-settings-back { margin-left: -10px; margin-bottom: 20px; }
.project-settings-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.project-settings-heading h1 { font-family: var(--font-ui); font-size: 28px; font-weight: 650; line-height: 1.35; }
.project-settings-heading .eyebrow { margin-bottom: 6px; font-size: 13px; letter-spacing: 0; color: var(--color-text-muted); overflow-wrap: anywhere; }
.project-settings-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.project-settings-tabs { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 24px; border-bottom: 1px solid var(--color-border); }
.project-settings-tab { border-radius: 0; min-height: 42px; padding: 8px 0; border-bottom: 2px solid transparent; color: var(--color-text-muted); font-size: 14px; }
.project-settings-tab.active { border-bottom-color: var(--color-primary); color: var(--color-primary); }
@media (max-width: 940px) {
  .project-settings-back, .project-settings-tab, .project-settings-actions :deep(button) { min-height: 44px; }
}
@media (max-width: 640px) {
  .project-settings-heading { align-items: flex-start; }
  .project-settings-heading h1 { font-size: 24px; }
  .project-settings-tabs { gap: 8px 20px; margin-top: 20px; }
}
</style>
