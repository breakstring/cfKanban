<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import { locale } from "../lib/i18n";
import { nextSearchCandidateId, projectSearchCandidates, typedIssueSearch } from "../lib/project-search";
import { statusDisplayName } from "../lib/status-display";
import type { IssueSummary } from "../types";

const props = defineProps<{ modelValue: string; issues: IssueSummary[]; projectId: string; appliedSearch: string; disabled: boolean; resetKey: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; search: []; open: [identifier: string] }>();
const focused = ref(false);
const dismissed = ref(false);
const composing = ref(false);
const settledInput = ref(props.modelValue);
const activeId = ref<string | null>(null);
const popup = ref<HTMLElement | null>(null);
const query = computed(() => typedIssueSearch(composing.value ? settledInput.value : props.modelValue));
const candidates = computed(() => props.disabled ? { items: [], hasMore: false } : projectSearchCandidates(props.issues, props.projectId, query.value));
const expanded = computed(() => focused.value && !dismissed.value && !props.disabled && query.value.kind !== "empty");
const valid = computed(() => query.value.kind !== "invalid");
const chinese = computed(() => locale.value === "zh-CN");
const feedback = computed(() => {
  if (query.value.kind === "invalid") return query.value.reason === "long"
    ? (chinese.value ? "搜索文字过长，请缩短后重试。" : "Search text is too long. Shorten it to continue.")
    : (chinese.value ? "请输入至少两位编号或两个标题字符；完整 CFK-1 也可查询。" : "Enter at least two number digits or title characters; a complete CFK-1 also works.");
  if (!candidates.value.items.length) return chinese.value ? "已加载事项中未找到，可搜索项目。" : "No match among loaded issues. Search the Project to continue.";
  return candidates.value.hasMore
    ? (chinese.value ? "仅展示前 10 条快捷匹配。" : "Showing the first 10 quick matches.")
    : (chinese.value ? `${candidates.value.items.length} 条快捷匹配。` : `${candidates.value.items.length} quick matches.`);
});
function update(value: string): void {
  emit("update:modelValue", value);
  activeId.value = null;
  dismissed.value = false;
  if (!composing.value) settledInput.value = value;
}
function finishComposition(event: CompositionEvent): void {
  composing.value = false;
  update((event.target as HTMLInputElement).value);
}
function openCandidate(id: string): void {
  if (props.disabled || composing.value) return;
  const issue = candidates.value.items.find(candidate => candidate.id === id);
  if (!issue) { activeId.value = null; return; }
  activeId.value = null;
  dismissed.value = true;
  emit("open", issue.identifier);
}
function submit(): void {
  if (props.disabled || composing.value || !valid.value) return;
  activeId.value = null;
  dismissed.value = true;
  emit("search");
}
function keydown(event: KeyboardEvent): void {
  if (composing.value || event.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
  if (event.key === "Escape") { event.preventDefault(); activeId.value = null; dismissed.value = true; return; }
  if (props.disabled) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault(); dismissed.value = false;
    activeId.value = nextSearchCandidateId(candidates.value.items, activeId.value, event.key);
  } else if (event.key === "Enter" && activeId.value) {
    event.preventDefault(); openCandidate(activeId.value);
  }
}
watch(() => candidates.value.items.map(issue => issue.id), ids => { if (activeId.value && !ids.includes(activeId.value)) activeId.value = null; });
watch(activeId, async id => {
  await nextTick();
  const region = popup.value;
  if (!id || id !== activeId.value || !region?.querySelectorAll) return;
  const item = [...region.querySelectorAll<HTMLElement>("[role=option]")].find(element => element.id === `project-search-${id}`);
  if (!item) return;
  if (item.offsetTop < region.scrollTop) region.scrollTop = item.offsetTop;
  else if (item.offsetTop + item.offsetHeight > region.scrollTop + region.clientHeight) region.scrollTop = item.offsetTop + item.offsetHeight - region.clientHeight;
});
watch(() => props.resetKey, () => { focused.value = false; dismissed.value = true; activeId.value = null; composing.value = false; settledInput.value = ""; emit("update:modelValue", ""); });
watch(() => props.disabled, disabled => { if (disabled) { activeId.value = null; dismissed.value = true; } });
</script>

<template>
  <div class="project-search">
    <form class="board-search" role="search" @submit.prevent="submit">
      <UInput :model-value="modelValue" class="board-search-field" type="search" role="combobox" autocomplete="off" :disabled="disabled"
        :placeholder="chinese ? '按标题或编号查找；Enter 搜索项目' : 'Find by title or number; Enter searches Project'"
        :aria-label="chinese ? '搜索事项' : 'Search issues'" aria-autocomplete="list" aria-controls="project-search-candidates"
        :aria-expanded="expanded" :aria-activedescendant="activeId ? `project-search-${activeId}` : undefined" aria-describedby="project-search-scope project-search-feedback"
        @update:model-value="update(String($event))" @keydown="keydown" @focus="focused = true; dismissed = false" @blur="focused = false; activeId = null"
        @compositionstart="composing = true" @compositionend="finishComposition">
        <template #leading><svg class="ui-action-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg></template>
      </UInput>
      <UButton color="neutral" variant="outline" type="submit" :disabled="disabled || !valid">{{ chinese ? '搜索项目' : 'Search Project' }}</UButton>
    </form>
    <p id="project-search-scope" class="search-scope">{{ chinese ? '搜索当前项目，并保留已选筛选条件。' : 'Search this Project with the selected filters.' }}</p>
    <div v-if="expanded" ref="popup" class="search-popup">
      <p class="search-scope">{{ chinese ? '当前已加载结果中的快捷匹配' : 'Quick matches in currently loaded results' }}<span v-if="appliedSearch">{{ chinese ? '（来自当前已提交搜索结果）' : ' (from the currently applied search)' }}</span></p>
      <div id="project-search-candidates" role="listbox" :aria-label="chinese ? '已加载事项快捷匹配' : 'Quick matches among loaded issues'">
        <button v-for="issue in candidates.items" :id="`project-search-${issue.id}`" :key="issue.id" type="button" role="option" tabindex="-1" :aria-selected="activeId === issue.id"
          class="search-candidate" :class="{ 'search-candidate-active': activeId === issue.id }" @pointerdown.prevent @click="openCandidate(issue.id)">
          <span class="search-candidate-heading"><strong>{{ issue.identifier }}</strong><span>{{ statusDisplayName(issue.status, locale) }}</span></span>
          <span class="search-candidate-title">{{ issue.title }}</span>
        </button>
      </div>
    </div>
    <p v-if="focused && query.kind !== 'empty'" id="project-search-feedback" class="search-scope" role="status" aria-live="polite">{{ feedback }}</p>
  </div>
</template>

<style scoped>
.project-search { position: relative; flex: 0 1 560px; min-width: 0; }
.board-search { display: flex; gap: 8px; }
.board-search-field { flex: 1; min-width: 0; }
.board-search :deep(input) { min-height: 36px; font-size: 14px; }
.search-scope { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; }
.search-popup { position: absolute; top: 100%; left: 0; right: 0; z-index: 20; max-height: 420px; overflow: auto; padding: 10px; border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg); box-shadow: 0 10px 24px rgb(0 0 0 / 12%); }
.search-candidate { display: flex; flex-direction: column; width: 100%; min-height: 44px; padding: 8px; gap: 4px; text-align: left; border-radius: 8px; }
.search-candidate:hover, .search-candidate-active { background: var(--ui-bg-elevated); }
.search-candidate-heading { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.search-candidate-title { overflow-wrap: anywhere; }
@media (max-width: 820px) {
  .project-search { flex-basis: 100%; }
  .board-search :deep(input), .board-search :deep(button) { min-height: 44px; }
}
</style>
