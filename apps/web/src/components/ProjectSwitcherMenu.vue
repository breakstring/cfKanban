<script lang="ts">
export interface ProjectSwitcherItem {
  id: string;
  label: string;
  title?: string | undefined;
  current?: boolean | undefined;
  disabled?: boolean | undefined;
  description?: string | undefined;
}

export interface ProjectSwitcherGroup {
  id: string;
  label: string;
  title?: string | undefined;
  projects: readonly ProjectSwitcherItem[];
}
</script>

<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { locale } from "../lib/i18n-core";

const props = withDefaults(defineProps<{
  title: string;
  opened: boolean;
  search: string;
  groups: readonly ProjectSwitcherGroup[];
  busy?: boolean;
  error?: string | undefined;
  disabled?: boolean;
}>(), { busy: false, error: "", disabled: false });
const emit = defineEmits<{
  open: [];
  close: [];
  search: [value: string];
  retry: [];
  select: [projectId: string];
}>();
const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const placement = ref<Record<string, string>>({});
const panelId = `project-switch-${useId()}`;
const ui = (en: string, zh: string): string => locale.value === "zh-CN" ? zh : en;
let ownerDocument: Document | null = null;

function toggle(): void { if (props.opened) emit("close"); else emit("open"); }
function position(): void {
  const view = ownerDocument?.defaultView;
  const rectangle = root.value?.getBoundingClientRect();
  if (!props.opened || !view || !rectangle) return;
  const width = Math.max(0, Math.min(460, view.innerWidth - 32));
  const left = Math.max(16, Math.min(rectangle.left + (rectangle.width - width) / 2, view.innerWidth - width - 16));
  const top = Math.max(16, Math.min(rectangle.bottom + 6, view.innerHeight - 80));
  placement.value = { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${Math.max(0, Math.min(650, view.innerHeight * 0.75, view.innerHeight - top - 16))}px` };
}
function outside(event: PointerEvent): void {
  if (props.opened && root.value && !event.composedPath().includes(root.value)) emit("close");
}
function keyboard(event: KeyboardEvent): void {
  if (!props.opened) return;
  if (event.key === "Escape") { event.preventDefault(); emit("close"); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target === searchInput.value && event.key !== "ArrowDown") return;
  const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>(".project-switch-panel button:not(:disabled)") ?? [])];
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(ownerDocument?.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : (index + 1) % buttons.length;
  buttons[next]?.focus();
}
function select(project: ProjectSwitcherItem): void {
  if (!props.disabled && !project.disabled) emit("select", project.id);
}
watch(() => props.opened, async opened => {
  await nextTick();
  if (props.opened !== opened) return;
  if (opened) { position(); searchInput.value?.focus(); }
  else root.value?.querySelector<HTMLButtonElement>(".project-switch-trigger")?.focus();
});
onMounted(() => {
  ownerDocument = root.value?.ownerDocument ?? null;
  ownerDocument?.addEventListener("pointerdown", outside);
  ownerDocument?.addEventListener("scroll", position, true);
  ownerDocument?.defaultView?.addEventListener("resize", position);
  position();
});
onUnmounted(() => {
  ownerDocument?.removeEventListener("pointerdown", outside);
  ownerDocument?.removeEventListener("scroll", position, true);
  ownerDocument?.defaultView?.removeEventListener("resize", position);
});
</script>

<template>
  <div ref="root" class="project-switcher" @keydown="keyboard">
    <UButton color="neutral" variant="ghost" class="project-switch-trigger" type="button" :disabled="disabled" :aria-expanded="opened" :aria-controls="panelId" @click="toggle"><strong>{{ title }}</strong><span aria-hidden="true">▾</span></UButton>
    <section v-if="opened" :id="panelId" class="project-switch-panel" :style="placement" :aria-label="ui('Switch project', '切换项目')" :aria-busy="busy">
      <label class="project-switch-search">{{ ui("Workspace or project", "工作区或项目") }}<input ref="searchInput" :value="search" type="search" :placeholder="ui('Search workspaces or projects…', '搜索工作区或项目…')" @input="emit('search', ($event.target as HTMLInputElement).value)" /></label>
      <p v-if="busy" role="status">{{ ui("Loading…", "加载中…") }}</p>
      <div v-if="error" role="alert"><p>{{ error }}</p><UButton color="neutral" variant="ghost" class="text-button" type="button" :disabled="busy || disabled" @click="emit('retry')">{{ ui("Retry", "重试") }}</UButton></div>
      <div v-for="group in groups" :key="group.id" class="project-switch-group">
        <div class="project-switch-group-title"><h2 :title="group.title">{{ group.label }}</h2><slot name="group-action" :group="group" /></div>
        <UButton color="neutral" variant="ghost" v-for="project in group.projects" :key="project.id" class="project-switch-row" type="button" :title="project.title" :disabled="disabled || project.disabled" :aria-current="project.current ? 'page' : undefined" @click="select(project)"><span aria-hidden="true">{{ project.current ? '✓' : '' }}</span><strong>{{ project.label }}</strong><small v-if="project.description">{{ project.description }}</small></UButton>
        <p v-if="!group.projects.length" class="muted-copy">{{ ui("No projects", "暂无项目") }}</p>
      </div>
      <p v-if="!busy && !groups.length">{{ ui("No available projects", "暂无可访问项目") }}</p>
      <footer v-if="$slots.footer" class="project-switch-footer"><slot name="footer" /></footer>
    </section>
  </div>
</template>

<style scoped>
.project-switcher { position: relative; min-width: 0; }
.project-switch-trigger { display: flex; align-items: center; gap: 8px; min-height: 40px; max-width: 100%; padding: 6px 8px; border: 0; background: transparent; }
.project-switch-trigger strong { overflow: hidden; text-overflow: ellipsis; }
.project-switch-panel { position: fixed; z-index: 30; box-sizing: border-box; top: 48px; left: 16px; transform: none; width: min(460px, calc(100vw - 32px)); max-height: min(650px, 75vh); overflow-y: auto; padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card, 10px); background: var(--color-surface); box-shadow: 0 8px 24px #20201f18; color: var(--color-text); text-align: left; }
.project-switch-search { display: grid; gap: 8px; }
.project-switch-search input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-control, 8px); background: var(--color-surface); color: var(--color-text); font: inherit; }
.project-switch-search input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.project-switch-group { padding-block: 12px; border-bottom: 1px solid var(--color-border); }
.project-switch-group-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.project-switch-group-title h2 { font-size: 14px; margin: 0; overflow-wrap: anywhere; }
.project-switch-group-title :deep(button) { flex-shrink: 0; }
.project-switch-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; min-height: 44px; text-align: left; padding: 8px; border: 0; background: transparent; }
.project-switch-row:not(:disabled):hover, .project-switch-row[aria-current] { background: var(--color-surface-muted); }
.project-switch-row strong { white-space: normal; overflow-wrap: anywhere; }
.project-switch-row small, .muted-copy { color: var(--color-text-muted); }
.project-switch-row small { max-width: 9em; white-space: normal; overflow-wrap: anywhere; }
.project-switch-row:disabled { opacity: 0.65; }
.project-switch-footer { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 12px; }
</style>
