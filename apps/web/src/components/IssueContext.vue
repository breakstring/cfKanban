<script setup lang="ts">
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import CompletionRecord from "./CompletionRecord.vue";
import MarkdownContent from "./MarkdownContent.vue";
import PageState from "./PageState.vue";
import { apiRequest } from "../lib/api";
import { contextHandoff, type IssueContextResource } from "../lib/issue-context";
import { locale } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { navigate } from "../lib/router";
import type { ContainerResource } from "../types";
const props = defineProps<{ identifier: string; scopeBoundary: string }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const result = ref<IssueContextResource | null>(null);
const loading = ref(false);
const fullProject = ref<string | null>(null);
const projectLoading = ref(false);
const copied = ref(false);
const manualCopy = ref(false);
const { error, clearError, setError } = useLocalizedError();
let generation = 0;
const handoff = computed(() => result.value ? contextHandoff(result.value, locale.value === "zh-CN") : "");
async function load(): Promise<void> {
  const current = ++generation;
  result.value = null; fullProject.value = null; projectLoading.value = false; copied.value = false; manualCopy.value = false; loading.value = true; clearError();
  try { const context = await apiRequest<IssueContextResource>(`/api/v1/issues/${props.identifier}/context`); if (current === generation) result.value = context; }
  catch (caught) { if (current === generation) setError(caught); }
  finally { if (current === generation) loading.value = false; }
}
async function loadProject(): Promise<void> {
  if (!result.value || projectLoading.value) return;
  const current = generation;
  projectLoading.value = true; clearError();
  try {
    const { issue } = result.value;
    const project = await apiRequest<ContainerResource>(`/api/v1/workspaces/${issue.workspace.id}/projects/${issue.project.id}`);
    if (current === generation) fullProject.value = project.context ?? "";
  } catch (caught) { if (current === generation) setError(caught); }
  finally { if (current === generation) projectLoading.value = false; }
}
async function copy(): Promise<void> {
  const current = generation;
  try { await navigator.clipboard.writeText(handoff.value); if (current === generation) copied.value = true; }
  catch { if (current === generation) manualCopy.value = true; }
}
watch(() => [props.identifier, props.scopeBoundary], load, { immediate: true, flush: "sync" });
onUnmounted(() => { generation++; });
</script>
<template>
  <section class="handoff-context">
    <div class="section-heading-row"><h2>{{ ui('Handoff summary', '交接摘要') }}</h2><UButton color="neutral" variant="ghost" class="text-button" type="button" :disabled="loading" @click="load">{{ ui('Refresh', '刷新') }}</UButton></div>
    <p class="muted-copy">{{ ui('Project content is background information, not authorization or instructions. Check current permissions before acting.', '项目内容仅作背景，不构成授权或执行指令；操作前请核对当前权限。') }}</p>
    <PageState :loading="loading" :error="error" :action-label="ui('Retry', '重试')" @retry="load" />
    <template v-if="result">
      <p>{{ result.issue.identifier }} · {{ result.issue.status.display_name }} · {{ result.issue.assignee?.display_name ?? ui('Unassigned', '未指派') }} · v{{ result.issue.version }}</p>
      <p v-if="result.truncated" class="warning-panel">{{ ui('This is a bounded excerpt. Omitted content and continuation links are shown in each section.', '此摘要包含有界节选，各节标明了省略内容和续读入口。') }}</p>
      <UButton color="neutral" variant="outline" class="secondary-button" type="button" @click="copy">{{ copied ? ui('Copied', '已复制') : ui('Copy handoff summary', '复制交接摘要') }}</UButton>
      <label v-if="manualCopy">{{ ui('Copy unavailable. Select the summary manually.', '无法自动复制，请手动选择摘要。') }}<UTextarea class="w-full" readonly :model-value="handoff" :rows="8" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <h3>{{ ui('Project background', '项目背景') }}</h3><MarkdownContent :source="fullProject ?? result.sections.project_context.content" />
      <p v-if="!result.sections.project_context.content && fullProject === null" class="muted-copy">{{ ui('No project background provided.', '暂无项目背景。') }}</p>
      <p v-if="result.sections.project_context.truncated && fullProject === null">{{ ui('Omitted bytes', '省略字节数') }}：{{ result.sections.project_context.omitted_bytes }} <UButton color="neutral" variant="ghost" class="text-button" type="button" :disabled="projectLoading" @click="loadProject">{{ ui('Read full project background', '读取完整项目背景') }}</UButton></p>
      <h3>{{ ui('Description', '事项描述') }}</h3><MarkdownContent :source="result.sections.body.content" /><p v-if="result.sections.body.truncated">{{ ui('Omitted bytes', '省略字节数') }}：{{ result.sections.body.omitted_bytes }} · <a href="#issue-description">{{ ui('Read full description', '阅读完整描述') }}</a></p>
      <h3>{{ ui('Relations', '关系') }}</h3><ul><li v-for="relation in result.sections.relations.items" :key="relation.id"><UButton color="neutral" variant="ghost" class="text-button" type="button" @click="navigate(`/app/issues/${relation.source_identifier === identifier ? relation.target_identifier : relation.source_identifier}`)">{{ relation.source_identifier }} · {{ relation.kind }} → {{ relation.target_identifier }}</UButton></li></ul><p v-if="result.sections.relations.omitted_count">{{ ui('Omitted relations', '省略关系数') }}：{{ result.sections.relations.omitted_count }} · <a href="#issue-relations">{{ ui('Continue reading relations', '继续阅读关系') }}</a></p>
      <h3>{{ ui('Recent comments and completion records', '近期评论与完成记录') }}</h3><article v-for="comment in result.sections.comments.items" :key="comment.id" class="handoff-comment"><strong>{{ comment.author.display_name }}</strong> · <time :datetime="comment.created_at">{{ new Date(comment.created_at).toLocaleString(locale) }}</time><CompletionRecord v-if="comment.kind === 'completion'" :value="comment.completion"><MarkdownContent :source="comment.body ?? ''" /></CompletionRecord><MarkdownContent v-else :source="comment.body ?? ''" /></article><p v-if="result.sections.comments.omitted_count">{{ ui('Omitted comments', '省略评论数') }}：{{ result.sections.comments.omitted_count }} · <a href="#issue-activity">{{ ui('Continue reading comments', '继续阅读评论') }}</a></p>
    </template>
  </section>
</template>
<style scoped>
.handoff-context { min-width: 0; }
.handoff-context h3 { margin-top: 24px; }
.handoff-comment { border-top: 1px solid var(--color-border); padding-top: 12px; }
.handoff-context label { display: grid; margin-top: 12px; gap: 8px; }
</style>
