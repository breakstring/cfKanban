<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

import PageState from "../components/PageState.vue";
import { locale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import type { WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView }>();

interface Choice {
  displayName: string;
  projectKey: string;
  role: string;
  workspaceKey: string;
}

const choices = ref<Choice[]>([]);
const loading = ref(true);
const error = ref("");

function load(): void {
  loading.value = true;
  error.value = "";
  choices.value = (props.session.allowed_scope.projects ?? []).map((scope) => ({
    displayName: scope.project_key,
    projectKey: scope.project_key,
    role: scope.role,
    workspaceKey: scope.workspace_key,
  }));
  loading.value = false;
}

onMounted(load);
watch(() => props.session.allowed_scope.projects, load, { deep: true });
</script>

<template>
  <main class="page-shell narrow-page">
    <header class="page-title-block">
      <p class="eyebrow">{{ locale === "zh-CN" ? "Project 范围" : "Project scope" }}</p>
      <h1>{{ t("project.choose") }}</h1>
      <p>{{ t("project.chooseHelp") }}</p>
    </header>
    <PageState :loading="loading" :error="error" :action-label="t('action.refresh')" @retry="load" />
    <div v-if="!loading && !error" class="selection-list">
      <button
        v-for="choice in choices"
        :key="`${choice.workspaceKey}/${choice.projectKey}`"
        class="selection-row"
        type="button"
        @click="navigate(`/app/w/${encodeURIComponent(choice.workspaceKey)}/p/${encodeURIComponent(choice.projectKey)}`)"
      >
        <span>
          <small>{{ choice.workspaceKey }} / {{ choice.projectKey }}</small>
          <strong>{{ choice.displayName }}</strong>
        </span>
        <span class="role-badge">{{ choice.role }}</span>
      </button>
      <p v-if="choices.length === 0" class="empty-copy">
        {{ locale === "zh-CN" ? "当前没有可访问的 Project。" : "No projects are currently available." }}
      </p>
    </div>
  </main>
</template>
