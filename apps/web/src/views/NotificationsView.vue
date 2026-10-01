<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import { computed, onUnmounted, ref, watch } from "vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { captureCasConflict, markCasReadbackComplete, markCasReadbackFailed, type CasConflictState } from "../lib/cas-recovery";
import { locale } from "../lib/i18n";
import { localizedText, useLocalizedError } from "../lib/localized-error";
import { checkNotificationAttention, clearNotificationAttention, hasNotificationPreferences, hasNotificationResource, isNotificationPage, isNotificationPreferences, notificationSessionKey, type NotificationPage, type NotificationPreferences, type NotificationResource } from "../lib/notifications";
import { canAccessOwnerControlPlane } from "../lib/session-capabilities";
import type { WebSessionView, WriteResult } from "../types";

const props = defineProps<{ session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();
const ui = (english: string, chinese: string): string => locale.value === "zh-CN" ? chinese : english;
const canPublish = computed(() => canAccessOwnerControlPlane(props.session));
type Mode = "pending" | "history" | "published";
const mode = ref<Mode>("pending");
const items = ref<NotificationResource[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const expandedId = ref<string | null>(null);
const preferences = ref<NotificationPreferences | null>(null);
const receiveEnabled = ref(true);
const preferencesLoading = ref(false);
const title = ref("");
const body = ref("");
const expires = ref("");
const busy = ref(false);
const published = ref(false);
const publishUncertain = ref(false);
const { error, clearError, setError, setLocalizedError } = useLocalizedError();
const { error: listError, clearError: clearListError, setError: setListError } = useLocalizedError();
const { error: preferenceError, clearError: clearPreferenceError, setError: setPreferenceError } = useLocalizedError();
const casConflict = ref<CasConflictState | null>(null);
let identityGeneration = 0;
let listGeneration = 0;
let preferenceGeneration = 0;
let casReadback: (() => Promise<void>) | null = null;
let casGeneration = 0;
let publicationAttempt: { title: string; body: string; expires_at?: string } | null = null;

const titleLength = computed(() => Array.from(title.value).length);
const bodyLength = computed(() => Array.from(body.value).length);
const publicationInvalid = computed(() => titleLength.value < 1 || titleLength.value > 200 || bodyLength.value < 1 || bodyLength.value > 4000
  || (expires.value !== "" && (!Number.isFinite(Date.parse(expires.value)) || Date.parse(expires.value) <= Date.now())));

function listPath(): string {
  const params = new URLSearchParams({ limit: "20" });
  if (mode.value !== "published") params.set("pending", mode.value === "pending" ? "true" : "false");
  if (cursor.value) params.set("cursor", cursor.value);
  return `${mode.value === "published" ? "/api/v1/admin/notifications" : "/api/v1/me/notifications"}?${params}`;
}

function clearDisabledPending(): void {
  if (mode.value !== "pending" || preferences.value?.enabled !== false) return;
  listGeneration += 1;
  items.value = []; cursor.value = null; expandedId.value = null;
  loading.value = false;
  clearListError();
}

async function loadList(reset = false, throwOnFailure = false): Promise<void> {
  if (mode.value === "pending" && preferences.value?.enabled === false) { clearDisabledPending(); return; }
  if (!reset && loading.value) return;
  if (mode.value === "published" && !canPublish.value) return;
  const identity = identityGeneration;
  const request = ++listGeneration;
  if (reset) { items.value = []; cursor.value = null; expandedId.value = null; }
  loading.value = true;
  clearListError();
  try {
    const result = await apiRequest<NotificationPage>(listPath(), { validateResponse: isNotificationPage });
    if (identity !== identityGeneration || request !== listGeneration) return;
    if (mode.value === "pending" && preferences.value?.enabled === false) { clearDisabledPending(); return; }
    const existing = new Set(items.value.map(item => item.id));
    items.value = [...items.value, ...result.items.filter(item => !existing.has(item.id))];
    cursor.value = result.next_cursor;
  } catch (caught) {
    if (identity !== identityGeneration || request !== listGeneration) return;
    setListError(caught);
    if (throwOnFailure) throw caught;
  } finally {
    if (identity === identityGeneration && request === listGeneration) loading.value = false;
  }
}

async function loadPreferences(preserveDraft = false, throwOnFailure = false): Promise<void> {
  const identity = identityGeneration;
  const request = ++preferenceGeneration;
  preferencesLoading.value = true;
  clearPreferenceError();
  try {
    const result = await apiRequest<NotificationPreferences>("/api/v1/me/notification-preferences", { validateResponse: isNotificationPreferences });
    if (identity !== identityGeneration || request !== preferenceGeneration) return;
    const previouslyDisabled = preferences.value?.enabled === false;
    preferences.value = result;
    if (!result.enabled) { clearNotificationAttention(); clearDisabledPending(); }
    else if (previouslyDisabled && mode.value === "pending") void loadList(true);
    if (!preserveDraft) receiveEnabled.value = result.enabled;
  } catch (caught) {
    if (identity !== identityGeneration || request !== preferenceGeneration) return;
    setPreferenceError(caught);
    if (throwOnFailure) throw caught;
  } finally {
    if (identity === identityGeneration && request === preferenceGeneration) preferencesLoading.value = false;
  }
}

function dismissConflict(): void { casGeneration += 1; casConflict.value = null; casReadback = null; }
async function refreshConflict(): Promise<void> {
  const conflict = casConflict.value;
  const readback = casReadback;
  if (!conflict || !readback) return;
  const identity = identityGeneration;
  const recovery = ++casGeneration;
  casConflict.value = { ...conflict, readbackState: "pending" };
  try {
    await readback();
    if (identity === identityGeneration && recovery === casGeneration) casConflict.value = markCasReadbackComplete(conflict);
  } catch {
    if (identity === identityGeneration && recovery === casGeneration) casConflict.value = markCasReadbackFailed(conflict);
  }
}
async function recoverConflict(caught: unknown, resource: ReturnType<typeof localizedText>, draft: unknown, readback: () => Promise<void>): Promise<boolean> {
  const conflict = captureCasConflict(caught, resource, draft);
  if (!conflict) return false;
  casConflict.value = conflict;
  casReadback = readback;
  setLocalizedError("The announcement or preference changed remotely. Review the latest facts before submitting again.", "公告或接收偏好已发生变化。请核对最新事实后再提交。");
  await refreshConflict();
  return true;
}

async function savePreference(): Promise<void> {
  if (busy.value || !preferences.value || receiveEnabled.value === preferences.value.enabled) return;
  const identity = identityGeneration;
  const draft = { enabled: receiveEnabled.value, expected_version: preferences.value.version };
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<NotificationPreferences>>("/api/v1/me/notification-preferences", { method: "PATCH", body: draft, validateResponse: hasNotificationPreferences });
    if (identity !== identityGeneration) return;
    preferenceGeneration += 1;
    preferences.value = result.resource;
    clearNotificationAttention();
    clearDisabledPending();
    receiveEnabled.value = result.resource.enabled;
    dismissConflict();
    await loadList(true);
    void checkNotificationAttention(true);
  } catch (caught) {
    if (identity !== identityGeneration) return;
    if (!await recoverConflict(caught, localizedText("Notification preference", "通知偏好"), draft, () => loadPreferences(true, true))) setError(caught);
  } finally { if (identity === identityGeneration) busy.value = false; }
}

async function acknowledge(item: NotificationResource): Promise<void> {
  if (busy.value || expandedId.value !== item.id || item.acknowledged_at || mode.value === "published") return;
  const identity = identityGeneration;
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<NotificationResource>>(`/api/v1/me/notifications/${encodeURIComponent(item.id)}/commands/acknowledge`, { method: "POST", body: {}, validateResponse: value => hasNotificationResource(value) && value.resource.id === item.id && value.resource.acknowledged_at !== null });
    if (identity !== identityGeneration) return;
    listGeneration += 1;
    loading.value = false;
    items.value = mode.value === "pending" ? items.value.filter(current => current.id !== item.id)
      : items.value.map(current => current.id === item.id ? result.resource : current);
    expandedId.value = null;
    void checkNotificationAttention(true);
  } catch (caught) {
    if (identity !== identityGeneration) return;
    setError(caught);
    await loadList(true);
  } finally { if (identity === identityGeneration) busy.value = false; }
}

async function publish(): Promise<void> {
  if (!canPublish.value || busy.value || (!publishUncertain.value && publicationInvalid.value)) return;
  const identity = identityGeneration;
  const draft = publicationAttempt ?? { title: title.value, body: body.value, ...(expires.value ? { expires_at: new Date(expires.value).toISOString() } : {}) };
  publicationAttempt = draft;
  busy.value = true;
  published.value = false;
  clearError();
  try {
    await apiRequest<WriteResult<NotificationResource>>("/api/v1/admin/notifications", { method: "POST", body: draft, validateResponse: hasNotificationResource });
    if (identity !== identityGeneration) return;
    publicationAttempt = null;
    publishUncertain.value = false;
    title.value = ""; body.value = ""; expires.value = "";
    published.value = true;
    dismissConflict();
    if (mode.value !== "published") mode.value = "published";
    else await loadList(true);
  } catch (caught) {
    if (identity !== identityGeneration) return;
    publishUncertain.value = caught instanceof ApiProblem && (caught.status === 0 || caught.status === 503);
    if (!publishUncertain.value) publicationAttempt = null;
    if (!await recoverConflict(caught, localizedText("Announcement", "公告"), draft, () => loadList(true, true))) setError(caught);
  } finally { if (identity === identityGeneration) busy.value = false; }
}

async function withdraw(item: NotificationResource): Promise<void> {
  if (!canPublish.value || busy.value || mode.value !== "published" || item.withdrawn_at !== null) return;
  const identity = identityGeneration;
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<NotificationResource>>(`/api/v1/admin/notifications/${encodeURIComponent(item.id)}/commands/withdraw`, { method: "POST", body: { expected_version: item.version }, validateResponse: value => hasNotificationResource(value) && value.resource.id === item.id && value.resource.status === "withdrawn" });
    if (identity !== identityGeneration) return;
    listGeneration += 1;
    loading.value = false;
    items.value = items.value.map(current => current.id === item.id ? result.resource : current);
    dismissConflict();
  } catch (caught) {
    if (identity !== identityGeneration) return;
    if (!await recoverConflict(caught, localizedText("Announcement", "公告"), { action: "withdraw", id: item.id, expected_version: item.version }, () => loadList(true, true))) {
      setError(caught);
      await loadList(true);
    }
  } finally { if (identity === identityGeneration) busy.value = false; }
}

function statusText(item: NotificationResource): string {
  if (item.status === "withdrawn") return ui("Withdrawn", "已撤回");
  if (item.status === "expired") return ui("Expired", "已过期");
  return item.acknowledged_at ? ui("Confirmed", "已确认") : ui("Active", "有效");
}
function formatTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}
function refresh(): void { void loadList(true); void loadPreferences(true); void checkNotificationAttention(true); }

watch(mode, () => { void loadList(true); }, { flush: "sync" });
watch(() => notificationSessionKey(props.session), () => {
  identityGeneration += 1;
  listGeneration += 1;
  preferenceGeneration += 1;
  items.value = []; cursor.value = null; expandedId.value = null;
  preferences.value = null; receiveEnabled.value = true;
  title.value = ""; body.value = ""; expires.value = "";
  publicationAttempt = null; publishUncertain.value = false; published.value = false; busy.value = false;
  clearError(); dismissConflict();
  if (mode.value === "published" && !canPublish.value) mode.value = "pending";
  emit("context", { label: ui("Notifications", "通知"), role: props.session.principal.is_owner ? "owner" : "member" });
  void loadPreferences();
  void loadList(true);
}, { immediate: true, flush: "sync" });
onUnmounted(() => { identityGeneration += 1; listGeneration += 1; preferenceGeneration += 1; casGeneration += 1; });
</script>

<template>
  <main class="page-shell notifications-page">
    <header class="page-title-block notification-heading">
      <div><p class="eyebrow">{{ ui("Instance announcements", "实例公告") }}</p><h1>{{ ui("Notifications", "通知") }}</h1></div>
      <UButton color="neutral" variant="outline" type="button" :disabled="busy" @click="refresh">{{ ui("Refresh", "刷新") }}</UButton>
    </header>
    <ErrorNotice v-if="error" :error="error" />
    <CasConflictNotice v-if="casConflict" :conflict="casConflict" :busy="busy || casConflict.readbackState === 'pending'" @refresh="refreshConflict" @dismiss="dismissConflict" />
    <section class="notification-preferences" aria-labelledby="notification-preferences-heading">
      <h2 id="notification-preferences-heading">{{ ui("Receiving announcements", "接收公告") }}</h2>
      <p class="muted-copy">{{ ui("Turning reminders off keeps history available. Turning them back on starts with new announcements; earlier reminders and announcements from the disabled period are not replayed.", "关闭提醒后仍可主动查看历史。重新开启只接收此后的新公告，不补发先前提醒或关闭期间的公告。") }}</p>
      <PageState :loading="preferencesLoading && !preferences" :error="preferenceError" :action-label="ui('Retry preference', '重试偏好读取')" @retry="loadPreferences(true)" />
      <form v-if="preferences" class="form-actions" @submit.prevent="savePreference">
        <label class="notification-toggle"><input v-model="receiveEnabled" type="checkbox" :disabled="busy || preferencesLoading" /> {{ ui("Receive announcement reminders", "接收公告提醒") }}</label>
        <UButton type="submit" :disabled="busy || preferencesLoading || receiveEnabled === preferences.enabled">{{ ui("Save preference", "保存偏好") }}</UButton>
      </form>
    </section>
    <section v-if="canPublish" class="notification-publish" aria-labelledby="notification-publish-heading">
      <h2 id="notification-publish-heading">{{ ui("Publish an announcement", "发布公告") }}</h2>
      <p class="muted-copy">{{ ui("Announcements are plain text for this instance. Published text cannot be edited; withdraw it and publish a correction when needed.", "公告以纯文本发送给此实例。发布后正文不可修改；需要更正时撤回原公告，再发布新公告。") }}</p>
      <form class="notification-compose" @submit.prevent="publish">
        <label>{{ ui("Title", "标题") }}<UInput v-model="title" class="w-full" :disabled="busy || publishUncertain" required :aria-invalid="titleLength > 200" /><small>{{ titleLength }} / 200</small></label>
        <label>{{ ui("Announcement text", "公告正文") }}<UTextarea v-model="body" class="w-full" :rows="5" :disabled="busy || publishUncertain" required :aria-invalid="bodyLength > 4000" /><small>{{ bodyLength }} / 4000</small></label>
        <label>{{ ui("Expires at (optional, your local time)", "过期时间（可选，按本地时间）") }}<UInput v-model="expires" type="datetime-local" class="notification-expiry" :disabled="busy || publishUncertain" /><small>{{ ui("Choose a future time, or leave empty for no expiry.", "选择未来时间；留空表示不过期。") }}</small></label>
        <p v-if="publishUncertain" class="warning-panel" role="status">{{ ui("The publication outcome is uncertain. Your draft is retained; retry sends the same request and key.", "发布结果尚未确认。草稿已保留；重试会发送同一请求并复用原幂等键。") }}</p>
        <div class="form-actions"><UButton type="submit" :loading="busy" :disabled="busy || (!publishUncertain && publicationInvalid)">{{ publishUncertain ? ui("Retry same publication", "重试同一发布") : ui("Publish announcement", "发布公告") }}</UButton><span v-if="published" role="status">{{ ui("Announcement published", "公告已发布") }}</span></div>
      </form>
    </section>
    <section class="notification-list" aria-labelledby="notification-list-heading">
      <h2 id="notification-list-heading" class="sr-only">{{ ui("Announcement list", "公告列表") }}</h2>
      <nav class="notification-tabs" :aria-label="ui('Announcement views', '公告视图')">
        <UButton color="neutral" :variant="mode === 'pending' ? 'solid' : 'ghost'" :disabled="busy" :aria-current="mode === 'pending' ? 'page' : undefined" @click="mode = 'pending'">{{ ui("Awaiting confirmation", "待确认") }}</UButton>
        <UButton color="neutral" :variant="mode === 'history' ? 'solid' : 'ghost'" :disabled="busy" :aria-current="mode === 'history' ? 'page' : undefined" @click="mode = 'history'">{{ ui("History", "历史") }}</UButton>
        <UButton v-if="canPublish" color="neutral" :variant="mode === 'published' ? 'solid' : 'ghost'" :disabled="busy" :aria-current="mode === 'published' ? 'page' : undefined" @click="mode = 'published'">{{ ui("Published by Owner", "Owner 发布历史") }}</UButton>
      </nav>
      <p class="muted-copy">{{ mode === 'published' ? ui("Your published announcements, including expired and withdrawn ones.", "本人发布的公告，包括已过期和已撤回的公告。") : mode === 'history' ? ui("All announcements from others, including before you joined, while reminders were off, and those confirmed, expired, or withdrawn.", "他人发布的所有公告，包括加入前、关闭提醒期间，以及已确认、已过期或已撤回的公告。") : ui("Open the text before explicitly confirming each announcement. A badge or an opened page does not confirm it.", "先打开正文，再逐条明确确认。角标或打开页面不会自动确认公告。") }}</p>
      <PageState :loading="loading && items.length === 0" :error="listError" :action-label="ui('Retry loading', '重试加载')" @retry="loadList(items.length === 0)" />
      <article v-for="item in items" :key="item.id" class="notification-card">
        <div class="notification-card-heading"><h3>{{ item.title }}</h3><span class="notification-status" :data-status="item.status">{{ statusText(item) }}</span></div>
        <p class="notification-time">{{ formatTime(item.created_at) }}<span v-if="item.expires_at"> · {{ ui("Expires", "过期") }} {{ formatTime(item.expires_at) }}</span><span v-if="item.withdrawn_at"> · {{ ui("Withdrawn", "撤回") }} {{ formatTime(item.withdrawn_at) }}</span></p>
        <UButton color="neutral" variant="ghost" type="button" :disabled="busy" :aria-expanded="expandedId === item.id" :aria-controls="`notification-text-${item.id}`" @click="expandedId = expandedId === item.id ? null : item.id">{{ expandedId === item.id ? ui("Hide text", "收起正文") : ui("Read announcement", "阅读公告") }}</UButton>
        <div v-if="expandedId === item.id" :id="`notification-text-${item.id}`" class="notification-text">
          <p class="notification-body">{{ item.body }}</p>
          <div class="form-actions"><UButton v-if="mode !== 'published' && !item.acknowledged_at" type="button" :disabled="busy" @click="acknowledge(item)">{{ ui("I have read this announcement", "我已阅读此公告") }}</UButton><span v-if="item.acknowledged_at" class="muted-copy">{{ ui("Confirmed", "已确认") }} {{ formatTime(item.acknowledged_at) }}</span><UButton v-if="mode === 'published' && canPublish && item.withdrawn_at === null" color="error" variant="outline" type="button" :disabled="busy" @click="withdraw(item)">{{ ui("Withdraw announcement", "撤回公告") }}</UButton></div>
        </div>
      </article>
      <p v-if="!loading && !listError && items.length === 0" class="empty-copy">{{ mode === 'pending' ? ui("No announcements are awaiting confirmation.", "暂无待确认公告。") : ui("No announcements yet.", "暂无公告。") }}</p>
      <div v-if="cursor" class="form-actions"><UButton color="neutral" variant="outline" :loading="loading" :disabled="loading || busy" @click="loadList()">{{ ui("Load more", "继续查看") }}</UButton></div>
    </section>
  </main>
</template>

<style scoped>
.notifications-page { max-width: 960px; }
.notification-heading, .notification-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.notification-preferences, .notification-publish, .notification-list { margin: 1.5rem 0; padding: 1.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.notification-preferences h2, .notification-publish h2 { margin-top: 0; font-size: 1.15rem; }
.notification-toggle { display: flex; align-items: center; gap: .5rem; }
.notification-toggle input { width: 1.1rem; height: 1.1rem; accent-color: var(--ui-primary); }
.notification-compose { display: grid; gap: 1rem; }
.notification-compose label { display: grid; gap: .4rem; }
.notification-compose small, .notification-time { color: var(--color-text-muted); font-size: .85rem; }
.notification-expiry { max-width: 20rem; }
.notification-tabs { display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: .75rem; }
.notification-card { padding: 1rem 0; border-top: 1px solid var(--color-border); }
.notification-card h3 { margin: 0; font-size: 1.05rem; overflow-wrap: anywhere; }
.notification-status { flex-shrink: 0; color: var(--color-text-muted); font-size: .8rem; }
.notification-status[data-status="active"] { color: var(--ui-primary); }
.notification-time { margin: .5rem 0; }
.notification-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.notification-text { padding: .25rem .75rem; border-left: 3px solid var(--ui-primary); }
@media (max-width: 640px) { .notification-preferences, .notification-publish, .notification-list { padding: 1rem; } .notification-card-heading { align-items: flex-start; } }
</style>
