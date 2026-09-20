<script setup lang="ts" generic="Candidate extends { principal_id: string; display_name: string }">
import { onUnmounted, ref, shallowRef, watch } from "vue";
import { apiRequest } from "../lib/api";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor } from "../lib/pagination";
import type { ListResult } from "../types";

const props = defineProps<{ endpoint: string; disabled: boolean; modelValue: Candidate | null; placeholder: string; emptyText: string; hint: string }>();
const emit = defineEmits<{ 'update:modelValue': [candidate: Candidate | null] }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const query = ref("");
const selected = ref("");
const candidates = shallowRef<Candidate[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function reset(): void {
  generation += 1;
  clearTimeout(timer);
  candidates.value = []; nextCursor.value = null; selected.value = "";
  emit("update:modelValue", null);
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
    const result = await apiRequest<ListResult<Candidate>>(`${props.endpoint}?${params}`);
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
  emit("update:modelValue", candidates.value.find(item => item.principal_id === selected.value) ?? null);
}
watch(() => props.endpoint, () => { query.value = ""; void load(); }, { immediate: true });
onUnmounted(() => { generation += 1; clearTimeout(timer); });
</script>

<template>
  <div class="person-select">
    <div class="person-fields">
      <label>{{ ui('Search people', '搜索人员') }}<input v-model="query" type="search" maxlength="100" :disabled="disabled" :placeholder="ui('Search by name', '按姓名搜索')" @input="search" @keydown.enter.prevent="load()" /></label>
      <template v-if="candidates.length">
        <label>{{ ui('Select a person', '选择人员') }}<select v-model="selected" required :aria-label="ui('Select a person', '选择人员')" :disabled="disabled || loading" @change="select">
          <option value="" disabled>{{ placeholder }}</option>
          <option v-for="candidate in candidates" :key="candidate.principal_id" :value="candidate.principal_id">{{ candidate.display_name }}</option>
        </select></label>
        <div class="person-actions"><slot :ready="!loading && !!modelValue" /></div>
      </template>
    </div>
    <small v-if="loading" role="status">{{ ui('Loading people…', '正在加载人员…') }}</small>
    <template v-else-if="error"><small class="inline-alert" role="alert">{{ error }}</small><button class="text-button" type="button" :disabled="disabled" @click="load()">{{ ui('Retry', '重试') }}</button></template>
    <p v-else-if="!candidates.length" class="person-empty" role="status">{{ query.trim() ? ui('No matching people available. Try another name.', '没有匹配的可选人员，请换个姓名搜索。') : emptyText }}</p>
    <button v-if="nextCursor" class="text-button" type="button" :disabled="disabled || loading" @click="load(true)">{{ ui('Load more people', '加载更多人员') }}</button>
    <small class="person-hint">{{ hint }}</small>
  </div>
</template>

<style scoped>
.person-select { min-width: 0; }
.person-fields { display: flex; align-items: end; flex-wrap: wrap; gap: 16px; }
.person-fields > label { flex: 1 1 200px; max-width: 360px; min-width: 0; }
.person-select label, .person-select :deep(label) { display: grid; gap: 8px; }
.person-select input, .person-select select, .person-select :deep(button), .person-select :deep(select) { min-height: 44px; }
.person-actions { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
.person-select > small { display: block; margin-block-start: 10px; }
.person-hint { color: var(--color-text-muted); }
.person-empty { margin-block: 12px 0; }
@media (max-width: 600px) {
  .person-fields { display: grid; grid-template-columns: minmax(0, 1fr); }
  .person-fields > label { max-width: none; }
  .person-actions > :deep(*) { flex: 1; }
}
</style>
