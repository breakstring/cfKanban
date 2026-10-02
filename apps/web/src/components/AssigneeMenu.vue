<script setup lang="ts">
import UAvatar from "@nuxt/ui/components/Avatar.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UDropdownMenu from "@nuxt/ui/components/DropdownMenu.vue";
import type { DropdownMenuItem } from "@nuxt/ui";
import { computed, ref, watch } from "vue";
import { locale, t } from "../lib/i18n";
import type { IssueSummary } from "../types";

interface Candidate { principal_id: string; display_name: string }
interface AssigneeMenuItem extends DropdownMenuItem { principalId?: string | null; state?: "loading" | "error" }
const props = defineProps<{
  assignee: IssueSummary["assignee"];
  candidates: readonly Candidate[];
  disabled?: boolean;
  loading?: boolean;
  hasMore?: boolean;
  loadError?: string | null;
  label?: string;
}>();
const emit = defineEmits<{
  select: [principalId: string | null];
  open: [];
  "load-more": [];
  retry: [];
}>();
const menuOpen = ref(false);
const currentName = computed(() => props.assignee?.display_name ?? t("issue.unassigned"));
const currentId = computed(() => props.assignee?.principal_id ?? null);
const candidates = computed(() => [...new Map(props.candidates.map(candidate => [candidate.principal_id, candidate])).values()]);
const ui = (english: string, chinese: string) => locale.value === "zh-CN" ? chinese : english;
const initial = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? "—";

function select(principalId: string | null): void {
  if (props.disabled || props.loading || principalId === currentId.value) return;
  if (principalId !== null && (!candidates.value.some(candidate => candidate.principal_id === principalId)
    || (principalId === props.assignee?.principal_id && !props.assignee.available))) return;
  emit("select", principalId);
}

function setOpen(value: boolean): void {
  if (value && props.disabled) return;
  const changed = value !== menuOpen.value;
  menuOpen.value = value;
  if (changed && value) emit("open");
}

const items = computed<AssigneeMenuItem[][]>(() => {
  const option = (principalId: string | null, name: string, unavailable = false): AssigneeMenuItem => ({
    label: name,
    principalId,
    type: "checkbox",
    checked: principalId === currentId.value,
    disabled: props.disabled || props.loading || unavailable,
    ...(unavailable ? { description: ui("No longer eligible", "已无指派资格") } : {}),
    onSelect: () => select(principalId),
  });
  const people = candidates.value.map(candidate => option(candidate.principal_id, candidate.display_name,
    candidate.principal_id === props.assignee?.principal_id && !props.assignee.available));
  if (props.assignee && !candidates.value.some(candidate => candidate.principal_id === props.assignee?.principal_id)) {
    people.unshift({ ...option(props.assignee.principal_id, props.assignee.display_name, !props.assignee.available), disabled: true });
  }
  const groups: AssigneeMenuItem[][] = [[option(null, t("issue.unassigned"))]];
  if (people.length) groups.push(people);
  const controls: AssigneeMenuItem[] = [];
  if (props.loading) {
    controls.push({ label: ui("Loading eligible people…", "正在加载可指派人员…"), type: "label", state: "loading" });
  } else if (props.loadError) {
    controls.push({ label: props.loadError, type: "label", state: "error" }, {
      label: ui("Retry loading people", "重试加载人员"), disabled: props.disabled,
      onSelect: event => { event.preventDefault(); if (!props.disabled) emit("retry"); },
    });
  } else if (props.hasMore) {
    controls.push({
      label: ui("Load more people", "加载更多人员"), disabled: props.disabled,
      onSelect: event => { event.preventDefault(); if (!props.disabled) emit("load-more"); },
    });
  }
  if (controls.length) groups.push(controls);
  return groups;
});
watch(() => props.disabled, disabled => { if (disabled) menuOpen.value = false; });
</script>

<template>
  <UDropdownMenu
    :open="menuOpen"
    :items="items"
    :disabled="disabled"
    :portal="true"
    :content="{ align: 'start', sideOffset: 4, collisionPadding: 8 }"
    :ui="{
      content: 'w-60 max-w-[calc(100vw-16px)]',
      viewport: 'max-h-80 overflow-y-auto overscroll-contain',
      item: 'min-h-9 max-[940px]:min-h-11',
      itemLabel: 'truncate',
      itemDescription: 'whitespace-normal',
    }"
    @update:open="setOpen"
  >
    <UButton
      color="neutral"
      variant="ghost"
      type="button"
      class="assignee-menu-trigger"
      :disabled="disabled"
      :title="currentName"
      :aria-label="`${label ?? t('issue.assignee')} · ${currentName}`"
      :aria-busy="loading"
      :draggable="false"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @keydown.stop
      @dragstart.stop.prevent
    >
      <UAvatar :text="assignee ? initial(assignee.display_name) : '—'" :alt="currentName" size="2xs" aria-hidden="true" />
      <span class="assignee-menu-name">{{ currentName }}</span>
      <svg class="assignee-menu-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </UButton>
    <template #item-leading="{ item }">
      <UAvatar v-if="item.principalId !== undefined" :text="item.principalId === null ? '—' : initial(item.label ?? '')" :alt="item.label ?? ''" size="2xs" aria-hidden="true" />
    </template>
    <template #item-label="{ item }">
      <span v-if="item.state === 'loading'" role="status" class="assignee-menu-message">{{ item.label }}</span>
      <span v-else-if="item.state === 'error'" role="alert" class="assignee-menu-message">{{ item.label }}</span>
      <template v-else>{{ item.label }}</template>
    </template>
  </UDropdownMenu>
</template>

<style scoped>
.assignee-menu-trigger { display: inline-flex; justify-content: flex-start; gap: 6px; min-width: 0; width: fit-content; max-width: 100%; min-height: 32px; padding: 4px 3px; border-radius: 6px; color: var(--color-text-muted); background: transparent; font-size: 12px; font-weight: 400; }
.assignee-menu-trigger:hover:not(:disabled), .assignee-menu-trigger[data-state="open"] { background: var(--color-surface-muted); color: var(--color-text); }
.assignee-menu-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assignee-menu-chevron { flex: none; width: 12px; height: 12px; margin-left: -2px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.assignee-menu-message { display: block; white-space: normal; overflow-wrap: anywhere; font-size: 12px; font-weight: 400; }
@media (max-width: 940px) { .assignee-menu-trigger { min-height: 44px; } }
</style>
