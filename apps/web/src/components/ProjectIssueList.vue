<script setup lang="ts">
import { computed, ref } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import AssigneeMenu from "./AssigneeMenu.vue";
import ListPropertySelect from "./ListPropertySelect.vue";
import IssueChildrenProgress from "./IssueChildrenProgress.vue";
import IssueStatusMark from "./IssueStatusMark.vue";
import { errorText } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { statusDisplayName } from "../lib/status-display";
import { issueTree, type IssueTreeRow } from "../lib/issue-tree";
import { sortBoardIssues } from "../lib/board-projection";
import { priorityOrder, priorityText } from "../lib/priority";
import type { ColumnPagination } from "../lib/column-pagination";
import type { IssueSummary, PriorityKey, ProjectStatusResource, StatusKey } from "../types";

const props = defineProps<{
  columns: Record<StatusKey, Pick<ColumnPagination<IssueSummary>, "items" | "cursor" | "loading" | "loaded" | "error">>;
  statuses: ProjectStatusResource[];
  eligibleStatuses: StatusKey[];
  expandedGroups: Set<StatusKey>;
  matchingCounts?: Record<StatusKey, number> | undefined;
  canWrite: boolean;
  saving: Set<string>;
  pendingIds: string[];
  assignees: Array<{ principal_id: string; display_name: string }>;
  assigneesLoading: boolean;
  assigneesHasMore: boolean;
  assigneesError: unknown;
}>();
const emit = defineEmits<{
  toggle: [status: StatusKey];
  open: [identifier: string];
  priority: [issue: IssueSummary, value: PriorityKey];
  assignee: [issue: IssueSummary, principalId: string | null];
  status: [issue: IssueSummary, event: Event];
  people: [];
  "people-more": [];
  "people-retry": [];
  more: [status: StatusKey];
  scroll: [status: StatusKey, event: Event];
}>();
const order: StatusKey[] = ["backlog", "todo", "in_progress", "done", "canceled"];
const collapsedIssues = ref(new Set<string>());
const contextIssues = computed(() => order.flatMap(key => props.columns[key].items));
const groups = computed(() => order.filter(key => props.eligibleStatuses.includes(key)).map(key => {
  const column = props.columns[key];
  return { key, column, name: statusDisplayName(props.statuses.find(status => status.key === key) ?? { key }, locale.value),
    rows: issueTree(sortBoardIssues([...column.items]), contextIssues.value) };
}));
const priorityOptions = computed(() => priorityOrder.map(value => ({ value, label: priorityText(value, locale.value === "zh-CN") })));
const statusOptions = computed(() => props.statuses.map(status => ({ value: status.key, label: statusDisplayName(status, locale.value) })));
const disabled = (issue: IssueSummary) => props.saving.has(issue.id) || props.pendingIds.includes(issue.id);
function priorityChanged(issue: IssueSummary, event: Event): void {
  const value = (event.target as HTMLSelectElement).value as PriorityKey;
  if (priorityOrder.includes(value)) emit("priority", issue, value);
}
function toggle<T>(set: Set<T>, key: T): Set<T> {
  const result = new Set(set);
  if (result.has(key)) result.delete(key); else result.add(key);
  return result;
}
function visibleRows(rows: IssueTreeRow<IssueSummary>[], status: StatusKey) {
  let hiddenBelow: number | undefined;
  return rows.filter(row => {
    if (hiddenBelow !== undefined && row.depth > hiddenBelow) return false;
    hiddenBelow = collapsedIssues.value.has(`${status}:${row.identifier}`) ? row.depth : undefined;
    return true;
  });
}
function hasChildren(rows: IssueTreeRow<IssueSummary>[], identifier: string): boolean {
  const index = rows.findIndex(row => row.identifier === identifier);
  return index >= 0 && !!rows[index + 1] && rows[index + 1]!.depth > rows[index]!.depth;
}
</script>

<template>
  <section class="project-issue-list" :aria-label="locale === 'zh-CN' ? '项目事项列表' : 'Project Issue list'">
    <section v-for="group in groups" :key="group.key" class="issue-list-group" :data-status="group.key">
      <button type="button" class="issue-list-heading" :aria-expanded="expandedGroups.has(group.key)" :aria-controls="`board-column-${group.key}`" @click="emit('toggle', group.key)">
        <span class="list-group-disclosure" :class="{ expanded: expandedGroups.has(group.key) }" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4" /></svg></span>
        <IssueStatusMark class="list-status-dot" :status-key="group.key" />
        <strong>{{ group.name }}</strong><span :title="locale === 'zh-CN' ? '已加载事项数；+ 表示还有下一页' : 'Loaded Issues; + means more pages'">{{ group.column.loaded ? `${group.column.items.length}${group.column.cursor ? '+' : ''}` : (group.column.loading ? (locale === 'zh-CN' ? '加载中…' : 'Loading…') : group.column.error ? (locale === 'zh-CN' ? '加载失败' : 'Load failed') : (locale === 'zh-CN' ? '待加载' : 'Not loaded')) }}</span><span v-if="matchingCounts && !group.column.loaded">{{ matchingCounts[group.key] }} {{ locale === 'zh-CN' ? '项匹配，展开查看' : 'matches; expand to view' }}</span>
      </button>
      <div v-if="expandedGroups.has(group.key)" :id="`board-column-${group.key}`" class="issue-list-content" tabindex="0" :aria-label="group.name" :aria-busy="group.column.loading" @scroll="emit('scroll', group.key, $event)">
        <div v-for="row in visibleRows(group.rows, group.key)" :key="row.identifier" class="issue-list-row" :class="{ 'issue-list-context': !!row.context }" :style="{ '--tree-depth': Math.min(row.depth, 8) }" :data-identifier="row.identifier" :data-depth="row.depth">
          <button v-if="hasChildren(group.rows, row.identifier)" type="button" class="list-child-toggle" :aria-expanded="!collapsedIssues.has(`${group.key}:${row.identifier}`)" :aria-label="`${collapsedIssues.has(`${group.key}:${row.identifier}`) ? (locale === 'zh-CN' ? '展开子事项' : 'Expand sub-issues') : (locale === 'zh-CN' ? '折叠子事项' : 'Collapse sub-issues')} · ${row.identifier}`" @click="collapsedIssues = toggle(collapsedIssues, `${group.key}:${row.identifier}`)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" /><path v-if="collapsedIssues.has(`${group.key}:${row.identifier}`)" d="M8 4v8" /></svg></button>
          <span v-else class="list-child-placeholder" />
          <code class="list-identifier">{{ row.identifier }}</code>
          <template v-if="row.issue">
            <ListPropertySelect v-if="canWrite" class="list-priority" :data-priority="row.issue.priority" :value="row.issue.priority" :options="priorityOptions" :label="`${row.identifier} · ${t('issue.priority')}`" :disabled="disabled(row.issue)" @change="priorityChanged(row.issue, $event)" />
            <span v-else class="list-priority">{{ priorityText(row.issue.priority, locale === 'zh-CN') }}</span>
            <div class="list-title-cell"><button type="button" class="list-issue-title" :title="row.issue.title" @click="emit('open', row.identifier)">{{ row.issue.title }}</button><IssueChildrenProgress :progress="row.issue.hierarchy?.children" /><span v-if="(row.issue.hierarchy?.parent_count ?? 0) > 1" class="list-parent-count" :title="locale === 'zh-CN' ? '展示首个父事项；详情可查看全部关系' : 'Shown under its first parent; see all relations in details'">{{ locale === 'zh-CN' ? '父项' : 'Parents' }} {{ row.issue.hierarchy!.parent_count }}</span><span v-if="row.issue.needs_reassignment" class="list-warning">{{ locale === 'zh-CN' ? '需重新指派' : 'Needs reassignment' }}</span></div>
            <div v-if="canWrite" class="list-assignee"><AssigneeMenu :assignee="row.issue.assignee" :candidates="assignees" :disabled="disabled(row.issue)" :loading="assigneesLoading" :has-more="assigneesHasMore" :load-error="assigneesError ? errorText(assigneesError) : null" :label="`${row.identifier} · ${t('issue.assignee')}`" @open="emit('people')" @select="emit('assignee', row.issue, $event)" @load-more="emit('people-more')" @retry="emit('people-retry')" /></div>
            <span v-else class="list-assignee-readonly">{{ row.issue.assignee?.display_name ?? t('issue.unassigned') }}</span>
            <ListPropertySelect v-if="canWrite" class="list-status" :value="row.issue.status.key" :options="statusOptions" :disabled="disabled(row.issue)" :label="`${row.identifier} · ${t('issue.status')}`" @change="emit('status', row.issue, $event)" />
            <span v-else class="list-status">{{ statusDisplayName(row.issue.status, locale) }}</span>
          </template>
          <template v-else-if="row.context"><div class="list-context-title"><button type="button" class="list-issue-title" @click="emit('open', row.identifier)">{{ row.context.title }}</button><IssueChildrenProgress :progress="row.contextProgress" /></div><span class="list-context-status">{{ statusDisplayName(row.context.status, locale) }} · {{ locale === 'zh-CN' ? '父事项' : 'Parent' }}</span></template>
          <span v-if="row.cycle" class="list-cycle-warning" role="status">{{ locale === 'zh-CN' ? '父子关系存在循环，已停止展开' : 'Cyclic parent relation; expansion stopped' }}</span>
        </div>
        <p v-if="group.column.loaded && !group.column.items.length && !group.column.loading && !group.column.error" class="list-page-state">{{ locale === 'zh-CN' ? '此状态暂无事项。' : 'No Issues in this status.' }}</p>
        <div class="list-page-state">
          <p v-if="group.column.loading" role="status">{{ locale === 'zh-CN' ? '正在加载事项…' : 'Loading Issues…' }}</p>
          <p v-else-if="group.column.error" role="alert">{{ errorText(group.column.error) }}</p>
          <p v-else-if="group.column.loaded && !group.column.cursor && group.column.items.length">{{ locale === 'zh-CN' ? '符合筛选条件的事项已加载完毕。' : 'All matching Issues are loaded.' }}</p>
          <UButton v-if="group.column.cursor || group.column.error" color="neutral" variant="ghost" size="sm" :disabled="group.column.loading" @click="emit('more', group.key)">{{ group.column.error ? (locale === 'zh-CN' ? '重试' : 'Retry') : (locale === 'zh-CN' ? '加载更多' : 'Load more') }}</UButton>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.project-issue-list { display: grid; gap: 20px; margin-top: 20px; }
.issue-list-heading { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 8px 12px; border: 0; border-radius: 8px; background: var(--color-surface-muted); color: var(--color-text-muted); font-size: 13px; text-align: left; cursor: pointer; }
.issue-list-heading strong { color: var(--color-text); }
.list-group-disclosure { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--color-surface); }
.list-group-disclosure svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; }
.list-group-disclosure.expanded svg { transform: rotate(90deg); }
.issue-list-content { max-height: 540px; overflow: auto; overscroll-behavior: contain; padding: 8px 2px 0; }
.issue-list-row { position: relative; display: grid; grid-template-columns: 24px 80px 64px minmax(180px, 1fr) 154px 130px; gap: 8px; align-items: center; min-height: 52px; margin-left: calc(var(--tree-depth) * 22px); border-bottom: 1px solid var(--color-border); font-size: 13px; }
.issue-list-row[data-depth]:not([data-depth="0"])::before { content: ''; position: absolute; left: -12px; top: 0; width: 9px; height: 25px; border-left: 1px solid var(--color-border-strong); border-bottom: 1px solid var(--color-border-strong); border-radius: 0 0 0 4px; }
.list-child-toggle, .list-child-placeholder { width: 24px; height: 32px; }
.list-child-toggle { display: grid; place-items: center; border: 0; background: transparent; color: var(--color-text-muted); cursor: pointer; }
.list-child-toggle svg { width: 16px; height: 16px; border: 1px solid var(--color-border-strong); border-radius: 3px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.list-identifier { color: var(--color-text-muted); font-size: 11px; }
.list-title-cell, .list-context-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; padding-block: 8px; }
.list-issue-title { flex: 0 1 auto; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; border: 0; background: transparent; color: var(--color-text); font: inherit; font-weight: 500; text-align: left; cursor: pointer; }
.list-issue-title:hover { color: var(--color-primary); }
.list-assignee { min-width: 0; }
.list-assignee :deep(.assignee-menu-trigger) { gap: 6px; padding-inline: 2px; border: 0; border-radius: 0; }
.list-assignee :deep(.assignee-menu-chevron) { display: none; }
.list-assignee :deep(.assignee-menu-trigger)::after { content: ''; flex: none; border: 4px solid transparent; border-top-color: currentColor; transform: translateY(2px); }
.list-assignee-readonly, .list-priority, .list-status, .list-parent-count, .list-context-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-muted); font-size: 12px; }
.list-priority[data-priority="urgent"] { color: var(--color-danger); }
.list-priority[data-priority="high"] { color: var(--color-warning); }
.issue-list-context .list-context-title { grid-column: 3 / 5; }
.list-context-status { grid-column: 5 / 7; justify-self: end; }
.list-cycle-warning { grid-column: 3 / -1; color: var(--color-warning); padding-bottom: 8px; }
.list-warning { color: var(--color-warning); font-size: 12px; }
.list-page-state { padding: 8px 10px; color: var(--color-text-muted); font-size: 12px; }
.list-page-state p { margin: 0; }
@media (max-width: 940px) {
  .issue-list-row { grid-template-columns: 24px 74px 54px minmax(120px, 1fr); gap: 6px; margin-left: calc(var(--tree-depth) * 14px); padding-block: 4px; }
  .list-assignee, .list-assignee-readonly { grid-column: 2 / 4; }
  .list-status { grid-column: 4; justify-self: end; }
  .list-context-status { grid-column: 2 / -1; }
  .list-property, .list-child-toggle { min-height: 44px; }
  .list-title-cell { padding-block: 4px; }
}
</style>
