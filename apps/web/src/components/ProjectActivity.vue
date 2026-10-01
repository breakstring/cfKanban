<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { onUnmounted, reactive, ref, watch } from "vue";
import PageState from "./PageState.vue";
import { apiRequest, errorText } from "../lib/api";
import { ColumnPagination } from "../lib/column-pagination";
import { resolvedWorkScope } from "../lib/work-list";
import { activityTargets } from "../lib/project-activity";
import { navigate } from "../lib/router";
import { locale } from "../lib/i18n";
import type { EventResource, ListResult } from "../types";
const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ navigate: [] }>();
function openTarget(path: string): void { if (navigate(path)) emit("navigate"); }
const page = reactive(new ColumnPagination<EventResource>());
const unavailable = ref(false);
let generation = 0;
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const names: Record<string, [string, string]> = {
  'issue.created': ['Issue created', '创建事项'], 'issue.updated': ['Issue updated', '更新事项'], 'issue.deleted': ['Issue deleted', '删除事项'], 'issue.restored': ['Issue restored', '恢复事项'],
  'issue.completed': ['Issue completed', '完成事项'], 'issue.assigned-to-self': ['Issue claimed', '领取事项'],
  'issue.label-added': ['Label added to issue', '添加事项标签'], 'issue.label-removed': ['Label removed from issue', '移除事项标签'],
  'comment.created': ['Comment added', '添加评论'], 'comment.deleted': ['Comment deleted', '删除评论'], 'comment.restored': ['Comment restored', '恢复评论'],
  'label.created': ['Label created', '创建标签'], 'label.updated': ['Label updated', '更新标签'], 'label.deleted': ['Label deleted', '删除标签'], 'label.restored': ['Label restored', '恢复标签'],
  'project.created': ['Project created', '创建项目'], 'project.updated': ['Project updated', '更新项目'], 'project.restored': ['Project restored', '恢复项目'],
  'issue-relation.created': ['Relation added', '添加关系'], 'issue-relation.deleted': ['Relation deleted', '删除关系'], 'issue-relation.restored': ['Relation restored', '恢复关系'],
};
function eventName(event: EventResource): string { const name = names[event.type]; return name ? ui(...name) : ui('Project activity', '项目活动'); }
function changes(event: EventResource): string {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const value = payload as Record<string, unknown>;
  return [["title_changed", "Title", "标题"], ["body_changed", "Description", "描述"], ["status_changed", "Status", "状态"], ["priority_changed", "Priority", "优先级"], ["assignee_changed", "Assignee", "负责人"]]
    .filter(([key]) => value[key!] === true).map(([, en, zh]) => ui(en!, zh!)).join(" · ");
}
function load(reset = false): Promise<boolean> {
  if (reset) { generation++; unavailable.value = false; }
  const current = generation;
  return page.load(async cursor => {
    const params = new URLSearchParams({ limit: "20", project: props.projectId });
    if (cursor) params.set("after", cursor);
    const response = await apiRequest<ListResult<EventResource>>(`/api/v1/events?${params}`);
    if (current === generation) unavailable.value = (resolvedWorkScope(response.resolved_scope)?.unresolvedProjects.length ?? 0) > 0;
    return response;
  }, reset);
}
watch(() => props.projectId, () => void load(true), { immediate: true });
onUnmounted(() => { generation++; page.reset(); });
</script>
<template>
  <section class="project-activity">
    <div class="section-heading-row"><h2>{{ ui('Project activity', '项目活动') }}</h2><UButton color="neutral" variant="ghost" class="text-button" type="button" :disabled="page.loading" @click="load(true)">{{ ui('Refresh', '刷新') }}</UButton></div>
    <p class="muted-copy">{{ ui('Visible project changes in chronological order. Load more to continue toward newer activity.', '按时间先后显示可见的项目变更，加载更多可继续查看后续活动。') }}</p>
    <PageState :loading="page.loading && !page.items.length" :error="page.error ? errorText(page.error) : ''" :action-label="ui('Retry', '重试')" @retry="load()" />
    <p v-if="unavailable" class="warning-panel">{{ ui('This project is no longer available in your current scope.', '此项目已不在当前可访问范围。') }}</p>
    <ol class="event-list"><li v-for="event in page.items" :key="event.id"><strong>{{ eventName(event) }}</strong><p>{{ event.actor?.display_name ?? ui('System', '系统') }} · <time :datetime="event.created_at">{{ new Date(event.created_at).toLocaleString(locale) }}</time></p><p v-if="activityTargets(event).length" class="event-targets"><a v-for="target in activityTargets(event)" :key="target.path" :href="target.path" @click.prevent="openTarget(target.path)">{{ target.label }}</a></p><p v-if="changes(event)">{{ ui('Changed', '变更内容') }}：{{ changes(event) }}</p><details><summary>{{ ui('Event details', '事件详情') }}</summary><code>{{ event.type }}</code><p>{{ ui('Subject', '对象') }}：{{ event.subject.type }} · <code>{{ event.subject.id }}</code></p><p>{{ ui('Event', '事件') }}：<code>{{ event.id }}</code></p></details></li></ol>
    <p v-if="page.loaded && !page.items.length" class="empty-copy">{{ ui('No visible project activity.', '暂无可见项目活动。') }}</p>
    <UButton color="neutral" variant="outline" v-if="page.cursor && !page.error" class="load-more" type="button" :disabled="page.loading" @click="load()">{{ page.loading ? ui('Loading…', '加载中…') : ui('Load more activity', '加载更多活动') }}</UButton>
  </section>
</template>
<style scoped>
.event-list { list-style: none; padding: 0; }
.event-list > li { padding: 16px 0; border-bottom: 1px solid var(--color-border); }
.event-list p, details { font-size: 13px; color: var(--color-text-muted); }
.event-list code { overflow-wrap: anywhere; }
.event-targets { display: flex; flex-wrap: wrap; gap: 8px 16px; }
</style>
