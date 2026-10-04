<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from "vue";
import UApp from "@nuxt/ui/components/App.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UModal from "@nuxt/ui/components/Modal.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import UPopover from "@nuxt/ui/components/Popover.vue";
import { en, zh_cn } from "@nuxt/ui/locale";

import CopyButton from "../components/CopyButton.vue";
import LocaleSwitch from "../components/LocaleSwitch.vue";
import IssueShare from "../components/IssueShare.vue";
import IssueMetadataSummary from "../components/IssueMetadataSummary.vue";
import IssueDetailHeader from "../components/IssueDetailHeader.vue";
import IssueDetailLayout from "../components/IssueDetailLayout.vue";
import IssueContentSection from "../components/IssueContentSection.vue";
import IssueCommentItem from "../components/IssueComment.vue";
import KanbanStatusNavigation from "../components/KanbanStatusNavigation.vue";
import ProjectSwitcherMenu from "../components/ProjectSwitcherMenu.vue";
import type { ProjectSwitcherItem } from "../components/ProjectSwitcherMenu.vue";
import AssigneeMenu from "../components/AssigneeMenu.vue";
import PrioritySelect from "../components/PrioritySelect.vue";
import CompletionRecord from "../components/CompletionRecord.vue";
import MarkdownContent from "../components/MarkdownContent.vue";
import { locale, setLocale, t } from "../lib/i18n-core";
import { priorityOrder, priorityText } from "../lib/priority";
import { labelNameKey } from "../lib/label-input";
import { applyTheme } from "../lib/theme";
import logo from "../assets/cfkanban-mark.png";
import IssueCard from "./IssueCard.vue";
import { createEmbedClient } from "./client";
import { reconcileCompletedDraft, resetCompletionDraft } from "./drafts";
import { e } from "./i18n";
import { canAutoAppend } from "./pagination";
import { emptySnapshot } from "./protocol";
import type { ActionPayloads, Artifact, EmbedAction, EmbedSnapshot, IssueChange, Priority, PublicResource, Status } from "./protocol";

const state = ref<EmbedSnapshot>(emptySnapshot());
const connected = ref(false);
const localError = ref<string | null>(null);
const inFlight = ref(0);
const client = createEmbedClient({
  window,
  onConnect(value) { setLocale(value); document.documentElement.lang = value; connected.value = true; },
  onSnapshot(value) {
    if (value.locale) { setLocale(value.locale); document.documentElement.lang = value.locale; }
    if (value.theme) applyTheme(value.theme);
    state.value = value;
  },
  async afterRender() { await nextTick(); },
  onError(code) { localError.value = code; },
});
onUnmounted(() => client.dispose());

const busy = computed(() => state.value.busy > 0 || inFlight.value > 0);
const pending = computed(() => Boolean(state.value.pending || state.value.session_context_changed));
const identity = computed(() => state.value.binding?.identity ?? state.value.identity);
const principal = computed(() => identity.value?.principal ?? state.value.binding?.principal);
const instance = computed(() => identity.value?.instance ?? state.value.binding?.instance);
const verifiedOrigin = computed(() => {
  const value = instance.value?.trusted_api_origin ?? instance.value?.api_origin ?? instance.value?.origin;
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined; } catch { return undefined; }
});
const markdownProps = computed<{ baseUrl?: string; linkTarget: "_blank" }>(() => verifiedOrigin.value ? { baseUrl: verifiedOrigin.value, linkTarget: "_blank" } : { linkTarget: "_blank" });
const rows = computed(() => state.value.page?.items ?? state.value.page?.issues ?? []);
const nextPage = computed(() => Boolean(state.value.page?.next_cursor ?? state.value.page?.continuation?.next_cursor));
const filters = reactive({ assignment: "all" as "all" | "mine" | "unassigned", status: "" as Status | "", priority: "" as Priority | "" });
watch(() => state.value.filters, value => Object.assign(filters, value), { deep: true });
const comment = ref("");
const completion = reactive({ summary: "", verification: "", artifacts: "", artifactKind: "path" as Artifact["kind"], followUps: "" });
const showCompletion = ref(false);
const showIdentity = ref(false);
const showFilters = ref(false);
const showLabelPicker = ref(false);
const labelSearch = ref("");
const labelsLoading = ref(false);
const availableLabels = computed(() => (state.value.labels ?? []).filter(label =>
  !state.value.issue?.labels?.some(added => added.id === label.id)
  && labelNameKey(label.name).includes(labelNameKey(labelSearch.value))));
watch(showLabelPicker, opened => { if (opened) void loadLabels(false); });
watch(() => state.value.issue?.identifier, () => { showLabelPicker.value = false; labelSearch.value = ""; });
const projectMenuOpen = ref(false);
const projectSearch = ref("");
const projectGroups = computed(() => {
  const query = projectSearch.value.trim().toLocaleLowerCase();
  const candidates: ProjectSwitcherItem[] = state.value.scope_mode === "suggested"
    ? state.value.scope_targets.map(target => ({ id: target.id, label: target.display_name || target.project_id || e("project"), current: target.project_id === state.value.binding?.project.id, disabled: !target.available, description: target.available ? undefined : scopeProblem(typeof target.unavailability === "string" ? target.unavailability : target.unavailability?.code) }))
    : state.value.projects.map(project => ({ id: project.id!, label: name(project), current: project.id === state.value.binding?.project.id }));
  if (state.value.binding && !candidates.some(candidate => candidate.current)) candidates.unshift({ id: "current", label: name(state.value.binding.project), current: true, disabled: true });
  return [{ id: "workspace", label: e("scope"), projects: candidates.filter(candidate => !query || candidate.label.toLocaleLowerCase().includes(query)) }];
});
async function openProjectMenu() {
  projectMenuOpen.value = true;
  projectSearch.value = "";
  if (state.value.scope_mode === "suggested") await send("scope_retry", {});
}
async function chooseProject(id: string) {
  const result = state.value.scope_mode === "suggested" ? await send("scope_bind", { target_id: id }) : await send("bind", { project_id: id });
  if (result.ok) projectMenuOpen.value = false;
}
const activeFilterCount = computed(() => Number(state.value.filters.assignment !== "all") + Number(Boolean(state.value.filters.status)) + Number(Boolean(state.value.filters.priority)));
watch(() => state.value.issue, (issue, previous) => {
  if (issue?.identifier === previous?.identifier) return;
  comment.value = "";
  resetCompletionDraft(completion);
  showCompletion.value = false;
});
const statusItems = computed(() => state.value.binding?.statuses ?? []);
const errorCode = computed(() => localError.value ?? state.value.error?.code);
const errorText = computed(() => {
  const code = errorCode.value;
  if (code === "VALIDATION_ERROR" || code === "INPUT_VALIDATION_FAILED") return t("error.validation");
  if (code === "LABEL_ALREADY_ATTACHED" || code === "LABEL_NOT_ATTACHED") return e("labelConflict");
  if (code === "ISSUE_LABEL_LIMIT_REACHED") return e("labelLimit");
  if (code === "VERSION_CONFLICT" || code === "PANEL_VERSION_CONFLICT" || code === "CAS_CONFLICT") return e("conflict");
  if (code?.includes("UNCERTAIN") || code === "PANEL_OPERATION_PENDING") return e("uncertain");
  if (code === "PANEL_SESSION_CONTEXT_CHANGED") return e("contextChanged");
  return e("failed");
});
function name(value: PublicResource): string { return value.display_name ?? value.title ?? value.name ?? value.instance_id ?? value.id ?? ""; }
function scopeProblem(code?: string): string {
  if (code === "PANEL_SCOPE_HOST_UNAVAILABLE") return e("scopeHost");
  if (code === "PANEL_SCOPE_CREDENTIAL_UNAVAILABLE") return e("scopeCredential");
  if (code === "PANEL_SCOPE_PERMISSION_DENIED") return e("scopePermission");
  if (code === "PANEL_SCOPE_IDENTITY_CHANGED") return e("scopeIdentity");
  if (code === "PANEL_SCOPE_STALE") return e("scopeStale");
  return e("scopeUnavailable");
}
async function send<K extends EmbedAction>(action: K, payload: ActionPayloads[K]) {
  localError.value = null;
  inFlight.value++;
  try {
    const result = await client.action(action, payload);
    if (!result.ok) localError.value = result.error?.code ?? "EMBED_OPERATION_FAILED";
    return result;
  } finally { inFlight.value--; }
}
async function selectInstance(instanceId: string) {
  const result = await send("select_instance", { instance_id: instanceId });
  if (result.ok) await send("workspaces", {});
}
const boardMode = computed(() => state.value.view === "board");
const columns = computed(() => state.value.board?.columns ?? []);
const boardRegion = ref<HTMLElement | null>(null);
const statusNavigation = computed(() => columns.value.map(column => ({ key: column.key, display_name: column.display_name || column.key, loaded: column.items.length, has_more: column.has_more, target_id: `embedded-column-${column.key}` })));
const loadingColumn = ref<Status | null>(null);
const loadingList = ref(false);
async function loadMoreColumn(key: Status) {
  const column = columns.value.find(value => value.key === key);
  if (busy.value || pending.value || !column?.has_more || column.capacity_reached) return;
  loadingColumn.value = key;
  try { return await send("board_page", { status_key: key, next: true }); }
  finally { loadingColumn.value = null; }
}
function onColumnScroll(key: Status, event: Event) {
  const column = columns.value.find(value => value.key === key);
  if (column && canAutoAppend(event.currentTarget as HTMLElement, { busy: busy.value, pending: pending.value, error: Boolean(errorCode.value), hasMore: column.has_more, capacityReached: Boolean(column.capacity_reached) })) void loadMoreColumn(key);
}
async function loadMoreList() {
  if (busy.value || pending.value || !nextPage.value || state.value.page?.capacity_reached) return;
  loadingList.value = true;
  try { return await send("page", { next: true }); }
  finally { loadingList.value = false; }
}
function onListScroll(event: Event) {
  if (canAutoAppend(event.currentTarget as HTMLElement, { busy: busy.value, pending: pending.value, error: Boolean(errorCode.value), hasMore: nextPage.value, capacityReached: Boolean(state.value.page?.capacity_reached) })) void loadMoreList();
}
const candidates = computed(() => state.value.assignees ?? []);
const detailAssignee = computed(() => state.value.issue?.assignee?.principal_id ? { principal_id: state.value.issue.assignee.principal_id, display_name: state.value.issue.assignee.display_name ?? "", available: state.value.issue.assignee.available !== false } : null);
const peopleLoaded = ref(false);
const peopleLoading = ref(false);
watch(() => state.value.binding?.project.id, () => { peopleLoaded.value = false; });
async function loadPeople(next = false) {
  if (peopleLoading.value || (!next && peopleLoaded.value)) return;
  peopleLoading.value = true;
  try {
    const result = await send("assignees", { next });
    if (result.ok) peopleLoaded.value = true;
  } finally { peopleLoading.value = false; }
}
function refresh() {
  if (state.value.issue) return send("open_issue", { identifier: state.value.issue.identifier });
  return boardMode.value ? send("view", { mode: "board" }) : send("page", { next: false });
}
async function applyFilters() {
  const result = await send("filters", { ...filters });
  if (result.ok) showFilters.value = false;
}
async function quickComplete(identifier: string) {
  const result = await send("open_issue", { identifier });
  if (result.ok && state.value.capabilities.complete) await openCompletion();
}
function openCompletion() {
  if (busy.value || pending.value || !state.value.capabilities.complete || state.value.issue?.status.key === "done") return;
  showCompletion.value = true;
}
function focusCompletion() { document.getElementById("embedded-summary")?.focus(); }
async function loadLabels(next: boolean): Promise<void> {
  if (!state.value.issue || !state.value.capabilities.update || pending.value || labelsLoading.value) return;
  labelsLoading.value = true;
  try { await send("labels", { next }); }
  finally { labelsLoading.value = false; }
}
async function toggleLabel(labelId: string, add: boolean): Promise<void> {
  const issue = state.value.issue;
  if (!issue || busy.value || pending.value || !state.value.capabilities.update) return;
  if (add === Boolean(issue.labels?.some(label => label.id === labelId))) return;
  if (add && !state.value.labels?.some(label => label.id === labelId)) return;
  const result = await send("mutate", { operation: add ? "label_add" : "label_remove", change: { label_id: labelId } });
  if (result.ok && !result.outcome_unknown && add) { showLabelPicker.value = false; labelSearch.value = ""; }
}
function changeLocale(value: "en" | "zh-CN") {
  if (!state.value.binding || busy.value || pending.value) return;
  return send("set_locale", { locale: value });
}
function quickUpdate(identifier: string, change: IssueChange) { void send("quick_update", { identifier, change }); }
function updateDetail(change: IssueChange) {
  const issue = state.value.issue;
  if (!issue || busy.value || pending.value || !state.value.capabilities.update) return;
  if (change.status_key === issue.status.key || change.priority_key === issue.priority
    || (Object.hasOwn(change, "assignee_principal_id") && change.assignee_principal_id === (issue.assignee?.principal_id ?? null))) return;
  return send("mutate", { operation: "update", change });
}
function statusChanged(event: Event) {
  const select = event.target as HTMLSelectElement;
  const key = select.value as Status;
  const issue = state.value.issue;
  if (!issue) return;
  select.value = issue.status.key;
  if (busy.value || pending.value || !state.value.capabilities.update || key === issue.status.key || !statusItems.value.some(status => status.key === key)) return;
  if (key === "done") openCompletion();
  else void updateDetail({ status_key: key });
}
async function addComment() {
  const result = await send("mutate", { operation: "comment", change: { body: comment.value } });
  if (result.ok && !result.outcome_unknown) comment.value = "";
}
async function recover() {
  const operation = state.value.pending?.operation;
  const result = await send("recover", {});
  if (result.ok && !result.outcome_unknown) {
    if (operation === "comment") comment.value = "";
    if (operation === "complete" && reconcileCompletedDraft(completion, state.value.issue, result)) showCompletion.value = false;
  }
}
function lines(value: string): string[] { return value.split("\n").map(line => line.trim()).filter(Boolean); }
async function complete() {
  if (busy.value || pending.value || !state.value.capabilities.complete) return;
  const result = await send("mutate", { operation: "complete", change: { summary: completion.summary, verification: lines(completion.verification), artifacts: lines(completion.artifacts).map(value => ({ kind: completion.artifactKind, value })), follow_ups: lines(completion.followUps) } });
  if (reconcileCompletedDraft(completion, state.value.issue, result)) showCompletion.value = false;
}
</script>

<template>
  <UApp :locale="locale === 'zh-CN' ? zh_cn : en" :toaster="null">
    <main class="embedded-workbench">
      <header class="embedded-header">
        <div class="embedded-brand"><img :src="logo" alt="" width="28" height="28"><strong>cfKanban</strong><ProjectSwitcherMenu v-if="state.binding" :title="name(state.binding.project)" :opened="projectMenuOpen" :search="projectSearch" :groups="projectGroups" :busy="busy" :disabled="busy || pending" @open="openProjectMenu" @close="projectMenuOpen = false" @search="projectSearch = $event" @select="chooseProject" @retry="openProjectMenu"><template #footer><div class="embedded-actions"><UButton v-if="state.scope_mode === 'suggested' && state.scope_next_offset !== null" color="neutral" variant="ghost" size="sm" :disabled="busy || pending" @click="send('scope_page', { next: true })">{{ e('more') }}</UButton><UButton color="neutral" variant="ghost" size="sm" :disabled="busy || pending" @click="projectMenuOpen = false; send('unbind', {})">{{ e('manual') }}</UButton></div></template></ProjectSwitcherMenu><UBadge v-else color="neutral" variant="subtle" size="xs">{{ e('setup') }}</UBadge></div>
        <div v-if="state.binding" class="embedded-actions"><LocaleSwitch managed :disabled="busy || pending" @change="changeLocale" /><UButton color="neutral" variant="ghost" size="sm" class="embedded-icon-button" :title="`${e('identity')} · ${principal?.display_name || ''}`" :aria-label="e('identity')" :aria-expanded="showIdentity" aria-controls="embedded-identity" @click="showIdentity = !showIdentity"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg></UButton><UButton color="neutral" variant="ghost" size="sm" class="embedded-icon-button" :title="e('refresh')" :aria-label="e('refresh')" :disabled="busy" @click="refresh"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" /></svg></UButton></div>
      </header>

      <p v-if="!connected" class="embedded-empty" role="status">{{ e('waiting') }}</p>
      <template v-else>
        <div v-if="errorCode" class="embedded-alert" role="alert"><p>{{ errorText }}</p><code>{{ errorCode }}</code></div>
        <div v-if="state.pending" class="embedded-recovery" role="status">
          <strong>{{ e(busy ? 'saving' : 'pending') }}</strong>
          <dl><template v-if="state.pending"><dt>{{ e('version') }}</dt><dd>{{ state.pending.expected_version ?? state.pending.version }} · {{ state.pending.identifier }}</dd></template></dl>
          <UButton v-if="state.pending" size="sm" :disabled="busy || state.session_context_changed" @click="recover">{{ e('recover') }}</UButton>
        </div>

        <template v-if="!state.binding">
          <section v-if="state.scope_mode === 'suggested'" class="embedded-section">
            <h1>{{ e('scope') }}</h1>
            <div v-for="target in state.scope_targets" :key="target.id" class="embedded-picker-card">
              <strong>{{ target.display_name || target.project_id || e('project') }}</strong>
              <p v-if="!target.available" class="embedded-muted">{{ scopeProblem(typeof target.unavailability === 'string' ? target.unavailability : target.unavailability?.code) }}</p>
              <code v-if="target.project_id" class="embedded-short-id">{{ target.project_id }}</code>
              <UButton v-if="target.available" size="sm" :disabled="busy || pending" @click="send('scope_bind', { target_id: target.id })">{{ e('bind') }}</UButton>
              <UButton v-else size="sm" color="neutral" variant="soft" :disabled="busy || pending" @click="send('scope_retry', {})">{{ e('retry') }}</UButton>
            </div>
            <div class="embedded-actions"><UButton v-if="state.scope_next_offset !== null" size="sm" color="neutral" variant="outline" :disabled="busy || pending" @click="send('scope_page', { next: true })">{{ e('more') }}</UButton><UButton color="neutral" variant="ghost" size="sm" :disabled="busy || pending" @click="send('manual', {})">{{ e('manual') }}</UButton></div>
          </section>
          <section v-else class="embedded-section">
            <h1>{{ e('setup') }}</h1>
            <p v-if="state.scope_fallback" class="embedded-muted">{{ scopeProblem(state.scope_fallback) }}</p>
            <p v-else-if="state.workspace_scope?.status === 'invalid'" class="embedded-muted">{{ e('scopeInvalid') }}</p>
            <p v-else-if="state.workspace_scope?.status === 'missing'" class="embedded-muted">{{ e('scopeMissing') }}</p>
            <h2>{{ e('connection') }}</h2>
            <p v-if="!state.candidates.length && !state.identity" class="embedded-muted">{{ e('noConnections') }}</p>
            <div class="embedded-choice-list"><UButton v-for="candidate in state.candidates" :key="candidate.instance_id!" color="neutral" variant="outline" class="embedded-choice" :disabled="busy || pending" @click="selectInstance(candidate.instance_id!)">{{ name(candidate) }}</UButton></div>
            <template v-if="state.identity">
              <h2>{{ e('workspace') }}</h2>
              <p class="embedded-muted">{{ name(state.identity.principal) }}</p>
              <p v-if="!state.workspaces.length" class="embedded-muted">{{ e('noWorkspaces') }}</p>
              <div class="embedded-choice-list"><UButton v-for="workspace in state.workspaces" :key="workspace.id!" color="neutral" variant="outline" class="embedded-choice" :disabled="busy || pending" @click="send('select_workspace', { workspace_id: workspace.id! })">{{ name(workspace) }}</UButton></div>
              <UButton v-if="state.workspace_has_more" color="neutral" variant="ghost" size="sm" :disabled="busy || pending" @click="send('workspaces', { next: true })">{{ e('more') }}</UButton>
              <h2 v-if="state.workspace_id">{{ e('project') }}</h2>
              <p v-if="state.workspace_id && !state.projects.length" class="embedded-muted">{{ e('noProjects') }}</p>
              <div class="embedded-choice-list"><UButton v-for="project in state.projects" :key="project.id!" color="neutral" variant="outline" class="embedded-choice" :disabled="busy || pending" @click="send('bind', { project_id: project.id! })">{{ name(project) }}</UButton></div>
              <UButton v-if="state.project_has_more && state.workspace_id" color="neutral" variant="ghost" size="sm" :disabled="busy || pending" @click="send('select_workspace', { workspace_id: state.workspace_id, next: true })">{{ e('more') }}</UButton>
            </template>
          </section>
        </template>

        <template v-else>
          <section v-if="showIdentity" id="embedded-identity" class="embedded-identity">
            <h2>{{ e('identity') }} · {{ principal?.display_name }}</h2>
            <dl><dt>{{ e('connection') }}</dt><dd>{{ name(instance || {}) }}<br><code>{{ verifiedOrigin }}</code></dd><dt>{{ t('profile.id') }}</dt><dd><code>{{ principal?.principal_id || principal?.id }}</code></dd><dt>{{ e('project') }}</dt><dd>{{ name(state.binding.project) }}<br><code>{{ state.binding.project.id }}</code></dd></dl>
            <UButton color="neutral" variant="outline" size="sm" :disabled="busy || pending" @click="send('unbind', {})">{{ e('change') }}</UButton>
          </section>

          <section v-if="!state.issue" class="embedded-project-view">
            <div class="embedded-toolbar"><div class="embedded-view-switch" role="group" :aria-label="e('view')"><UButton size="sm" :color="boardMode ? 'primary' : 'neutral'" :variant="boardMode ? 'soft' : 'ghost'" :disabled="busy || pending" @click="send('view', { mode: 'board' })">{{ e('board') }}</UButton><UButton size="sm" :color="!boardMode ? 'primary' : 'neutral'" :variant="!boardMode ? 'soft' : 'ghost'" :disabled="busy || pending" @click="send('view', { mode: 'list' })">{{ e('list') }}</UButton></div><UButton color="neutral" :variant="showFilters || activeFilterCount ? 'soft' : 'ghost'" size="sm" :title="e('filters')" :aria-label="e('filters')" :aria-expanded="showFilters" aria-controls="embedded-filters" @click="showFilters = !showFilters"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg><span>{{ e('filters') }}</span><UBadge v-if="activeFilterCount" color="primary" variant="subtle" size="xs">{{ activeFilterCount }}</UBadge></UButton></div>
            <section v-if="showFilters" id="embedded-filters" class="embedded-filters" role="form" :aria-label="e('apply')">
              <label>{{ e('all') }}<select v-model="filters.assignment" :disabled="busy || pending"><option value="all">{{ e('all') }}</option><option value="mine">{{ e('mine') }}</option></select></label>
              <label>{{ e('status') }}<select v-model="filters.status" :disabled="busy || pending"><option value="">{{ e('allStatuses') }}</option><option v-for="status in statusItems" :key="status.key" :value="status.key">{{ status.display_name || status.name || status.key }}</option></select></label>
              <label>{{ e('priority') }}<select v-model="filters.priority" :disabled="busy || pending"><option value="">{{ e('allPriorities') }}</option><option v-for="priority in priorityOrder" :key="priority" :value="priority">{{ priorityText(priority, locale === 'zh-CN') }}</option></select></label>
              <UButton type="button" size="sm" :disabled="busy || pending" @click="applyFilters">{{ e('apply') }}</UButton>
            </section>
            <template v-if="boardMode">
              <KanbanStatusNavigation :columns="statusNavigation" :region="boardRegion" />
              <p v-if="columns.length" id="embedded-board-hint" class="embedded-board-hint">{{ e('boardHint') }}</p>
              <div ref="boardRegion" class="embedded-board" role="region" tabindex="0" :aria-label="e('boardNavigation')" aria-describedby="embedded-board-hint">
                <section v-for="column in columns" :id="`embedded-column-${column.key}`" :key="column.key" class="embedded-column" :data-status="column.key">
                  <header class="embedded-column-heading"><h2><span class="embedded-status-dot" :data-status="column.key" aria-hidden="true" />{{ column.display_name || column.key }}</h2><UBadge color="neutral" variant="subtle" size="xs">{{ column.items.length }}{{ column.has_more ? '+' : '' }}</UBadge></header>
                  <div class="embedded-column-content" tabindex="0" :aria-label="`${column.display_name || column.key} · ${e('list')}`" :aria-busy="loadingColumn === column.key" @scroll="onColumnScroll(column.key, $event)">
                    <div class="embedded-issue-list"><IssueCard v-for="issue in column.items" :key="issue.identifier" :issue="issue" :statuses="statusItems" :assignees="candidates" :assignees-has-more="!!state.assignees_has_more" :loading="peopleLoading" :disabled="busy || pending" @open="identifier => send('open_issue', { identifier })" @update="quickUpdate" @complete="quickComplete" @people="loadPeople" /></div>
                    <p v-if="!column.items.length && !busy && !errorCode" class="embedded-empty">{{ e('emptyColumn') }}</p>
                    <div class="embedded-load-more">
                      <p v-if="loadingColumn === column.key" role="status">{{ e('loadingMore') }}</p>
                      <p v-else-if="column.capacity_reached">{{ e('viewCapacity') }}</p>
                      <p v-else-if="!column.has_more && column.items.length && !busy && !errorCode">{{ e('allLoaded') }}</p>
                      <UButton v-if="column.has_more" color="neutral" variant="ghost" size="xs" :disabled="busy || pending || column.capacity_reached" @click="loadMoreColumn(column.key)">{{ e('loadMore') }}</UButton>
                    </div>
                  </div>
                </section>
              </div>
            </template>
            <div v-else class="embedded-issue-list embedded-list-view" role="region" tabindex="0" :aria-label="e('list')" :aria-busy="loadingList" @scroll="onListScroll">
              <IssueCard v-for="issue in rows" :key="issue.identifier" :issue="issue" :statuses="statusItems" :assignees="candidates" :assignees-has-more="!!state.assignees_has_more" :loading="peopleLoading" :disabled="busy || pending" @open="identifier => send('open_issue', { identifier })" @update="quickUpdate" @complete="quickComplete" @people="loadPeople" />
              <p v-if="!rows.length && !busy && !errorCode" class="embedded-empty">{{ e('empty') }}</p>
              <div class="embedded-load-more">
                <p v-if="loadingList" role="status">{{ e('loadingMore') }}</p>
                <p v-else-if="state.page?.capacity_reached">{{ e('viewCapacity') }}</p>
                <p v-else-if="!nextPage && rows.length && !busy && !errorCode">{{ e('allLoaded') }}</p>
                <UButton v-if="nextPage" color="neutral" variant="ghost" size="sm" :disabled="busy || pending || state.page?.capacity_reached" @click="loadMoreList">{{ e('loadMore') }}</UButton>
              </div>
            </div>
          </section>

          <article v-else class="embedded-detail">
            <UButton type="button" color="neutral" variant="ghost" size="sm" :disabled="busy || pending" @click="send('issue_back', {})">← {{ e('back') }}</UButton>
            <IssueDetailHeader :identifier="state.issue.identifier" :title="state.issue.title">
                  <IssueMetadataSummary :status-key="state.issue.status.key" :status-label="state.issue.status.display_name || state.issue.status.key" :priority="state.issue.priority" :assignee-name="state.issue.assignee?.display_name" />
              <template #actions><IssueShare :identifier="state.issue.identifier" :origin="verifiedOrigin" /></template>
            </IssueDetailHeader>

            <IssueDetailLayout properties-id="embedded-properties" :properties-label="e('properties')">
              <template #default>
                <IssueContentSection :title="e('body')">
                  <template #actions><CopyButton :value="state.issue.body || ''" :label="e('copyMarkdown')" /></template>
                  <MarkdownContent v-if="state.issue.body" :source="state.issue.body" v-bind="markdownProps" />
                  <p v-else class="embedded-muted">{{ e('bodyEmpty') }}</p>
                </IssueContentSection>
                <IssueContentSection v-if="state.issue.completion_record || state.issue.completion" :title="e('completed')"><CompletionRecord :value="state.issue.completion_record || state.issue.completion" /></IssueContentSection>
                <IssueContentSection :title="e('activity')">
                  <template #actions><span>{{ state.comments.length }}</span></template>
                  <div class="comment-stream">
                  <p v-if="!state.comments.length" class="embedded-muted">{{ e('commentEmpty') }}</p>
                  <IssueCommentItem v-for="entry in state.comments" :key="entry.id" :author-name="entry.author?.display_name || entry.principal?.display_name" :created-at="entry.created_at" :completed="entry.kind === 'completion'">
                    <template #actions><CopyButton :value="entry.body || ''" :label="e('copyMarkdown')" /></template>
                    <CompletionRecord :value="entry.completion_record || entry.completion"><MarkdownContent :source="entry.body || ''" v-bind="markdownProps" /></CompletionRecord>
                  </IssueCommentItem>
                  </div>
                  <UButton v-if="state.comments_has_more" type="button" color="neutral" variant="ghost" size="sm" :disabled="busy" @click="send('comments', {})">{{ e('loadComments') }}</UButton>
                  <section v-if="state.capabilities.comment" class="issue-comment-form" role="form" :aria-label="e('comment')"><label for="embedded-comment">{{ e('comment') }}<UTextarea id="embedded-comment" v-model="comment" :placeholder="t('comment.placeholder')" :rows="5" :maxlength="32768" :disabled="busy || pending" /></label><UButton type="button" color="primary" variant="solid" :disabled="busy || pending || !comment.trim()" @click="addComment">{{ t('action.comment') }}</UButton></section>
                </IssueContentSection>
              </template>

              <template #properties>
                <dl class="issue-property-list">
                  <div><dt>{{ e('status') }}</dt><dd><select v-if="state.capabilities.update" :aria-label="e('status')" :value="state.issue.status.key" :disabled="busy || pending" @change="statusChanged"><option v-for="status in statusItems" :key="status.key" :value="status.key" :disabled="status.key === 'done' && !state.capabilities.complete">{{ status.display_name || status.name || status.key }}</option></select><span v-else>{{ state.issue.status.display_name || state.issue.status.key }}</span></dd></div>
                  <div><dt>{{ e('priority') }}</dt><dd><PrioritySelect v-if="state.capabilities.update" :value="state.issue.priority" :label="e('priority')" :disabled="busy || pending" @change="updateDetail({ priority_key: $event })" /><span v-else>{{ priorityText(state.issue.priority, locale === 'zh-CN') }}</span></dd></div>
                  <div><dt>{{ t('issue.assignee') }}</dt><dd><AssigneeMenu v-if="state.capabilities.update" :assignee="detailAssignee" :candidates="candidates" :has-more="!!state.assignees_has_more" :loading="peopleLoading" :disabled="(busy && !peopleLoading) || pending" @open="loadPeople(false)" @load-more="loadPeople(true)" @select="updateDetail({ assignee_principal_id: $event })" /><span v-else>{{ state.issue.assignee?.display_name || e('unassigned') }}</span></dd></div>
                  <div class="embedded-labels"><dt>{{ t('issue.labels') }}</dt><dd>
                    <div class="embedded-label-chips">
                      <span v-for="label in state.issue.labels" :key="label.id" class="label-chip">{{ label.name }}<button v-if="state.capabilities.update" type="button" :disabled="busy || pending" :aria-label="`${e('removeLabel')} ${label.name}`" @click="toggleLabel(label.id, false)">×</button></span>
                      <span v-if="!state.issue.labels?.length" class="embedded-muted">—</span>
                    </div>
                    <UPopover v-if="state.capabilities.update" v-model:open="showLabelPicker" :content="{ align: 'start' }">
                      <UButton type="button" color="neutral" variant="ghost" size="sm" :disabled="(busy && !labelsLoading) || pending">+ {{ e('addLabel') }}</UButton>
                      <template #content><div class="embedded-label-picker">
                        <label>{{ e('findLabel') }}<input v-model="labelSearch" type="search" :placeholder="e('findLabel')" /></label>
                        <p v-if="labelsLoading" role="status">{{ e('loading') }}</p>
                        <div class="embedded-label-options"><UButton v-for="label in availableLabels" :key="label.id" type="button" color="neutral" variant="ghost" :disabled="busy || pending" @click="toggleLabel(label.id, true)">{{ label.name }}</UButton></div>
                        <p v-if="!availableLabels.length && !labelsLoading">{{ e('noLabels') }}</p>
                        <UButton v-if="state.labels_has_more" type="button" color="neutral" variant="ghost" :disabled="busy || pending" @click="loadLabels(true)">{{ e('loadMore') }}</UButton>
                      </div></template>
                    </UPopover>
                  </dd></div>
                </dl>
                <div v-if="state.capabilities.complete && state.issue.status.key !== 'done'" class="sidebar-actions"><UButton type="button" color="primary" variant="solid" :disabled="busy || pending" @click="openCompletion">{{ t('complete.title') }}</UButton></div>
              </template>
            </IssueDetailLayout>

            <UModal v-if="showCompletion" :open="true" :title="t('complete.title')" :description="e('completionHelp')" :dismissible="!busy && !pending" :close="{ type: 'button', disabled: busy || pending, 'aria-label': t('action.cancel') }" :ui="{ content: 'embedded-completion-modal', header: 'embedded-modal-header', body: 'embedded-modal-body', footer: 'embedded-modal-footer' }" @update:open="!$event && !busy && !pending && (showCompletion = false)" @after:enter="focusCompletion">
              <template #body>
                <div v-if="errorCode" class="embedded-alert" role="alert"><p>{{ errorText }}</p><code>{{ errorCode }}</code></div>
                <div v-if="state.pending" class="embedded-recovery" role="status"><p>{{ e(busy ? 'saving' : 'pending') }}</p><UButton type="button" size="sm" :disabled="busy || state.session_context_changed" @click="recover">{{ e('recover') }}</UButton></div>
                <section class="embedded-form" role="form" :aria-label="t('complete.title')">
                  <label for="embedded-summary">{{ e('summary') }}</label><UTextarea id="embedded-summary" v-model="completion.summary" :rows="4" :maxlength="8192" :disabled="busy || pending" class="embedded-field" />
                  <details class="embedded-completion-evidence">
                    <summary>{{ e('completionEvidence') }}</summary>
                    <div class="embedded-form">
                      <label for="embedded-verification">{{ e('verification') }}</label><UTextarea id="embedded-verification" v-model="completion.verification" :rows="3" :disabled="busy || pending" class="embedded-field" />
                      <label>{{ e('artifactKind') }}<select v-model="completion.artifactKind" :disabled="busy || pending"><option value="path">path</option><option value="url">url</option><option value="commit">commit</option><option value="other">other</option></select></label>
                      <label for="embedded-artifacts">{{ e('artifacts') }}</label><UTextarea id="embedded-artifacts" v-model="completion.artifacts" :rows="2" :disabled="busy || pending" class="embedded-field" />
                      <label for="embedded-followups">{{ e('followUps') }}</label><UTextarea id="embedded-followups" v-model="completion.followUps" :rows="2" :disabled="busy || pending" class="embedded-field" />
                    </div>
                  </details>
                </section>
              </template>
              <template #footer><UButton type="button" color="neutral" variant="outline" :disabled="busy || pending" @click="showCompletion = false">{{ t('action.cancel') }}</UButton><UButton type="button" :disabled="busy || pending" @click="complete">{{ e('complete') }}</UButton></template>
            </UModal>
          </article>
        </template>
        <p v-if="busy" class="embedded-loading" aria-live="polite">{{ e('loading') }}</p>
      </template>
    </main>
  </UApp>
</template>
