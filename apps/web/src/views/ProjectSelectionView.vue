<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import PageState from "../components/PageState.vue";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import type { WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView }>();

interface Choice {
  displayName: string;
  projectId: string;
  role: string;
  workspaceId: string;
  workspaceName: string;
}

const choices = ref<Choice[]>([]);
const choiceLabels = computed(() => containerChoiceLabels(choices.value.map((choice) => ({ id: choice.projectId, name: choice.displayName, workspaceName: choice.workspaceName }))));
const loading = ref(true);
const error = ref("");

function roleLabel(value: string): string {
  if (locale.value !== "zh-CN") return value;
  if (value === "writer") return "协作者";
  if (value === "reader") return "只读者";
  return value === "owner" ? "所有者" : value;
}

function load(): void {
  loading.value = true;
  error.value = "";
  choices.value = (props.session.allowed_scope.projects ?? []).map((scope) => ({
    displayName: scope.project_display_name,
    projectId: scope.project_id,
    role: scope.role,
    workspaceId: scope.workspace_id,
    workspaceName: scope.workspace_display_name,
  }));
  loading.value = false;
}

onMounted(load);
watch(() => props.session.allowed_scope.projects, load, { deep: true });
</script>

<template>
  <main class="page-shell narrow-page">
    <header class="page-title-block">
      <p class="eyebrow">{{ locale === "zh-CN" ? "项目范围" : "Project scope" }}</p>
      <h1>{{ t("project.choose") }}</h1>
      <p>{{ t("project.chooseHelp") }}</p>
    </header>
    <PageState :loading="loading" :error="error" :action-label="t('action.refresh')" @retry="load" />
    <div v-if="!loading && !error" class="selection-list">
      <button
        v-for="choice in choices"
        :key="`${choice.workspaceId}/${choice.projectId}`"
        class="selection-row"
        :title="choiceLabels.get(choice.projectId)?.title"
        type="button"
        @click="navigate(`/app/w/${encodeURIComponent(choice.workspaceId)}/p/${encodeURIComponent(choice.projectId)}`)"
      >
        <span>
          <strong>{{ choiceLabels.get(choice.projectId)?.label }}</strong>
        </span>
        <span class="role-badge">{{ roleLabel(choice.role) }}</span>
      </button>
      <p v-if="choices.length === 0" class="empty-copy">
        {{ locale === "zh-CN" ? "当前没有可访问的项目。" : "No projects are currently available." }}
      </p>
    </div>
  </main>
</template>
