<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import PageState from "../components/PageState.vue";
import WorkAssigneeFilter from "../components/WorkAssigneeFilter.vue";
import IssueQueryFilters from "../components/IssueQueryFilters.vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import { ColumnPagination } from "../lib/column-pagination";
import { containerChoiceLabels } from "../lib/container-choice";
import { locale, t } from "../lib/i18n";
import { statusDisplayName } from "../lib/status-display";
import { cursorRequiresRestart } from "../lib/pagination";
import { priorityText } from "../lib/priority";
import { groupProjects } from "../lib/project-navigation";
import { navigate } from "../lib/router";
import { isVerifiedServiceAccessFailure, projectInventoryBoundary } from "../lib/session-boundary";
import { resolvedWorkScope, workListPath, workProjects, type ResolvedWorkScope, type WorkListFilter } from "../lib/work-list";
import type { IssueSummary, ListResult, StatusKey, WebSessionView } from "../types";
const props = defineProps<{ session: WebSessionView }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const filter = reactive<WorkListFilter>({ projects: [], queue: "all", assignee: "", status: "", search: "", priorities: [], labels: [] });
const page = reactive(new ColumnPagination<IssueSummary>());
const applied = ref(false);
const resolved = ref<ResolvedWorkScope | null>(null);
let generation = 0;
const projects = computed(() => workProjects(props.session));
const groups = computed(() => groupProjects(projects.value, []));
const selectedProjects = computed(() => projects.value.filter(project => filter.projects.includes(project.project_id)));
const labels = computed(() => containerChoiceLabels(projects.value.map(project => ({ id: project.project_id, name: project.project_display_name, workspaceName: project.workspace_display_name }))));
const candidates = computed(() => filter.queue === "unassigned" || filter.queue === "needs_reassignment");
const statuses: StatusKey[] = ["backlog", "todo", "in_progress", "done", "canceled"];
function statusLabel(status: StatusKey): string {
  return statusDisplayName({ key: status }, locale.value);
}
const canLoad = computed(() => workListPath(filter, props.session) !== null);
function clear(): void { generation++; page.reset(); resolved.value = null; applied.value = false; }
async function load(reset = false): Promise<void> {
  if (!canLoad.value) { clear(); return; }
  if (reset) { generation++; resolved.value = null; }
  const current = generation;
  applied.value = true;
  await page.load(async cursor => {
    const path = workListPath(filter, props.session, cursor);
    if (path === null) throw new Error(ui("Choose 1–20 available projects.", "请选择 1–20 个可访问项目。"));
    const response = await apiRequest<ListResult<IssueSummary>>(path);
    if (current === generation) resolved.value = resolvedWorkScope(response.resolved_scope);
    return response;
  }, reset);
  if (current !== generation) return;
  if (cursorRequiresRestart(page.error)) resolved.value = null;
  if (page.error instanceof ApiProblem && isVerifiedServiceAccessFailure(page.error.status, page.error.body)) {
    const failure = page.error; page.reset(); resolved.value = null; page.error = failure;
  }
}
watch(() => JSON.stringify(filter), clear, { flush: "sync" });
watch(() => projectInventoryBoundary(props.session.allowed_scope.projects), () => {
  clear(); filter.projects = filter.projects.filter(id => projects.value.some(project => project.project_id === id)); filter.assignee = "";
});
watch(() => filter.projects.join(","), () => { filter.assignee = ""; filter.labels = []; }, { flush: "sync" });
onUnmounted(clear);
</script>
<template>
  <main class="page-shell work-page">
    <header class="page-title-block"><p class="eyebrow">cfKanban</p><h1>{{ ui('Work list', '工作清单') }}</h1><p>{{ ui('Choose projects to read together. Only the selected projects are queried.', '明确选择要一起查看的项目，只读取选中的项目。') }}</p></header>
    <form class="work-filters" @submit.prevent="load(true)">
      <fieldset class="work-projects"><legend>{{ ui('Projects', '项目') }} · {{ filter.projects.length }}/20</legend>
        <div v-for="group in groups" :key="group.id" class="work-project-group"><strong>{{ group.name }}</strong><label v-for="project in group.projects" :key="project.project_id" :title="labels.get(project.project_id)?.title"><input v-model="filter.projects" type="checkbox" :value="project.project_id" :disabled="filter.projects.length >= 20 && !filter.projects.includes(project.project_id)" />{{ labels.get(project.project_id)?.label }}</label></div>
        <p v-if="!projects.length">{{ ui('No available projects.', '暂无可访问项目。') }}</p>
      </fieldset>
      <div class="work-filter-row">
        <label>{{ ui('View', '视图') }}<select v-model="filter.queue"><option value="all">{{ ui('All issues', '全部事项') }}</option><option value="mine">{{ ui('My tasks', '我的任务') }}</option><option value="unassigned">{{ ui('Ready to claim', '待领取') }}</option><option value="needs_reassignment">{{ ui('Needs reassignment', '需重指派') }}</option></select></label>
        <label v-if="!candidates">{{ ui('Status', '状态') }}<select v-model="filter.status"><option value="">{{ ui('All statuses', '全部状态') }}</option><option v-for="status in statuses" :key="status" :value="status">{{ statusLabel(status) }}</option></select></label>
        <WorkAssigneeFilter v-if="filter.queue === 'all'" v-model="filter.assignee" :projects="selectedProjects" :principal-id="session.principal.id" />
        <label>{{ ui('Search', '搜索') }}<UInput class="w-full" v-model="filter.search" type="search" :placeholder="ui('Title or CFK number', '标题或 CFK 编号')" /></label>
      </div>
      <IssueQueryFilters v-model:priorities="filter.priorities" v-model:labels="filter.labels" :projects="selectedProjects" />
      <p v-if="selectedProjects.some(project => project.role === 'reader')" class="muted-copy">{{ ui('Reader access allows viewing work; assignment and changes require writer access in that project.', '只读项目可以查看事项；领取、指派和修改需要该项目的协作者权限。') }}</p>
      <p v-if="candidates" class="muted-copy">{{ ui('Candidate queues contain only startable Todo issues, ordered by priority then oldest first. Viewing a queue does not assign work.', '候选队列只包含可开始的待办事项，按优先级与创建先后排序。查看队列不会领取或指派任务。') }}</p>
      <div class="form-actions"><UButton color="primary" variant="solid" class="primary-button" type="submit" :disabled="!canLoad || page.loading">{{ ui('Show work', '查看工作') }}</UButton><UButton color="neutral" variant="ghost" v-if="filter.projects.length" class="text-button" type="button" @click="filter.projects = []">{{ ui('Clear selection', '清空选择') }}</UButton></div>
    </form>
    <p v-if="!applied" class="empty-copy">{{ filter.projects.length ? ui('Apply the selection and filters to load work.', '点击“查看工作”应用项目范围和筛选。') : ui('Select at least one project to begin.', '请先选择至少一个项目。') }}</p>
    <PageState :loading="page.loading && !page.items.length" :error="page.error ? errorText(page.error) : ''" :action-label="ui('Retry', '重试')" @retry="load()" />
    <div v-if="resolved" class="resolved-work-scope">
      <p>{{ ui('Resolved project scope', '实际读取项目范围') }}：{{ resolved.projects.map(project => `${project.workspace_display_name} / ${project.project_display_name}`).join(' · ') || ui('None', '无') }}</p>
      <p v-if="resolved.unresolvedProjects.length" class="warning-panel" role="status">{{ ui('These selected projects are unavailable or outside your current access. Their work is not included:', '以下选中项目当前不可访问或超出当前权限，其事项未计入结果：') }} {{ resolved.unresolvedProjects.map(id => labels.get(id)?.label ?? id).join(' · ') }}</p>
    </div>
    <section v-if="applied" :aria-label="ui('Selected project work', '所选项目的工作')" class="work-results">
      <p v-if="!page.loading && !page.error && !page.items.length" class="empty-copy">{{ ui('No issues match these filters.', '没有符合筛选条件的事项。') }}</p>
      <article v-for="issue in page.items" :key="issue.id" class="work-row">
        <div><p class="muted-copy">{{ issue.workspace.display_name }} / {{ issue.project.display_name }}</p><UButton color="neutral" variant="ghost" class="text-button work-issue" type="button" @click="navigate(`/app/issues/${issue.identifier}`)"><code>{{ issue.identifier }}</code><strong>{{ issue.title }}</strong></UButton></div>
        <div class="work-row-facts"><span>{{ statusDisplayName(issue.status, locale) }}</span><span>{{ priorityText(issue.priority, locale === 'zh-CN') }}</span><span>{{ issue.assignee?.display_name ?? t('issue.unassigned') }}</span><span v-if="issue.needs_reassignment" class="warning-chip">{{ ui('Needs reassignment', '需重指派') }}</span></div>
      </article>
      <UButton color="neutral" variant="outline" v-if="page.cursor && !page.error" class="load-more" type="button" :disabled="page.loading" @click="load()">{{ page.loading ? ui('Loading…', '加载中…') : ui('Load more', '加载更多') }}</UButton>
    </section>
  </main>
</template>
<style scoped>
.work-page { max-width: 1200px; }
.work-filters { display: grid; gap: 20px; }
.work-projects { border: 1px solid var(--color-border); border-radius: 6px; padding: 16px; display: flex; flex-wrap: wrap; gap: 20px 32px; max-height: 280px; overflow: auto; }
.work-project-group { display: grid; align-content: start; gap: 10px; min-width: 200px; max-width: 100%; }
.work-project-group label { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.work-project-group input { width: 18px; height: 18px; min-height: 18px; flex: none; }
.work-filter-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; align-items: start; }
.work-filter-row > label { display: grid; gap: 8px; }
.work-results { margin-top: 24px; }
.work-row { border-top: 1px solid var(--color-border); display: flex; gap: 20px; align-items: center; justify-content: space-between; padding: 16px 0; }
.work-row p { margin: 0 0 8px; font-size: 12px; }
.work-issue { display: flex; text-align: start; gap: 12px; overflow-wrap: anywhere; }
.work-issue code { white-space: nowrap; }
.work-row-facts { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 13px; color: var(--color-text-muted); }
@media (max-width: 700px) { .work-row { display: grid; gap: 12px; } .work-filter-row { grid-template-columns: minmax(0, 1fr); } .work-issue { flex-wrap: wrap; } }
</style>
