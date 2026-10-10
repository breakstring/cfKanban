<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";

import ErrorNotice from "./components/ErrorNotice.vue";
import LocaleSwitch from "./components/LocaleSwitch.vue";
import PageState from "./components/PageState.vue";
import { ApiProblem, apiRequest } from "./lib/api";
import { clearAttachmentUploadDrafts } from "./lib/attachment-upload-drafts";
import { boardReturnPath } from "./lib/board-navigation";
import { applyAccountLocalePreference, locale, t } from "./lib/i18n";
import { lazyPage } from "./lib/lazy-page";
import { setNotificationSession } from "./lib/notifications";
import { useLocalizedError } from "./lib/localized-error";
import { currentPath, navigate, routePath } from "./lib/router";
import { scheduleSessionExpiry } from "./lib/session-expiry";
import { canAccessOwnerControlPlane } from "./lib/session-capabilities";
import { isWebSessionView, sameSessionBoundary, shouldClearAfterSessionRevalidation } from "./lib/session-boundary";
import { isSessionRenewalResult, mergeSessionFacts, SESSION_ACTIVITY_EVENTS, SessionRenewalController } from "./lib/session-renewal";
import { captureSessionTextDrafts, clearRetainedSessionTextDrafts, retainedSessionTextDrafts, setSessionDraftPrincipal } from "./lib/session-drafts";
import { applyTheme, latestPrincipalTheme } from "./lib/theme";
import type { InstanceDiscovery, Locale, PrincipalResource, WriteResult } from "./types";
import type { WebSessionView } from "./types";

const UApp = lazyPage(() => import("./components/LocalizedApp.vue"));
const AppFooter = defineAsyncComponent(() => import("./components/AppFooter.vue"));
const SessionDraftsPanel = defineAsyncComponent(() => import("./components/SessionDraftsPanel.vue"));
const AppHeader = lazyPage(() => import("./components/AppHeader.vue"));
const IssueDetailView = lazyPage(() => import("./views/IssueDetailView.vue"));
const OwnerView = lazyPage(() => import("./views/OwnerView.vue"));
const ProfileView = lazyPage(() => import("./views/ProfileView.vue"));
const NotificationsView = lazyPage(() => import("./views/NotificationsView.vue"));
const ProjectActivityView = lazyPage(() => import("./views/ProjectActivityView.vue"));
const ProjectDeletedIssuesView = lazyPage(() => import("./views/ProjectDeletedIssuesView.vue"));
const ProjectLabelsView = lazyPage(() => import("./views/ProjectLabelsView.vue"));
const ProjectMilestonesView = lazyPage(() => import("./views/ProjectMilestonesView.vue"));
const IssueTrendsView = lazyPage(() => import("./views/IssueTrendsView.vue"));
const ProjectBoardView = lazyPage(() => import("./views/ProjectBoardView.vue"));
const WorkListView = lazyPage(() => import("./views/WorkListView.vue"));
const ProjectSelectionView = lazyPage(() => import("./views/ProjectSelectionView.vue"));
const PublicHomeView = lazyPage(() => import("./views/PublicHomeView.vue"));
const ScopedManagementView = lazyPage(() => import("./views/ScopedManagementView.vue"));
const authenticatedPages = {
  selection: ProjectSelectionView, work: WorkListView, project: ProjectBoardView,
  labels: ProjectLabelsView, milestones: ProjectMilestonesView, trends: IssueTrendsView,
  activity: ProjectActivityView, deleted: ProjectDeletedIssuesView, issue: IssueDetailView,
  profile: ProfileView, notifications: NotificationsView, manage: ScopedManagementView, owner: OwnerView,
};

type OwnerSection = "overview" | "usage" | "settings" | "cloudflare" | "workspaces" | "access" | "invitations" | "audit" | "archive" | "updates";
type AppRoute =
  | { kind: "home" }
  | { kind: "selection" | "work" }
  | { identifier: string; kind: "issue" }
  | { kind: "owner"; section: OwnerSection }
  | { kind: "profile" | "notifications" }
  | { kind: "project" | "labels" | "activity" | "deleted" | "milestones"; projectId: string; workspaceId: string }
  | { kind: "trends"; workspaceId: string; projectId?: string }
  | { kind: "manage"; workspaceId: string; projectId?: string }
  | { kind: "unknown" };

const session = ref<WebSessionView | null>(null);
const discovery = ref<InstanceDiscovery | null>(null);
const preferredOrigin = computed(() => {
  const value = discovery.value?.preferred_api_origin;
  return value && value !== window.location.origin ? value : null;
});
const loadingSession = ref(false);
const localeBusy = ref(false);
const pendingLocaleSave = ref<{ principalId: string; locale: Locale; version: number; key: string } | null>(null);
const { clearError: clearLocaleError, error: localeError, appendError: appendLocaleError, setErrorKey: setLocaleErrorKey } = useLocalizedError();
const {
  clearError: clearSessionError,
  error: sessionError,
  setError: setSessionError,
} = useLocalizedError();
const sessionEnded = ref(false);
const context = ref<{ label: string; role: string; workspaceId?: string; projectId?: string } | null>(null);
const sessionViewGeneration = ref(0);
let cancelSessionExpiry: (() => void) | null = null;
let sessionLoadGeneration = 0;
let sessionReloadPending = false;
let loggingOut = false;
let sessionChannel: BroadcastChannel | null = null;
const sessionRenewal = new SessionRenewalController({
  read: signal => apiRequest<WebSessionView>("/api/v1/web-session", { signal, validateResponse: isWebSessionView, authorizationCurrent: () => !signal.aborted }),
  renew: async (version, sessionId, signal) => {
    await apiRequest("/api/v1/web-session/renew", { method: "POST", body: { expected_version: version }, idempotencyScope: sessionId, signal,
      validateResponse: value => isSessionRenewalResult(value, sessionId), authorizationCurrent: () => !signal.aborted });
  },
  accept: result => acceptVerifiedSession(result),
  expire: () => clearSession(true),
  accessFailure: caught => caught instanceof ApiProblem && shouldClearAfterSessionRevalidation(caught),
  versionConflict: caught => caught instanceof ApiProblem && caught.body.source === "service" && caught.body.code === "VERSION_CONFLICT",
  visible: () => document.visibilityState === "visible",
  notify: () => sessionChannel?.postMessage({ type: "session-facts-changed" }),
});

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const route = computed<AppRoute>(() => {
  const path = routePath();
  if (path === "/") return { kind: "home" };
  if (path === "/app") return { kind: "selection" };
  if (path === "/app/work") return { kind: "work" };
  if (path === "/app/manage") {
    const params = new URLSearchParams(currentPath.value.split("?", 2)[1] ?? "");
    const workspaceId = params.get("workspace");
    const projectId = params.get("project");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (workspaceId && uuid.test(workspaceId) && (!projectId || uuid.test(projectId))) {
      return { kind: "manage", workspaceId, ...(projectId ? { projectId } : {}) };
    }
    return { kind: "unknown" };
  }
  if (path === "/app/profile") return { kind: "profile" };
  if (path === "/app/notifications") return { kind: "notifications" };
  if (path === "/app/admin") {
    const raw = new URLSearchParams(currentPath.value.split("?", 2)[1] ?? "").get("section");
    const section: OwnerSection = raw === "usage" || raw === "cloudflare" || raw === "settings" || raw === "workspaces" || raw === "access" || raw === "invitations" || raw === "audit" || raw === "archive" || raw === "updates"
      ? raw
      : "overview";
    return { kind: "owner", section };
  }
  const project = /^\/app\/w\/([^/]+)(?:\/p\/([^/]+)(?:\/(labels|activity|deleted|milestones|trends))?|\/(trends))$/.exec(path);
  if (project !== null) {
    const workspaceId = decoded(project[1] ?? "");
    const projectId = project[2] === undefined ? undefined : decoded(project[2]);
    const section = project[3] as "labels" | "activity" | "deleted" | "milestones" | "trends" | undefined;
    if (workspaceId !== null && projectId !== null) return projectId === undefined ? { kind: "trends", workspaceId } : { kind: section ?? "project", projectId, workspaceId };
  }
  const issue = /^\/app\/issues\/(CFK-[1-9][0-9]*)$/.exec(path);
  if (issue !== null) return { identifier: issue[1] ?? "", kind: "issue" };
  return { kind: "unknown" };
});

const authenticatedRoute = computed(() => route.value.kind !== "home");
const headerContext = computed(() => "workspaceId" in route.value ? route.value : context.value);
watch(session, value => {
  setNotificationSession(value);
  setSessionDraftPrincipal(value?.principal.id ?? null);
  sessionRenewal.setSession(value);
}, { flush: "sync" });

watch([route, session], ([currentRoute, verifiedSession]) => {
  if (verifiedSession === null || currentRoute.kind === "home") return;
  void AppHeader.preload().catch(() => {});
  if (currentRoute.kind === "owner" && !canAccessOwnerControlPlane(verifiedSession)) return;
  const page = authenticatedPages[currentRoute.kind as keyof typeof authenticatedPages];
  void page?.preload().catch(() => {});
}, { immediate: true });

watch(() => session.value !== null, async authenticated => {
  discovery.value = null;
  if (!authenticated) return;
  try {
    const result = await apiRequest<InstanceDiscovery>("/.well-known/cfkanban-instance.json");
    if (session.value) discovery.value = result;
  } catch {
    // 推荐地址暂不可用时，已登录页面仍可正常使用。
  }
});

watch([authenticatedRoute, () => session.value?.principal.theme], ([authenticated, theme]) => {
  applyTheme(theme, authenticated);
}, { immediate: true });

watch([authenticatedRoute, () => Boolean(session.value), () => session.value?.principal.id, () => session.value?.principal.locale], ([authenticated, verified, _principalId, saved]) => {
  applyAccountLocalePreference(saved, authenticated && verified, authenticated);
}, { immediate: true });

async function changeLocale(value: Locale): Promise<void> {
  if (!session.value || localeBusy.value) return;
  const principalId = session.value.principal.id;
  if (pendingLocaleSave.value && pendingLocaleSave.value.principalId !== principalId) {
    setLocaleErrorKey("locale.originalAccount");
    return;
  }
  const operation = pendingLocaleSave.value ?? { principalId, locale: value, version: session.value.principal.version, key: crypto.randomUUID() };
  pendingLocaleSave.value = operation;
  localeBusy.value = true;
  clearLocaleError();
  const current = () => session.value?.principal.id === principalId;
  try {
    const result = await apiRequest<WriteResult<PrincipalResource>>("/api/v1/me", {
      method: "PATCH", body: { locale: operation.locale, expected_version: operation.version },
      idempotencyKey: operation.key, idempotencyScope: principalId, authorizationCurrent: current,
      validateResponse: value => {
        const resource = (value as WriteResult<PrincipalResource> | null)?.resource;
        return resource?.id === principalId && resource.locale === operation.locale
          && typeof resource.display_name === "string"
          && Number.isSafeInteger(resource.version) && resource.version > operation.version;
      },
    });
    pendingLocaleSave.value = null;
    if (current()) updateProfile(result.resource);
  } catch (caught) {
    const rejected = caught instanceof ApiProblem && caught.body.source === "service" && caught.status >= 400 && caught.status < 500;
    if (rejected) pendingLocaleSave.value = null;
    setLocaleErrorKey(rejected ? "locale.saveFailed" : "locale.uncertain");
    appendLocaleError(caught);
    if (rejected && caught.body.code === "VERSION_CONFLICT" && current()) {
      try { updateProfile(await apiRequest<PrincipalResource>("/api/v1/me", { authorizationCurrent: current })); }
      catch (readbackError) { appendLocaleError(readbackError); }
    }
  } finally { localeBusy.value = false; }
}

function updateProfile(principal: PrincipalResource): void {
  if (session.value?.principal.id !== principal.id) return;
  if (principal.version < session.value.principal.version) return;
  session.value.principal = {
    ...session.value.principal,
    display_name: principal.display_name,
    theme: principal.theme ?? "orange",
    ...(principal.locale === undefined ? {} : { locale: principal.locale }),
    version: principal.version,
  };
}

function clearSession(ended = true, retainDrafts = ended): void {
  if (retainDrafts && !loggingOut && session.value) captureSessionTextDrafts(session.value.principal.id);
  clearAttachmentUploadDrafts();
  cancelSessionExpiry?.();
  cancelSessionExpiry = null;
  sessionLoadGeneration += 1;
  sessionReloadPending = false;
  sessionViewGeneration.value += 1;
  loadingSession.value = false;
  session.value = null;
  context.value = null;
  clearSessionError();
  sessionEnded.value = ended;
}

function armSessionExpiry(expiresAt: string): boolean {
  cancelSessionExpiry?.();
  cancelSessionExpiry = null;
  const schedule = scheduleSessionExpiry(expiresAt, () => { void sessionRenewal.deadline(); });
  if (!schedule.scheduled) {
    clearSession(true);
    return false;
  }
  cancelSessionExpiry = schedule.cancel;
  return true;
}

function acceptVerifiedSession(result: WebSessionView): void {
  result = mergeSessionFacts(session.value, result);
  // 新验证的 Session 使此前发出的读回失效，包括身份和 scope 切换。
  sessionLoadGeneration += 1;
  loadingSession.value = false;
  clearSessionError();
  sessionEnded.value = false;
  if (session.value && !sameSessionBoundary(session.value, result)) {
    if (!loggingOut) captureSessionTextDrafts(session.value.principal.id);
    clearAttachmentUploadDrafts();
    sessionViewGeneration.value += 1;
    context.value = null;
  }
  if (armSessionExpiry(result.expires_at)) {
    session.value = { ...result, principal: latestPrincipalTheme(session.value?.principal, result.principal) };
    if (sessionReloadPending && authenticatedRoute.value) {
      sessionReloadPending = false;
      void loadSession(false);
    }
  }
}

async function loadSession(resetBeforeRequest = session.value === null): Promise<void> {
  if (!authenticatedRoute.value || loadingSession.value) return;
  if (resetBeforeRequest) clearSession(false);
  const previous = session.value;
  const generation = sessionLoadGeneration + 1;
  sessionLoadGeneration = generation;
  loadingSession.value = true;
  clearSessionError();
  sessionEnded.value = false;
  try {
    let result = await apiRequest<WebSessionView>("/api/v1/web-session", { authorizationCurrent: () => generation === sessionLoadGeneration && authenticatedRoute.value });
    if (generation !== sessionLoadGeneration || !authenticatedRoute.value) return;
    result = mergeSessionFacts(session.value, result);
    if (previous !== null && !sameSessionBoundary(previous, result)) {
      if (!loggingOut) captureSessionTextDrafts(previous.principal.id);
      clearAttachmentUploadDrafts();
      sessionViewGeneration.value += 1;
      context.value = null;
    }
    if (armSessionExpiry(result.expires_at)) session.value = { ...result, principal: latestPrincipalTheme(session.value?.principal, result.principal) };
  } catch (caught) {
    if (generation !== sessionLoadGeneration) return;
    if (previous === null) {
      session.value = null;
      if (caught instanceof ApiProblem && caught.status === 401) sessionEnded.value = true;
      else setSessionError(caught);
    } else if (caught instanceof ApiProblem && shouldClearAfterSessionRevalidation(caught)) {
      clearSession(false, true);
      setSessionError(caught);
    } else if (!(caught instanceof ApiProblem && caught.status === 401)) {
      setSessionError(caught);
    }
  } finally {
    if (generation === sessionLoadGeneration) {
      loadingSession.value = false;
      if (sessionReloadPending && authenticatedRoute.value && session.value !== null) {
        sessionReloadPending = false;
        void loadSession(false);
      }
    }
  }
}

async function logout(): Promise<void> {
  loggingOut = true;
  try {
    await apiRequest("/api/v1/web-session", { method: "DELETE" });
  } catch (caught) {
    if (!(caught instanceof ApiProblem && caught.status === 401)) {
      setSessionError(caught);
      loggingOut = false;
      return;
    }
  }
  clearRetainedSessionTextDrafts();
  clearSession(false);
  loggingOut = false;
  sessionChannel?.postMessage({ type: "session-facts-changed" });
  navigate("/");
}

function sessionActivity(event: Event): void { sessionRenewal.activity(event); }
function tabSessionHint(event: MessageEvent): void {
  if (event.data?.type === "session-facts-changed") sessionRenewal.hint();
}
function eventProblem(event: Event): ApiProblem | null {
  return event instanceof CustomEvent && event.detail instanceof ApiProblem ? event.detail : null;
}

function sessionInvalid(event: Event): void {
  if (!authenticatedRoute.value) return;
  const problem = eventProblem(event);
  clearSession(true);
  if (problem !== null) setSessionError(problem);
}

function authorizationStale(): void {
  if (!authenticatedRoute.value) return;
  if (loadingSession.value) {
    sessionReloadPending = true;
    return;
  }
  void loadSession(false);
}

function revalidateVisibleSession(): void {
  if (authenticatedRoute.value && document.visibilityState === "visible") void loadSession();
}

onMounted(() => {
  for (const name of SESSION_ACTIVITY_EVENTS) document.addEventListener(name, sessionActivity, { passive: true });
  if (typeof window.BroadcastChannel === "function") {
    sessionChannel = new window.BroadcastChannel("cfkanban:session-facts");
    sessionChannel.addEventListener("message", tabSessionHint);
  }
  window.addEventListener("cfkanban:session-invalid", sessionInvalid);
  window.addEventListener("cfkanban:authorization-stale", authorizationStale);
  window.addEventListener("cfkanban:session-exchanged", authorizationStale);
  window.addEventListener("focus", revalidateVisibleSession);
  window.addEventListener("pageshow", revalidateVisibleSession);
  document.addEventListener("visibilitychange", revalidateVisibleSession);
  void loadSession();
});
onUnmounted(() => {
  for (const name of SESSION_ACTIVITY_EVENTS) document.removeEventListener(name, sessionActivity);
  sessionChannel?.close(); sessionChannel = null;
  clearRetainedSessionTextDrafts();
  clearSession(false);
  window.removeEventListener("cfkanban:session-invalid", sessionInvalid);
  window.removeEventListener("cfkanban:authorization-stale", authorizationStale);
  window.removeEventListener("cfkanban:session-exchanged", authorizationStale);
  window.removeEventListener("focus", revalidateVisibleSession);
  window.removeEventListener("pageshow", revalidateVisibleSession);
  document.removeEventListener("visibilitychange", revalidateVisibleSession);
});

watch(currentPath, () => {
  context.value = null;
  if (!authenticatedRoute.value) clearSession(false);
  else if (session.value === null && !loadingSession.value) void loadSession();
  else if (route.value.kind === "selection") authorizationStale();
});
</script>

<template>
  <SessionDraftsPanel v-if="retainedSessionTextDrafts.length" :session="session" />
  <PublicHomeView v-if="route.kind === 'home'" />

  <UApp v-else>
  <div class="application-shell" :class="{ 'application-shell--board': route.kind === 'project' && session }">
    <AppHeader
      v-if="session"
      :context="context?.label"
      :role="context?.role"
      :session="session"
      :locale-busy="localeBusy"
      :locale-retry="!!pendingLocaleSave"
      :project-id="headerContext?.projectId"
      :workspace-id="headerContext?.workspaceId"
      @verified="acceptVerifiedSession"
      @logout="logout"
      @locale="changeLocale"
    />
    <ErrorNotice v-if="localeError" :error="localeError" />

    <div v-if="loadingSession && !session" class="session-gate">
      <PageState loading />
    </div>

    <main v-else-if="!session" class="session-gate">
      <div class="session-message">
        <p class="eyebrow">{{ locale === "zh-CN" ? "网页会话" : "Web Session" }}</p>
        <h1>{{ sessionEnded ? t("session.title") : (locale === "zh-CN" ? "无法验证会话" : "Session could not be verified") }}</h1>
        <ErrorNotice v-if="sessionError" :error="sessionError" />
        <p>{{ locale === "zh-CN" ? "请返回实例首页使用通行密钥，或让智能体创建新的浏览器启动链接。" : "Return home to use a Passkey, or ask your Agent for a new Browser Launch." }}</p>
        <div class="form-actions">
          <button class="secondary-button" type="button" @click="loadSession(true)">{{ t("action.refresh") }}</button>
          <button class="primary-button" type="button" @click="navigate('/')">{{ locale === "zh-CN" ? "返回实例首页" : "Return home" }}</button>
        </div>
        <LocaleSwitch />
      </div>
    </main>

    <template v-else>
      <ErrorNotice v-if="sessionError" :error="sessionError" />
      <ProjectSelectionView v-if="route.kind === 'selection'" :key="`${sessionViewGeneration}:${currentPath}`" :session="session" />
      <WorkListView v-else-if="route.kind === 'work'" :key="`${sessionViewGeneration}:${currentPath}`" :session="session" />
      <ProjectBoardView
        v-else-if="route.kind === 'project'"
        :key="`${sessionViewGeneration}:${currentPath}`"
        :project-id="route.projectId"
        :session="session"
        :workspace-id="route.workspaceId"
        @context="context = $event"
      />
      <ProjectLabelsView v-else-if="route.kind === 'labels'" :key="`${sessionViewGeneration}:${currentPath}`" :workspace-id="route.workspaceId" :project-id="route.projectId" :session="session" @context="context = $event" />
      <ProjectMilestonesView v-else-if="route.kind === 'milestones'" :key="`${sessionViewGeneration}:${currentPath}`" :workspace-id="route.workspaceId" :project-id="route.projectId" :session="session" @context="context = $event" />
      <IssueTrendsView v-else-if="route.kind === 'trends'" :key="`${sessionViewGeneration}:${currentPath}`" :workspace-id="route.workspaceId" :project-id="route.projectId" :session="session" @context="context = $event" />
      <ProjectActivityView v-else-if="route.kind === 'activity'" :key="`${sessionViewGeneration}:${currentPath}`" :workspace-id="route.workspaceId" :project-id="route.projectId" :session="session" :return-to="boardReturnPath(route.workspaceId, route.projectId, currentPath.split('?').slice(1).join('?'))" @navigate="navigate" @context="context = $event" />
      <ProjectDeletedIssuesView v-else-if="route.kind === 'deleted'" :key="`${sessionViewGeneration}:${currentPath}`" :workspace-id="route.workspaceId" :project-id="route.projectId" :session="session" :return-to="boardReturnPath(route.workspaceId, route.projectId, currentPath.split('?').slice(1).join('?'))" @navigate="navigate" @context="context = $event" />
      <IssueDetailView
        v-else-if="route.kind === 'issue'"
        :key="`${sessionViewGeneration}:${currentPath}`"
        :identifier="route.identifier"
        :session="session"
        @context="context = $event"
      />
      <ProfileView
        v-else-if="route.kind === 'profile'"
        :key="`${sessionViewGeneration}:${currentPath}`"
        :session="session"
        :profile-locked="localeBusy || pendingLocaleSave?.principalId === session.principal.id"
        @context="context = $event"
        @updated="updateProfile"
      />
      <NotificationsView
        v-else-if="route.kind === 'notifications'"
        :key="`${sessionViewGeneration}:${currentPath}`"
        :session="session"
        @context="context = $event"
      />
      <ScopedManagementView
        v-else-if="route.kind === 'manage'"
        :key="`${sessionViewGeneration}:${currentPath}`"
        :workspace-id="route.workspaceId"
        :project-id="route.projectId"
        :session="session"
        @context="context = $event"
      />
      <OwnerView
        v-else-if="route.kind === 'owner' && canAccessOwnerControlPlane(session)"
        :key="`${sessionViewGeneration}:${route.section === 'overview' || route.section === 'usage' ? 'owner-usage' : currentPath}`"
        :section="route.section"
        :session="session"
        @context="context = $event"
      />
      <main v-else class="session-gate">
        <div class="session-message">
          <p class="eyebrow">404</p>
          <h1>{{ locale === "zh-CN" ? "页面不可用" : "Page unavailable" }}</h1>
          <p>{{ locale === "zh-CN" ? "此路径不在当前网页会话的可用范围内。" : "This path is not available in the current Web Session." }}</p>
          <button class="primary-button" type="button" @click="navigate('/app')">{{ t("project.choose") }}</button>
        </div>
      </main>
      <AppFooter :preferred-origin="preferredOrigin" />
    </template>
  </div>
  </UApp>
</template>
