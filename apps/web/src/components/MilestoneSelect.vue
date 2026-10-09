<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { apiRequest, errorText } from "../lib/api";
import { ColumnPagination } from "../lib/column-pagination";
import { locale } from "../lib/i18n";
import type { IssueMilestone, ListResult, MilestoneResource } from "../types";

const props = defineProps<{ workspaceId: string; projectId: string; value: string; current?: IssueMilestone | null | undefined; allowAny?: boolean; disabled?: boolean; resetKey?: string }>();
const emit = defineEmits<{ "update:value": [value: string] }>();
const page = reactive(new ColumnPagination<MilestoneResource>());
const menu = ref<HTMLDetailsElement | null>(null);
const selectedResource = ref<MilestoneResource | null>(null);
const selectedError = ref<unknown>(null);
let generation = 0;
let listeningDocument: Document | null = null;
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const selected = computed(() => page.items.find(item => item.id === props.value) ?? (props.current?.id === props.value ? props.current : null) ?? (selectedResource.value?.id === props.value ? selectedResource.value : null));
const selectionLabel = computed(() => props.value === "all" && props.allowAny ? ui("Any milestone", "不限里程碑") : props.value === "none" ? ui("No milestone", "不归属里程碑") : selected.value?.title ?? ui("Selected milestone", "已选择的里程碑"));

function reset(): void {
  generation += 1;
  page.reset();
  selectedResource.value = null; selectedError.value = null;
  if (menu.value) menu.value.open = false;
}
watch(() => `${props.workspaceId}/${props.projectId}/${props.resetKey ?? ""}`, () => { reset(); void readSelection(); });
watch(() => props.value, () => { selectedResource.value = null; selectedError.value = null; void readSelection(); });
watch(() => props.disabled, disabled => { if (disabled && menu.value) menu.value.open = false; else if (!disabled) void readSelection(); });
function closeOutside(event: Event): void {
  const root = menu.value;
  if (!root?.open) return;
  const NodeClass = listeningDocument?.defaultView?.Node;
  const inside = event.composedPath?.().includes(root)
    || (NodeClass && event.target instanceof NodeClass && root.contains(event.target as Node));
  if (!inside) root.open = false;
}
onMounted(() => {
  void readSelection();
  listeningDocument = menu.value?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  listeningDocument?.addEventListener("pointerdown", closeOutside);
});
onUnmounted(() => { reset(); listeningDocument?.removeEventListener("pointerdown", closeOutside); listeningDocument = null; });
async function readSelection(): Promise<void> {
  if (props.disabled || props.value === "none" || props.value === "all" || selected.value !== null) return;
  const current = generation;
  const id = props.value;
  const isCurrent = () => current === generation && id === props.value && !props.disabled;
  try {
    const result = await apiRequest<MilestoneResource>(`/api/v1/milestones/${encodeURIComponent(id)}`, { authorizationCurrent: isCurrent });
    if (isCurrent() && result.project_id === props.projectId && result.workspace_id === props.workspaceId) selectedResource.value = result;
  } catch (caught) { if (isCurrent()) selectedError.value = caught; }
}
async function load(resetPage = false): Promise<void> {
  if (props.disabled) return;
  const current = generation;
  await page.load(cursor => {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return apiRequest<ListResult<MilestoneResource>>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/milestones?${params}`, { authorizationCurrent: () => current === generation && !props.disabled });
  }, resetPage);
}
function opened(): void {
  if (props.disabled) { if (menu.value) menu.value.open = false; return; }
  if (menu.value?.open && !page.loaded && !page.loading && !page.error) void load();
}
function select(value: string): void {
  if (props.disabled) return;
  emit("update:value", value);
  if (menu.value) { menu.value.open = false; menu.value.querySelector<HTMLElement>("summary")?.focus(); }
}
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); return; }
  if (event.key === "Escape" && menu.value?.open) { event.preventDefault(); menu.value.open = false; menu.value.querySelector<HTMLElement>("summary")?.focus(); }
}
</script>

<template>
  <details ref="menu" class="milestone-select" @toggle="opened" @keydown="onKeydown">
    <summary :aria-disabled="disabled" :title="selectionLabel" @click="disabled && $event.preventDefault()">{{ ui("Milestone", "里程碑") }} · {{ selectionLabel }}</summary>
    <div class="milestone-options" :aria-label="ui('Choose milestone', '选择里程碑')">
      <button v-if="allowAny" type="button" :disabled="disabled" :aria-pressed="value === 'all'" @click="select('all')">{{ ui('Any milestone', '不限里程碑') }}</button>
      <button type="button" :disabled="disabled" :aria-pressed="value === 'none'" @click="select('none')">{{ ui('No milestone', '不归属里程碑') }}</button>
      <button v-if="current && !page.items.some(item => item.id === current?.id)" type="button" :disabled="disabled" :aria-pressed="value === current.id" @click="select(current.id)">{{ current.title }} · {{ current.status_key === 'closed' ? ui('Closed', '已关闭') : ui('Open', '开放') }}</button>
      <button v-for="item in page.items" :key="item.id" type="button" :disabled="disabled" :aria-pressed="value === item.id" @click="select(item.id)">{{ item.title }} · {{ item.status_key === 'closed' ? ui('Closed', '已关闭') : ui('Open', '开放') }}</button>
      <p v-if="page.loaded && !page.items.length">{{ ui('No milestones in this project.', '此项目暂无里程碑。') }}</p>
      <p v-if="page.loading" role="status">{{ ui('Loading…', '加载中…') }}</p>
      <p v-if="page.error" role="alert">{{ errorText(page.error) }}</p>
      <p v-if="selectedError" role="alert">{{ errorText(selectedError) }}</p>
      <UButton v-if="page.cursor || page.error" color="neutral" variant="ghost" type="button" :disabled="disabled || page.loading" @click="load(!!page.error && !page.cursor)">{{ page.error ? ui('Retry', '重试') : ui('Load more', '加载更多') }}</UButton>
    </div>
  </details>
</template>

<style scoped>
.milestone-select { position: relative; min-width: 160px; max-width: 100%; }
summary { min-height: 36px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 8px; color: var(--color-text-muted); background: var(--color-surface); font-size: 13px; cursor: pointer; overflow-wrap: anywhere; }
summary[aria-disabled="true"] { opacity: .6; cursor: default; }
.milestone-options { position: absolute; z-index: 15; top: calc(100% + 4px); left: 0; display: grid; gap: 4px; min-width: 240px; max-width: min(360px, 82vw); max-height: 320px; overflow: auto; padding: 8px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); box-shadow: 0 4px 12px #00000012; }
.milestone-options > button { min-height: 36px; padding: 8px; border: 0; border-radius: 6px; text-align: left; color: var(--color-text); background: transparent; cursor: pointer; overflow-wrap: anywhere; }
.milestone-options > button[aria-pressed="true"] { background: var(--color-surface-muted); color: var(--color-primary); }
.milestone-options p { margin: 4px 8px; font-size: 12px; color: var(--color-text-muted); }
@media (max-width: 940px) { summary, .milestone-options > button { min-height: 44px; } }
</style>
