<script setup lang="ts">
import { computed, onUnmounted, reactive, watch } from "vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import { ColumnPagination } from "../lib/column-pagination";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale } from "../lib/i18n";
import { cursorRequiresRestart } from "../lib/pagination";
import { priorityOrder, priorityText } from "../lib/priority";
import { isVerifiedServiceAccessFailure } from "../lib/session-boundary";
import type { LabelResource, ListResult, PriorityKey, ProjectScopeItem } from "../types";

const props = defineProps<{ projects: ProjectScopeItem[]; priorities: PriorityKey[]; labels: string[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:priorities': [value: PriorityKey[]]; 'update:labels': [value: string[]] }>();
const pages = reactive<Record<string, ColumnPagination<LabelResource>>>({});
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const projectNames = computed(() => containerChoiceLabels(props.projects.map(project => ({ id: project.project_id, name: project.project_display_name, workspaceName: project.workspace_display_name }))));
let generation = 0;

function reset(): void {
  generation++;
  for (const [id, page] of Object.entries(pages)) { page.reset(); delete pages[id]; }
  for (const project of props.projects) pages[project.project_id] = new ColumnPagination<LabelResource>();
}
watch(() => props.projects.map(project => `${project.workspace_id}/${project.project_id}/${project.role}`).join(","), () => {
  reset();
  if (props.labels.length) emit("update:labels", []);
}, { immediate: true, flush: "sync" });
onUnmounted(reset);

function togglePriority(priority: PriorityKey): void {
  emit("update:priorities", props.priorities.includes(priority) ? props.priorities.filter(value => value !== priority) : [...props.priorities, priority]);
}
function toggleLabel(id: string): void {
  if (props.labels.includes(id)) emit("update:labels", props.labels.filter(value => value !== id));
  else if (props.labels.length < 20) emit("update:labels", [...props.labels, id]);
}
async function loadLabels(project: ProjectScopeItem): Promise<void> {
  if (props.disabled) return;
  const current = generation;
  const page = pages[project.project_id];
  if (!page) return;
  const priorIds = new Set(page.items.map(label => label.id));
  await page.load(async cursor => {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return apiRequest<ListResult<LabelResource>>(`/api/v1/workspaces/${encodeURIComponent(project.workspace_id)}/projects/${encodeURIComponent(project.project_id)}/labels?${params}`);
  });
  if (current !== generation) return;
  const accessFailure = page.error instanceof ApiProblem && isVerifiedServiceAccessFailure(page.error.status, page.error.body);
  if (accessFailure) {
    const failure = page.error;
    page.reset();
    page.error = failure;
  }
  if (accessFailure || cursorRequiresRestart(page.error)) emit("update:labels", props.labels.filter(id => !priorIds.has(id)));
}
</script>

<template>
  <div class="issue-query-filters">
    <details class="query-filter">
      <summary>{{ ui('Priority', '优先级') }} · {{ priorities.length ? priorities.map(value => priorityText(value, locale === 'zh-CN')).join(' / ') : ui('Any', '不限') }}</summary>
      <fieldset :disabled="disabled" class="query-options"><legend class="query-hint">{{ ui('Match any selected priority; none selected means any.', '匹配任一选中优先级；不选则不限。') }}</legend>
        <label v-for="priority in priorityOrder" :key="priority"><input type="checkbox" :value="priority" :checked="priorities.includes(priority)" @change="togglePriority(priority)" />{{ priorityText(priority, locale === 'zh-CN') }}</label>
        <button v-if="priorities.length" class="text-button" type="button" @click="emit('update:priorities', [])">{{ ui('Clear priorities', '清空优先级') }}</button>
      </fieldset>
    </details>
    <details class="query-filter">
      <summary>{{ ui('Labels', '标签') }} · {{ labels.length ? `${labels.length}/20` : ui('Any', '不限') }}</summary>
      <fieldset :disabled="disabled" class="query-options"><legend class="query-hint">{{ ui('Match any selected label. Labels belong to their project.', '匹配任一选中标签，标签仅属于各自项目。') }}</legend>
        <p v-if="!projects.length" class="query-hint">{{ ui('Choose projects first.', '请先选择项目。') }}</p>
        <section v-for="project in projects" :key="project.project_id" class="query-project" :aria-label="projectNames.get(project.project_id)?.label">
          <strong :title="project.project_id">{{ projectNames.get(project.project_id)?.label }}</strong>
          <label v-for="label in pages[project.project_id]?.items ?? []" :key="label.id"><input type="checkbox" :value="label.id" :checked="labels.includes(label.id)" :disabled="labels.length >= 20 && !labels.includes(label.id)" @change="toggleLabel(label.id)" />{{ label.name }}</label>
          <p v-if="pages[project.project_id]?.loaded && !pages[project.project_id]?.items.length" class="query-hint">{{ ui('No labels in this project.', '此项目暂无标签。') }}</p>
          <p v-if="pages[project.project_id]?.error" class="query-hint" role="alert">{{ errorText(pages[project.project_id]!.error) }}</p>
          <button v-if="!pages[project.project_id]?.loaded || pages[project.project_id]?.cursor || pages[project.project_id]?.error" class="text-button" type="button" :disabled="pages[project.project_id]?.loading" @click="loadLabels(project)">{{ pages[project.project_id]?.loading ? ui('Loading…', '加载中…') : pages[project.project_id]?.error ? ui('Retry labels', '重试加载标签') : pages[project.project_id]?.loaded ? ui('More labels', '更多标签') : ui('Choose labels', '选择标签') }}</button>
        </section>
        <button v-if="labels.length" class="text-button" type="button" @click="emit('update:labels', [])">{{ ui('Clear labels', '清空标签') }}</button>
      </fieldset>
    </details>
  </div>
</template>

<style scoped>
.issue-query-filters { display: flex; flex-wrap: wrap; align-items: start; gap: 12px; min-width: 0; }
.query-filter { flex: 1 1 190px; min-width: 0; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); }
summary { padding: 10px 12px; cursor: pointer; overflow-wrap: anywhere; }
summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.query-options { display: grid; gap: 8px; border: 0; margin: 0; padding: 12px; max-height: 320px; overflow: auto; min-width: 0; }
.query-hint { font-size: 12px; color: var(--color-text-muted); margin: 0; }
legend { padding: 0; }
.query-project { display: grid; gap: 8px; padding-top: 8px; }
.query-project + .query-project { border-top: 1px solid var(--color-border); }
.query-project strong { font-size: 13px; overflow-wrap: anywhere; }
label { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
input { width: 18px; height: 18px; min-height: 18px; flex: none; accent-color: var(--color-primary); }
button { justify-self: start; }
@media (max-width: 940px) { summary, label { min-height: 44px; } }
</style>
