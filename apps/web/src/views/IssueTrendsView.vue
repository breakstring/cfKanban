<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import IssueTrendChart from "../components/IssueTrendChart.vue";
import MilestoneSelect from "../components/MilestoneSelect.vue";
import PageState from "../components/PageState.vue";
import { apiRequest } from "../lib/api";
import { boardFilters, boardPath, boardReturnPath } from "../lib/board-navigation";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale } from "../lib/i18n";
import { canReadIssueTrends, isIssueTrends, issueTrendProjects, issueTrendsPath, issueTrendsSelection, type IssueTrendRequest } from "../lib/issue-trends";
import { useLocalizedError } from "../lib/localized-error";
import { navigate } from "../lib/router";
import { projectInventoryBoundary, sessionBoundaryKey } from "../lib/session-boundary";
import type { ContainerResource, IssueTrends, WebSessionView } from "../types";

const props = defineProps<{ workspaceId: string; projectId?: string | undefined; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string; workspaceId: string; projectId?: string }] }>();
const initial = issueTrendsSelection(window.location.search);
const days = ref(initial.days);
const milestone = ref(props.projectId ? initial.milestoneId : "all");
const selectedProjects = ref(initial.projectIds);
const allProjects = ref(initial.allProjects);
const loading = ref(false);
const result = ref<IssueTrends | null>(null);
const project = ref<ContainerResource | null>(null);
const { error, clearError, setError } = useLocalizedError();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const projects = computed(() => issueTrendProjects(props.session, props.workspaceId));
const scope = computed(() => projects.value.find(item => item.project_id === props.projectId));
const active = computed(() => canReadIssueTrends(props.session, props.workspaceId, props.projectId));
const labels = computed(() => containerChoiceLabels(projects.value.map(item => ({ id: item.project_id, name: item.project_display_name }))));
const historyLabels = computed(() => containerChoiceLabels((result.value?.projects ?? []).map(item => ({ id: item.id, name: item.display_name }))));
const workspaceName = computed(() => project.value?.workspace_display_name ?? projects.value[0]?.workspace_display_name ?? ui("Workspace", "工作区"));
const projectName = computed(() => project.value?.display_name ?? scope.value?.project_display_name ?? ui("Project", "项目"));
const title = computed(() => props.projectId ? projectName.value : workspaceName.value);
const returnTo = computed(() => props.projectId ? boardReturnPath(props.workspaceId, props.projectId, window.location.search) : "/app");
const boardView = computed(() => boardFilters(new URL(returnTo.value, window.location.origin).search));
const chartPoints = computed(() => (result.value?.points ?? []).map(point => ({ ...point })));
const lastPoint = computed(() => result.value?.points.at(-1));
const hasMissing = computed(() => result.value?.points.some(point => point.unfinished === null || point.created === null || point.completed === null || (result.value?.scope.milestone_id && (point.total === null || point.done === null))) ?? false);
const pendingHistory = computed(() => result.value?.projects.some(item => item.history_state === "pending") ?? false);
const request = computed<IssueTrendRequest>(() => ({ workspaceId: props.workspaceId, projectId: props.projectId,
  days: days.value, ...(props.projectId && milestone.value !== "all" ? { milestoneId: milestone.value } : {}),
  ...(!props.projectId && !allProjects.value ? { projectIds: [...selectedProjects.value] } : {}) }));
const canLoad = computed(() => active.value && (props.projectId !== undefined || allProjects.value || selectedProjects.value.length > 0) && issueTrendsPath(request.value) !== null);
const number = (value: number | null | undefined) => value === null || value === undefined ? ui("Unknown", "未知") : new Intl.NumberFormat(locale.value).format(value);
let generation = 0;
let controller: AbortController | null = null;

function invalidate(): void {
  generation += 1;
  controller?.abort(); controller = null;
  loading.value = false; result.value = null; project.value = null; clearError();
}
async function load(): Promise<void> {
  invalidate();
  const current = generation;
  const captured = request.value;
  const path = issueTrendsPath(captured);
  if (!canLoad.value || path === null) return;
  const abort = new AbortController(); controller = abort;
  const isCurrent = () => current === generation && !abort.signal.aborted && active.value;
  loading.value = true;
  try {
    const [trends, container] = await Promise.all([
      apiRequest<IssueTrends>(path, { signal: abort.signal, authorizationCurrent: isCurrent, validateResponse: value => isIssueTrends(value, captured) }),
      props.projectId ? apiRequest<ContainerResource>(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}`, { signal: abort.signal, authorizationCurrent: isCurrent }) : Promise.resolve(null),
    ]);
    if (!isCurrent()) return;
    if (container && (container.id !== props.projectId || container.deleted_at !== null)) throw new Error(ui("This project is unavailable. Choose a current project.", "此项目当前不可访问，请选择有效项目。"));
    if (!(props.session.principal.is_owner && props.session.allowed_scope.kind === "instance") && trends.scope.project_ids.some(id => !projects.value.some(item => item.project_id === id))) {
      throw new Error(ui("Project access changed. Refresh your session before trying again.", "项目访问范围已变化，请刷新会话后重试。"));
    }
    project.value = container; result.value = trends;
    emit("context", { label: props.projectId ? `${workspaceName.value} / ${projectName.value}` : workspaceName.value,
      role: scope.value?.role ?? (props.session.principal.is_owner ? "owner" : "reader"), workspaceId: props.workspaceId, ...(props.projectId ? { projectId: props.projectId } : {}) });
  } catch (caught) { if (isCurrent()) { result.value = null; project.value = null; setError(caught); } }
  finally { if (isCurrent()) { loading.value = false; controller = null; } }
}
function projectView(view: "board" | "list" | "milestones"): void {
  if (!props.projectId) return;
  if (view === "milestones") navigate(`/app/w/${props.workspaceId}/p/${props.projectId}/milestones?${new URLSearchParams({ from: returnTo.value })}`);
  else {
    const { view: _view, ...filters } = boardView.value;
    navigate(boardPath(props.workspaceId, props.projectId, view === "list" ? { ...filters, view: "list" } : filters));
  }
}
function changeAllProjects(value: boolean): void {
  allProjects.value = value;
  if (!value && !selectedProjects.value.length && projects.value.length <= 100) selectedProjects.value = projects.value.map(item => item.project_id);
}
watch(() => `${props.workspaceId}/${props.projectId ?? ""}/${sessionBoundaryKey(props.session)}/${projectInventoryBoundary(props.session.allowed_scope.projects)}`, () => {
  selectedProjects.value = selectedProjects.value.filter(id => projects.value.some(item => item.project_id === id));
  void load();
}, { immediate: true, flush: "sync" });
watch(() => JSON.stringify(request.value), () => { void load(); }, { flush: "sync" });
watch(allProjects, () => { void load(); }, { flush: "sync" });
onUnmounted(invalidate);
</script>

<template>
  <main class="board-page trends-page">
    <header class="board-toolbar">
      <div class="board-title"><div class="board-heading-row"><p class="eyebrow">{{ projectId ? workspaceName : 'cfKanban' }}</p><h1>{{ title }}</h1></div><p class="trends-subtitle">{{ projectId ? ui('Project issue trends', '项目事项趋势') : ui('Workspace issue trends', '工作区事项趋势') }}</p></div>
      <div class="board-toolbar-actions"><UButton color="neutral" variant="outline" type="button" @click="navigate('/app')">{{ ui('Choose project', '选择项目') }}</UButton></div>
      <div class="board-utility-bar">
        <div v-if="projectId" class="board-view-bar" role="group" :aria-label="ui('Project view', '项目视图')">
          <button class="board-view-label board-view-inactive" type="button" @click="projectView('board')">{{ ui('Board', '看板') }}</button>
          <button class="board-view-label board-view-inactive" type="button" @click="projectView('list')">{{ ui('List', '列表') }}</button>
          <button class="board-view-label board-view-inactive" type="button" @click="projectView('milestones')">{{ ui('Milestones', '里程碑') }}</button>
          <button class="board-view-label" type="button" aria-current="page" :aria-pressed="true">{{ ui('Trends', '趋势') }}</button>
        </div>
        <span v-else class="workspace-trends-label">{{ ui('Trends', '趋势') }}</span>
        <div class="trend-filter-controls" role="group" :aria-label="ui('Trend filters', '趋势筛选')">
          <MilestoneSelect v-if="projectId" v-model:value="milestone" :workspace-id="workspaceId" :project-id="projectId" :reset-key="sessionBoundaryKey(session)" allow-any :allow-none="false" :disabled="!active" />
          <USelect v-model="days" :items="[{ value: 30, label: ui('Last 30 days', '最近 30 天') }, { value: 90, label: ui('Last 90 days', '最近 90 天') }, { value: 365, label: ui('Last 365 days', '最近 365 天') }]" :aria-label="ui('Date window', '日期窗口')" />
          <UButton color="neutral" variant="ghost" type="button" :disabled="loading || !canLoad" @click="load">{{ ui('Refresh', '刷新') }}</UButton>
        </div>
      </div>
    </header>
    <p v-if="!active" class="empty-copy" role="status">{{ ui('This scope is outside your current access. Choose an available project.', '此范围超出当前访问权限，请选择可访问项目。') }}</p>
    <template v-else>
      <details v-if="!projectId && projects.length" class="trend-project-selection">
        <summary>{{ ui('Projects', '项目') }} · {{ allProjects ? ui('All currently accessible projects', '当前全部可访问项目') : `${selectedProjects.length}/100` }}</summary>
        <div class="trend-project-options">
          <label><input type="checkbox" :checked="allProjects" @change="changeAllProjects(($event.target as HTMLInputElement).checked)" />{{ ui('All currently accessible projects', '当前全部可访问项目') }}</label>
          <fieldset v-if="!allProjects"><legend>{{ ui('Select up to 100 projects', '最多选择 100 个项目') }}</legend><label v-for="item in projects" :key="item.project_id" :title="labels.get(item.project_id)?.title"><input v-model="selectedProjects" type="checkbox" :value="item.project_id" :disabled="selectedProjects.length >= 100 && !selectedProjects.includes(item.project_id)" />{{ labels.get(item.project_id)?.label }}</label></fieldset>
        </div>
      </details>
      <p v-if="!canLoad" class="empty-copy">{{ ui('Select at least one accessible project.', '请至少选择一个可访问项目。') }}</p>
      <PageState :loading="loading" :error="error" :action-label="ui('Retry', '重试')" @retry="load" />
      <template v-if="result">
        <p class="trend-period muted-copy">{{ result.from_date }} — {{ result.to_date }} · UTC · {{ ui('Today is still in progress. Observed at', '当日尚未结束。观测时间') }} {{ result.observed_at }}</p>
        <p class="muted-copy">{{ ui('Scope includes the currently accessible, active projects listed below. Each parent and child issue counts separately.', '统计范围为下方列出的当前可访问、未归档项目。父子事项各自计一件。') }}</p>
        <p v-if="!result.projects.length" class="empty-copy">{{ ui('There are no accessible active projects in this workspace.', '此工作区当前没有可访问的未归档项目。') }}</p>
        <p v-if="pendingHistory || hasMissing" class="warning-panel" role="status">{{ pendingHistory ? ui('Older history is being filled in. Available dates are shown; missing dates remain gaps.', '旧历史正在补齐。已知日期会显示数值，缺失日期保留断点。') : ui('Some earlier history could not be recovered. Missing values are unknown, not zero.', '部分旧历史无法恢复。缺失值表示未知，不代表零。') }}</p>
        <div v-if="result.projects.length" class="trend-current-facts"><div><span>{{ ui('Current unfinished', '当前未完成') }}</span><strong>{{ number(lastPoint?.unfinished) }}</strong></div><div><span>{{ ui('Current done', '当前已完成') }}</span><strong>{{ number(lastPoint?.done) }}</strong></div><div><span>{{ ui('Current total', '当前总范围') }}</span><strong>{{ number(lastPoint?.total) }}</strong></div></div>
        <div v-if="result.projects.length" class="trend-charts">
          <IssueTrendChart v-if="result.scope.milestone_id" class="trend-burnup" :label="ui('Milestone burn-up', '里程碑燃起图')" :points="chartPoints" :series="[{ key: 'total', label: ui('Total scope', '总范围') }, { key: 'done', label: ui('Currently done', '当前已完成') }]" />
          <IssueTrendChart :label="ui('Unfinished issue stock', '未完成事项存量')" :points="chartPoints" :series="[{ key: 'unfinished', label: ui('Unfinished', '未完成') }]" />
          <IssueTrendChart :label="ui('Daily new issues and completions', '每日新增与完成次数')" :points="chartPoints" :series="[{ key: 'created', label: ui('Created', '新增') }, { key: 'completed', label: ui('Completion operations', '完成次数') }]" />
        </div>
        <p v-if="result.projects.length" class="muted-copy">{{ ui('Unfinished excludes done and canceled issues. Completions count operations: completing again after reopening counts again. Restoring or moving an issue into a milestone is not a new issue. Burn-up shows the scope and done stock on each day.', '未完成不含已完成、已取消事项。完成次数按操作计数，重开后再次完成会再次计数；恢复或移入里程碑不算新增。燃起图显示各日范围和已完成存量。') }}</p>
        <details v-if="result.projects.length" class="trend-coverage"><summary>{{ ui('Included projects and history coverage', '纳入项目与历史覆盖') }} · {{ result.projects.length }}</summary><ul><li v-for="item in result.projects" :key="item.id"><strong :title="historyLabels.get(item.id)?.title">{{ historyLabels.get(item.id)?.label }}</strong><span>{{ ui('Stock from', '存量起点') }}: {{ item.stock_from ?? ui('Unknown', '未知') }} · {{ ui('Daily operations from', '每日操作起点') }}: {{ item.flow_from ?? ui('Unknown', '未知') }} · {{ item.history_state === 'pending' ? ui('Filling in history', '正在补齐历史') : item.history_state === 'partial' ? ui('Partial history', '部分历史') : ui('History processed', '历史已处理') }}</span></li></ul></details>
      </template>
    </template>
  </main>
</template>

<style scoped>
.trends-page { padding: 16px 28px 24px; }
.board-toolbar { gap: 12px 16px; margin-bottom: 12px; }
.board-heading-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.board-title h1 { font-family: var(--font-ui); font-size: 24px; font-weight: 650; line-height: 1.35; letter-spacing: -.02em; }
.board-title .eyebrow { margin: 0; font-size: 12px; color: var(--color-text-muted); }
.trends-subtitle { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; }
.board-utility-bar { gap: 12px 24px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--color-border); }
.board-view-bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.board-view-label { min-height: 36px; padding: 6px 0; border: 0; border-bottom: 2px solid var(--color-primary); background: transparent; color: var(--color-primary); font-size: 14px; font-weight: 600; cursor: pointer; }
.board-view-inactive { border-bottom-color: transparent; color: var(--color-text-muted); font-weight: 400; }
.workspace-trends-label { color: var(--color-primary); font-weight: 600; }
.trend-filter-controls { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px 16px; margin-left: auto; }
.trend-project-selection, .trend-coverage { margin: 8px 0 16px; font-size: 13px; }
.trend-project-selection summary, .trend-coverage summary { cursor: pointer; width: fit-content; }
.trend-project-options { padding: 12px 0; }
.trend-project-options label { display: flex; gap: 8px; align-items: center; padding-block: 6px; overflow-wrap: anywhere; }
.trend-project-options input { min-height: 18px; width: 18px; height: 18px; flex: none; }
.trend-project-options fieldset { display: flex; flex-wrap: wrap; gap: 4px 24px; max-height: 260px; overflow: auto; margin-top: 8px; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 8px; }
.trend-current-facts { display: flex; flex-wrap: wrap; gap: 16px 40px; margin: 16px 0 24px; }
.trend-current-facts > div { display: grid; gap: 4px; }
.trend-current-facts span { color: var(--color-text-muted); font-size: 13px; }
.trend-current-facts strong { font-size: 24px; font-variant-numeric: tabular-nums; }
.trend-charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.trend-burnup { grid-column: 1 / -1; }
.trend-coverage ul { padding-left: 20px; margin-top: 12px; }
.trend-coverage li { margin-block: 10px; }
.trend-coverage li strong { display: block; overflow-wrap: anywhere; }
.trend-coverage li span { color: var(--color-text-muted); }
.trend-period { font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 1100px) { .trend-charts { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 940px) { .trends-page { padding: 12px 16px 20px; } .board-view-label, .trend-filter-controls :deep(button), .board-toolbar-actions :deep(button), .trend-project-selection summary, .trend-coverage summary { min-height: 44px; } }
@media (max-width: 640px) { .board-toolbar { grid-template-columns: minmax(0, 1fr); } .board-toolbar-actions { justify-content: flex-start; } .trend-filter-controls { justify-content: flex-start; margin-left: 0; width: 100%; } }
</style>
