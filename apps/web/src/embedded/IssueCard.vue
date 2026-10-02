<script setup lang="ts">
import { computed } from "vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import AssigneeMenu from "../components/AssigneeMenu.vue";
import CopyButton from "../components/CopyButton.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
import { locale, t } from "../lib/i18n-core";
import { priorityText } from "../lib/priority";
import type { IssueChange, PublicIssue, PublicStatus, Status } from "./protocol";

const props = defineProps<{ issue: PublicIssue; statuses: PublicStatus[]; assignees: { principal_id: string; display_name: string }[]; assigneesHasMore?: boolean; disabled?: boolean; loading?: boolean }>();
const emit = defineEmits<{ open: [identifier: string]; update: [identifier: string, change: IssueChange]; complete: [identifier: string]; people: [next: boolean] }>();
const canUpdate = computed(() => props.issue.allowed_actions?.includes("update") === true);
const assignee = computed(() => props.issue.assignee?.principal_id ? { principal_id: props.issue.assignee.principal_id, display_name: props.issue.assignee.display_name ?? "", available: props.issue.assignee.available !== false } : null);
function statusChanged(event: Event) {
  const select = event.target as HTMLSelectElement;
  const key = select.value as Status;
  select.value = props.issue.status.key;
  if (props.disabled || !canUpdate.value || key === props.issue.status.key || !props.statuses.some(row => row.key === key)) return;
  if (key === "done") emit("complete", props.issue.identifier);
  else emit("update", props.issue.identifier, { status_key: key });
}
</script>

<template>
  <article class="embedded-issue-card">
    <div class="embedded-card-top">
      <span class="embedded-identifier">{{ issue.identifier }} <CopyButton :value="issue.identifier" :label="locale === 'zh-CN' ? '复制编号' : 'Copy ID'" /></span>
      <div class="embedded-card-priority"><UBadge v-if="issue.is_blocked" color="warning" variant="subtle" size="xs">{{ locale === 'zh-CN' ? '受阻' : 'Blocked' }}</UBadge><PrioritySelect v-if="canUpdate" :value="issue.priority" :label="t('issue.priority')" :disabled="disabled" compact @change="emit('update', issue.identifier, { priority_key: $event })" /><UBadge v-else :color="issue.priority === 'urgent' ? 'error' : 'neutral'" variant="subtle" size="xs">{{ priorityText(issue.priority, locale === 'zh-CN') }}</UBadge></div>
    </div>
    <button class="embedded-card-title" :title="issue.title" type="button" :disabled="disabled" @click="emit('open', issue.identifier)">{{ issue.title }}</button>
    <div class="embedded-card-meta">
      <div class="embedded-card-assignee"><AssigneeMenu v-if="canUpdate" :assignee="assignee" :candidates="assignees" :has-more="assigneesHasMore" :disabled="disabled && !loading" :loading="loading" @open="emit('people', false)" @load-more="emit('people', true)" @select="emit('update', issue.identifier, { assignee_principal_id: $event })" />
      <span v-else class="embedded-assignee-name">{{ issue.assignee?.display_name || t('issue.unassigned') }}</span></div>
      <select v-if="canUpdate" class="embedded-card-status" :aria-label="t('issue.status')" :data-status="issue.status.key" :value="issue.status.key" :disabled="disabled" @change="statusChanged"><option v-for="status in statuses" :key="status.key" :value="status.key">{{ status.display_name || status.key }}</option></select>
      <span v-else>{{ issue.status.display_name || issue.status.key }}</span>
    </div>
  </article>
</template>
