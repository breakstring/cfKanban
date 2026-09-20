<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor } from "../lib/pagination";
import type { AdministratorCandidate, ListResult } from "../types";

const props = defineProps<{ resourcePath: string; disabled: boolean }>();
const emit = defineEmits<{ select: [candidate: AdministratorCandidate | null] }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const query = ref("");
const selected = ref("");
const candidates = ref<AdministratorCandidate[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function reset(): void {
  generation += 1;
  clearTimeout(timer);
  candidates.value = []; nextCursor.value = null; selected.value = "";
  emit("select", null);
  clearError();
}

async function load(more = false): Promise<void> {
  if (more && (loading.value || !nextCursor.value)) return;
  if (!more) reset();
  const request = ++generation;
  loading.value = true;
  const params = new URLSearchParams({ limit: "50", q: query.value.trim() });
  if (more && nextCursor.value) params.set("cursor", nextCursor.value);
  try {
    const result = await apiRequest<ListResult<AdministratorCandidate>>(`${props.resourcePath}/administrator-candidates?${params}`);
    if (request !== generation) return;
    candidates.value = [...new Map([...candidates.value, ...result.items].map(item => [item.principal_id, item])).values()];
    nextCursor.value = continuationCursor(result);
  } catch (caught) {
    if (request !== generation) return;
    reset(); loading.value = false; setError(caught);
  } finally { if (request === generation) loading.value = false; }
}

function search(): void {
  reset(); loading.value = true;
  timer = setTimeout(() => void load(), 250);
}
function select(): void {
  emit("select", candidates.value.find(item => item.principal_id === selected.value) ?? null);
}
watch(() => props.resourcePath, () => { query.value = ""; void load(); }, { immediate: true });
onUnmounted(() => { generation += 1; clearTimeout(timer); });
</script>

<template>
  <div class="assignee-control administrator-select">
    <label>{{ ui('Search people', '搜索人员') }}<input v-model="query" type="search" maxlength="100" :disabled="disabled" :placeholder="ui('Search by name', '按姓名搜索')" @input="search" @keydown.enter.prevent="load()" /></label>
    <label>{{ ui('Select a person', '选择人员') }}<select v-model="selected" required :aria-label="ui('Select a person', '选择人员')" :disabled="disabled || loading || candidates.length === 0" @change="select">
      <option value="" disabled>{{ ui('Choose an administrator', '请选择要添加的管理员') }}</option>
      <option v-for="candidate in candidates" :key="candidate.principal_id" :value="candidate.principal_id">{{ candidate.display_name }}</option>
    </select></label>
    <small v-if="loading" role="status">{{ ui('Loading people…', '正在加载人员…') }}</small>
    <template v-else-if="error"><small class="inline-alert" role="alert">{{ error }}</small><button class="text-button" type="button" :disabled="disabled" @click="load()">{{ ui('Retry', '重试') }}</button></template>
    <small v-else-if="!candidates.length" role="status">{{ query.trim() ? ui('No matching people available.', '没有匹配的可选人员。') : ui('No people available in your visible scope.', '当前可见范围内没有可添加的人员。') }}</small>
    <button v-if="nextCursor" class="text-button" type="button" :disabled="disabled || loading" @click="load(true)">{{ ui('Load more people', '加载更多人员') }}</button>
    <small>{{ ui('The Owner and people who already have administrator access are excluded.', '已排除实例所有者和已具备管理员权限的人员。') }}</small>
  </div>
</template>

<style scoped>
.administrator-select { flex: 1; min-width: min(100%, 240px); }
.administrator-select label { display: grid; gap: 8px; }
</style>
