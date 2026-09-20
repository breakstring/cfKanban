<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
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

function select(event: Event): void {
  const element = event.target as HTMLSelectElement;
  const principalId = element.value || null;
  element.value = props.assignee?.principal_id ?? "";
  if (props.disabled || loading.value || principalId === (props.assignee?.principal_id ?? null)) return;
  emit("select", principalId);
}

watch(() => [props.workspaceId, props.projectId], () => void load(), { immediate: true });
onUnmounted(() => { generation += 1; });
</script>

<template>
  <div class="assignee-control">
    <select :value="assignee?.principal_id ?? ''" :aria-label="t('issue.assignee')" :disabled="disabled || loading" @change="select">
      <option value="">{{ t("issue.unassigned") }}</option>
      <option v-if="assignee && !candidates.some(item => item.principal_id === assignee?.principal_id)" :value="assignee.principal_id" disabled>{{ assignee.display_name }}</option>
      <option v-for="candidate in candidates" :key="candidate.principal_id" :value="candidate.principal_id">{{ candidate.display_name }}</option>
    </select>
    <small v-if="assignee && !assignee.available" class="inline-alert">{{ locale === 'zh-CN' ? '原负责人已无指派资格，请重新选择。' : 'The current assignee is no longer eligible. Choose another person.' }}</small>
    <small v-if="loading" role="status">{{ locale === 'zh-CN' ? '正在加载可指派人员…' : 'Loading eligible people…' }}</small>
    <template v-if="error"><small class="inline-alert" role="alert">{{ error }}</small><button class="text-button" type="button" :disabled="loading || disabled" @click="load()">{{ t('action.refresh') }}</button></template>
    <button v-else-if="nextCursor" class="text-button" type="button" :disabled="loading || disabled" @click="load(false)">{{ locale === 'zh-CN' ? '加载更多人员' : 'Load more people' }}</button>
  </div>
</template>
