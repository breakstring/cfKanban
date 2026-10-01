<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import { ColumnPagination } from "../lib/column-pagination";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale } from "../lib/i18n";
import { cursorRequiresRestart } from "../lib/pagination";
import { priorityOrder, priorityText } from "../lib/priority";
import { isVerifiedServiceAccessFailure } from "../lib/session-boundary";
import type { LabelResource, ListResult, PriorityKey, ProjectScopeItem } from "../types";

const props = defineProps<{ projects: ProjectScopeItem[]; priorities: PriorityKey[]; labels: string[]; disabled?: boolean; compact?: boolean }>();
const filterRoot = ref<HTMLElement | null>(null);
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
watch(() => props.projects.map(project => `${project.workspace_id}/${project.project_id}/${project.role}`).join(","), (_scope, previous) => {
  reset();
  if (previous && props.labels.length) emit("update:labels", []);
}, { immediate: true, flush: "sync" });
onUnmounted(reset);

function closeMenus(event?: Event): void {
  if (!props.compact || (event?.target instanceof Node && filterRoot.value?.contains(event.target))) return;
  filterRoot.value?.querySelectorAll("details[open]").forEach(detail => detail.removeAttribute("open"));
}
function onEscape(event: KeyboardEvent): void {
  if (!props.compact || event.key !== "Escape") return;
  const open = filterRoot.value?.querySelector<HTMLDetailsElement>("details[open]");
  open?.removeAttribute("open");
  open?.querySelector<HTMLElement>("summary")?.focus();
}
function opened(event: Event, labels = false): void {
  const detail = event.target as HTMLDetailsElement;
  if (!props.compact || !detail.open) return;
  filterRoot.value?.querySelectorAll("details[open]").forEach(other => { if (other !== detail) other.removeAttribute("open"); });
  if (labels) for (const project of props.projects) {
    const page = pages[project.project_id];
    if (page && !page.loaded && !page.loading && !page.error) void loadLabels(project);
  }
}
onMounted(() => { if (typeof document !== "undefined") document.addEventListener("pointerdown", closeMenus); });
onUnmounted(() => { if (typeof document !== "undefined") document.removeEventListener("pointerdown", closeMenus); });

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
  <div ref="filterRoot" class="issue-query-filters" :class="{ 'issue-query-filters--compact': compact }" @keydown="onEscape">
    <details class="query-filter" @toggle="opened($event)">
      <summary>{{ ui('Priority', '优先级') }} · {{ priorities.length ? priorities.map(value => priorityText(value, locale === 'zh-CN')).join(' / ') : ui('Any', '不限') }}</summary>
      <fieldset :disabled="disabled" class="query-options"><legend class="query-hint">{{ ui('Match any selected priority; none selected means any.', '匹配任一选中优先级；不选则不限。') }}</legend>
        <label v-for="priority in priorityOrder" :key="priority"><input type="checkbox" :value="priority" :checked="priorities.includes(priority)" @change="togglePriority(priority)" />{{ priorityText(priority, locale === 'zh-CN') }}</label>
        <UButton color="neutral" variant="ghost" size="sm" v-if="priorities.length" type="button" @click="emit('update:priorities', [])">{{ ui('Clear priorities', '清空优先级') }}</UButton>
      </fieldset>
    </details>
    <details class="query-filter" @toggle="opened($event, true)">
      <summary>{{ ui('Labels', '标签') }} · {{ labels.length ? (compact ? labels.length : `${labels.length}/20`) : ui('Any', '不限') }}</summary>
      <fieldset :disabled="disabled" class="query-options"><legend class="query-hint">{{ ui('Match any selected label. Labels belong to their project.', '匹配任一选中标签，标签仅属于各自项目。') }}</legend>
        <p v-if="!projects.length" class="query-hint">{{ ui('Choose projects first.', '请先选择项目。') }}</p>
        <section v-for="project in projects" :key="project.project_id" class="query-project" :aria-label="projectNames.get(project.project_id)?.label">
          <strong v-if="!compact || projects.length > 1">{{ projectNames.get(project.project_id)?.label }}</strong>
          <label v-for="label in pages[project.project_id]?.items ?? []" :key="label.id"><input type="checkbox" :value="label.id" :checked="labels.includes(label.id)" :disabled="labels.length >= 20 && !labels.includes(label.id)" @change="toggleLabel(label.id)" />{{ label.name }}</label>
          <p v-if="pages[project.project_id]?.loaded && !pages[project.project_id]?.items.length" class="query-hint">{{ ui('No labels in this project.', '此项目暂无标签。') }}</p>
          <p v-if="pages[project.project_id]?.error" class="query-hint" role="alert">{{ errorText(pages[project.project_id]!.error) }}</p>
          <UButton color="neutral" variant="ghost" size="sm" v-if="!pages[project.project_id]?.loaded || pages[project.project_id]?.cursor || pages[project.project_id]?.error" type="button" :disabled="pages[project.project_id]?.loading" @click="loadLabels(project)">{{ pages[project.project_id]?.loading ? ui('Loading…', '加载中…') : pages[project.project_id]?.error ? ui('Retry labels', '重试加载标签') : pages[project.project_id]?.loaded ? ui('More labels', '更多标签') : ui('Choose labels', '选择标签') }}</UButton>
        </section>
        <UButton color="neutral" variant="ghost" size="sm" v-if="labels.length" type="button" @click="emit('update:labels', [])">{{ ui('Clear labels', '清空标签') }}</UButton>
      </fieldset>
    </details>
  </div>
</template>

<style scoped>
.issue-query-filters { display: flex; flex-wrap: wrap; align-items: start; gap: 12px; min-width: 0; }
.query-filter { flex: 1 1 190px; min-width: 0; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
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
.issue-query-filters--compact { gap: 8px; margin-left: auto; }
.issue-query-filters--compact .query-filter { position: relative; flex: 0 1 auto; }
.issue-query-filters--compact summary { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 36px; padding: 7px 12px; max-width: 280px; font-size: 13px; list-style: none; }
.issue-query-filters--compact summary::-webkit-details-marker { display: none; }
.issue-query-filters--compact summary::after { content: ""; width: 6px; height: 6px; flex: none; margin-top: -3px; border: solid var(--color-text-muted); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }
.issue-query-filters--compact .query-filter[open] summary::after { margin-top: 3px; transform: rotate(225deg); }
.issue-query-filters--compact .query-filter[open] { border-color: var(--color-primary); }
.issue-query-filters--compact legend { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.issue-query-filters--compact .query-options { position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; width: min(280px, calc(100vw - 48px)); max-height: min(360px, 55vh); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 8px; box-shadow: 0 6px 18px color-mix(in srgb, var(--color-text) 10%, transparent); }
.issue-query-filters--compact .query-filter:last-child .query-options { left: auto; right: 0; }
.issue-query-filters--compact label { min-height: 32px; }
@media (max-width: 940px) { summary, label { min-height: 44px; } }
@media (max-width: 940px) { .issue-query-filters--compact label { min-height: 44px; } }
@media (max-width: 640px) {
  .issue-query-filters--compact { position: relative; margin-left: 0; width: 100%; }
  .issue-query-filters--compact .query-filter { position: static; }
  .issue-query-filters--compact .query-filter .query-options,
  .issue-query-filters--compact .query-filter:last-child .query-options { left: 0; right: auto; }
}
</style>
