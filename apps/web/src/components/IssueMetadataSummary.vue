<script setup lang="ts">
import { locale, t } from "../lib/i18n-core";
import { priorityText } from "../lib/priority";
import type { PriorityKey, StatusKey } from "../types";
import IssueStatusMark from "./IssueStatusMark.vue";

defineProps<{ statusKey: StatusKey; statusLabel: string; priority: PriorityKey; assigneeName?: string | undefined }>();
</script>

<template>
  <div class="issue-metadata-summary">
    <span class="issue-metadata-item" :data-status="statusKey">
      <IssueStatusMark class="issue-metadata-status" :status-key="statusKey" />
      <span class="issue-metadata-label">{{ t('issue.status') }}</span><span class="issue-metadata-value">{{ statusLabel }}</span>
    </span>
    <span class="issue-metadata-item" :data-priority="priority">
      <svg class="issue-metadata-priority" viewBox="0 0 16 16" aria-hidden="true"><path v-if="priority === 'none'" d="M3 8h10" /><template v-else><path d="M3 12V9m4 3V6m4 6V3" /><path v-if="priority === 'urgent'" d="M15 3v6m0 3v.1" /></template></svg>
      <span class="issue-metadata-label">{{ t('issue.priority') }}</span><span class="issue-metadata-value">{{ priorityText(priority, locale === 'zh-CN') }}</span>
    </span>
    <span class="issue-metadata-item" :title="assigneeName || t('issue.unassigned')">
      <svg class="issue-metadata-person" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="2.5" /><path d="M3 14v-1a5 5 0 0 1 10 0v1" /></svg>
      <span class="issue-metadata-label">{{ t('issue.assignee') }}</span><span class="issue-metadata-value">{{ assigneeName || t('issue.unassigned') }}</span>
    </span>
  </div>
</template>

<style scoped>
.issue-metadata-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.issue-metadata-item { display: inline-flex; align-items: center; gap: 7px; box-sizing: border-box; min-height: 32px; max-width: 100%; padding: 5px 10px; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-bg); color: var(--ui-text); font-size: 12px; line-height: 20px; }
.issue-metadata-label { flex: none; color: var(--ui-text-muted); }
.issue-metadata-value { min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
.issue-metadata-status { --status-mark-size: 14px; }
.issue-metadata-priority, .issue-metadata-person { width: 14px; height: 14px; flex: none; fill: none; stroke: var(--ui-text-muted); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
[data-priority="high"] .issue-metadata-priority { stroke: var(--ui-warning); }
[data-priority="urgent"] .issue-metadata-priority { stroke: var(--ui-error); }
</style>
