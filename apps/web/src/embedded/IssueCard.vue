<script setup lang="ts">
import { computed } from "vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import AssigneeMenu from "../components/AssigneeMenu.vue";
import IssueChildrenProgress from "../components/IssueChildrenProgress.vue";
import CopyButton from "../components/CopyButton.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
import { locale, t } from "../lib/i18n-core";
import { priorityText } from "../lib/priority";
import type { IssueChange, PublicIssue, PublicStatus, Status } from "./protocol";

const props = withDefaults(defineProps<{ showParent?: boolean; issue: PublicIssue; statuses: PublicStatus[]; assignees: { principal_id: string; display_name: string }[]; assigneesHasMore?: boolean; disabled?: boolean; loading?: boolean }>(), { showParent: true });
const emit = defineEmits<{ open: [identifier: string]; update: [identifier: string, change: IssueChange]; complete: [identifier: string]; people: [next: boolean] }>();
const canUpdate = computed(() => props.issue.allowed_actions?.includes("update") === true);
const assignee = computed(() => props.issue.assignee?.principal_id ? { principal_id: props.issue.assignee.principal_id, display_name: props.issue.assignee.display_name ?? "", available: props.issue.assignee.available !== false } : null);
const statusName = computed(() => props.statuses.find(status => status.key === props.issue.status.key)?.display_name || props.issue.status.key);
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
      <div class="embedded-card-priority">
        <UBadge v-if="issue.is_blocked" color="warning" variant="subtle" size="xs">{{ locale === 'zh-CN' ? '受阻' : 'Blocked' }}</UBadge>
        <span v-if="canUpdate" class="embedded-property-picker embedded-priority-picker" :data-priority="issue.priority" :title="`${t('issue.priority')} · ${priorityText(issue.priority, locale === 'zh-CN')}`">
          <span class="embedded-property-value" aria-hidden="true">{{ priorityText(issue.priority, locale === 'zh-CN') }}</span>
          <span class="embedded-property-caret" aria-hidden="true" />
          <PrioritySelect :value="issue.priority" :label="t('issue.priority')" :disabled="disabled" compact @change="emit('update', issue.identifier, { priority_key: $event })" />
        </span>
        <UBadge v-else :color="issue.priority === 'urgent' ? 'error' : 'neutral'" variant="subtle" size="xs">{{ priorityText(issue.priority, locale === 'zh-CN') }}</UBadge>
      </div>
    </div>
    <button class="embedded-card-title" :title="issue.title" type="button" :disabled="disabled" @click="emit('open', issue.identifier)">{{ issue.title }} <IssueChildrenProgress :progress="issue.hierarchy?.children" /></button>
    <span v-if="showParent !== false && issue.hierarchy?.parents.length" class="embedded-card-parent" :title="issue.hierarchy.parents.map(parent => `${parent.identifier} · ${parent.title}`).join('\n')">↳ {{ issue.hierarchy.parents[0]?.identifier }} · {{ issue.hierarchy.parents[0]?.title }}<span v-if="issue.hierarchy.parent_count > 1"> +{{ issue.hierarchy.parent_count - 1 }}</span></span>
    <span v-if="showParent === false && (issue.hierarchy?.parent_count ?? 0) > 1" class="embedded-card-other-parents" :title="issue.hierarchy?.parents.map(parent => `${parent.identifier} · ${parent.title}`).join('\n')">{{ locale === 'zh-CN' ? '其他父事项' : 'Other parents' }} +{{ issue.hierarchy!.parent_count - 1 }}</span>
    <div class="embedded-card-meta">
      <div class="embedded-card-assignee"><AssigneeMenu v-if="canUpdate" :assignee="assignee" :candidates="assignees" :has-more="assigneesHasMore" :disabled="disabled && !loading" :loading="loading" @open="emit('people', false)" @load-more="emit('people', true)" @select="emit('update', issue.identifier, { assignee_principal_id: $event })" />
      <span v-else class="embedded-assignee-name">{{ issue.assignee?.display_name || t('issue.unassigned') }}</span></div>
      <span v-if="canUpdate" class="embedded-property-picker embedded-status-picker" :title="`${t('issue.status')} · ${statusName}`">
        <span class="embedded-property-value" aria-hidden="true">{{ statusName }}</span>
        <span class="embedded-property-caret" aria-hidden="true" />
        <select class="embedded-card-status" :aria-label="t('issue.status')" :data-status="issue.status.key" :value="issue.status.key" :disabled="disabled" @change="statusChanged"><option v-for="status in statuses" :key="status.key" :value="status.key">{{ status.display_name || status.key }}</option></select>
      </span>
      <span v-else>{{ issue.status.display_name || issue.status.key }}</span>
    </div>
  </article>
</template>
