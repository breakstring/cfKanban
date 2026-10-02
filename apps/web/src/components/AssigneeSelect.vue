<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import AssigneeMenu from "./AssigneeMenu.vue";
import { apiRequest } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor, cursorRequiresRestart } from "../lib/pagination";
import type { IssueSummary, ListResult } from "../types";

interface Candidate { principal_id: string; display_name: string }
const props = defineProps<{
  workspaceId: string;
  projectId: string;
  assignee: IssueSummary["assignee"];
  disabled: boolean;
}>();
const emit = defineEmits<{ select: [principalId: string | null] }>();
const candidates = ref<Candidate[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;

async function load(reset = true): Promise<void> {
  if (!reset && (loading.value || nextCursor.value === null)) return;
  const request = ++generation;
  loading.value = true;
  clearError();
  if (reset) {
    candidates.value = [];
    nextCursor.value = null;
  }
  const params = new URLSearchParams({ limit: "50" });
  if (!reset && nextCursor.value) params.set("cursor", nextCursor.value);
  try {
    const result = await apiRequest<ListResult<Candidate>>(
      `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/assignees?${params}`,
    );
    if (request !== generation) return;
    candidates.value = [...new Map([...candidates.value, ...result.items].map(item => [item.principal_id, item])).values()];
    nextCursor.value = continuationCursor(result);
  } catch (caught) {
    if (request !== generation) return;
    if (cursorRequiresRestart(caught)) nextCursor.value = null;
    setError(caught);
  } finally {
    if (request === generation) loading.value = false;
  }
}

function select(principalId: string | null): void {
  if (props.disabled || loading.value || principalId === (props.assignee?.principal_id ?? null)) return;
  emit("select", principalId);
}

watch(() => [props.workspaceId, props.projectId], () => void load(), { immediate: true });
onUnmounted(() => { generation += 1; });
</script>

<template>
  <div class="assignee-control">
    <AssigneeMenu :assignee="assignee" :candidates="candidates" :disabled="disabled" :loading="loading" :has-more="nextCursor !== null" :load-error="error" :label="t('issue.assignee')" @select="select" @load-more="load(false)" @retry="load()" />
    <small v-if="assignee && !assignee.available" class="inline-alert">{{ locale === 'zh-CN' ? '原负责人已无指派资格，请重新选择。' : 'The current assignee is no longer eligible. Choose another person.' }}</small>
  </div>
</template>
