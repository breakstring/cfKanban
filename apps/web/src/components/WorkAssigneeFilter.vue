<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor, cursorRequiresRestart } from "../lib/pagination";
import type { ListResult, MemberCandidate, ProjectScopeItem } from "../types";
const props = defineProps<{ projects: ProjectScopeItem[]; modelValue: string; principalId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const people = ref<MemberCandidate[]>([]);
const cursors = ref<Record<string, string | null>>({});
const loaded = ref(false);
const loading = ref(false);
const { error, clearError, setError } = useLocalizedError();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
let generation = 0;
function reset(): void { generation++; people.value = []; cursors.value = {}; loaded.value = false; loading.value = false; clearError(); }
async function load(): Promise<void> {
  if (loading.value || !props.projects.length) return;
  const current = ++generation;
  loading.value = true; clearError();
  const targets = props.projects.filter(project => !(project.project_id in cursors.value) || cursors.value[project.project_id]);
  const results = await Promise.allSettled(targets.map(async project => {
    const params = new URLSearchParams({ limit: "20" });
    if (cursors.value[project.project_id]) params.set("cursor", cursors.value[project.project_id]!);
    const page = await apiRequest<ListResult<MemberCandidate>>(`/api/v1/workspaces/${project.workspace_id}/projects/${project.project_id}/assignees?${params}`);
    return { project, page, next: continuationCursor(page) };
  }));
  if (current !== generation) return;
  const expired = results.find(result => result.status === "rejected" && cursorRequiresRestart(result.reason));
  if (expired?.status === "rejected") { reset(); emit("update:modelValue", ""); setError(expired.reason); return; }
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { project, page, next } = result.value;
      people.value = [...new Map([...people.value, ...page.items].map(person => [person.principal_id, person])).values()];
      cursors.value[project.project_id] = next;
    } else setError(result.reason);
  }
  // A failed project keeps its first page eligible for an explicit retry.
  loaded.value = results.every(result => result.status === "fulfilled"); loading.value = false;
}
watch(() => props.projects.map(project => project.project_id).join(","), reset);
onUnmounted(reset);
</script>
<template>
  <div class="work-assignee">
    <label>{{ ui('Assignee', '负责人') }}<select :value="modelValue" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"><option value="">{{ ui('Anyone', '任何人') }}</option><option value="unassigned">{{ ui('Unassigned', '未分配') }}</option><option :value="principalId">{{ ui('Me', '我') }}</option><option v-for="person in people.filter(person => person.principal_id !== principalId)" :key="person.principal_id" :value="person.principal_id">{{ person.display_name }}</option></select></label>
    <button v-if="!loaded || Object.values(cursors).some(Boolean)" class="text-button" type="button" :disabled="loading || !projects.length" @click="load">{{ loading ? ui('Loading…', '加载中…') : error ? ui('Retry people', '重试加载人员') : loaded ? ui('More people', '更多人员') : ui('Choose other people', '选择其他人员') }}</button>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
<style scoped>
.work-assignee { display: grid; align-content: start; gap: 4px; }
label { display: grid; gap: 8px; }
button { justify-self: start; }
</style>
