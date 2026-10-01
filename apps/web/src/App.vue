<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { en, zh_cn } from "@nuxt/ui/locale";

import AppFooter from "./components/AppFooter.vue";
import ErrorNotice from "./components/ErrorNotice.vue";
import LocaleSwitch from "./components/LocaleSwitch.vue";
import PageState from "./components/PageState.vue";
import { ApiProblem, apiRequest } from "./lib/api";
import { clearAttachmentUploadDrafts } from "./lib/attachment-upload-drafts";
import { boardReturnPath } from "./lib/board-navigation";
import { locale, t } from "./lib/i18n";
import { lazyPage } from "./lib/lazy-page";
import { setNotificationSession } from "./lib/notifications";
import { useLocalizedError } from "./lib/localized-error";
import { currentPath, navigate, routePath } from "./lib/router";
import { scheduleSessionExpiry } from "./lib/session-expiry";
import { canAccessOwnerControlPlane } from "./lib/session-capabilities";
import { sameSessionBoundary, shouldClearAfterSessionRevalidation } from "./lib/session-boundary";
import { applyTheme, latestPrincipalTheme } from "./lib/theme";
import type { InstanceDiscovery, PrincipalResource } from "./types";
import type { WebSessionView } from "./types";

const UApp = lazyPage(() => import("@nuxt/ui/components/App.vue"));
const AppHeader = lazyPage(() => import("./components/AppHeader.vue"));
const IssueDetailView = lazyPage(() => import("./views/IssueDetailView.vue"));
const OwnerView = lazyPage(() => import("./views/OwnerView.vue"));
const ProfileView = lazyPage(() => import("./views/ProfileView.vue"));
const NotificationsView = lazyPage(() => import("./views/NotificationsView.vue"));
const ProjectActivityView = lazyPage(() => import("./views/ProjectActivityView.vue"));
const ProjectDeletedIssuesView = lazyPage(() => import("./views/ProjectDeletedIssuesView.vue"));
const ProjectLabelsView = lazyPage(() => import("./views/ProjectLabelsView.vue"));
const ProjectBoardView = lazyPage(() => import("./views/ProjectBoardView.vue"));
const WorkListView = lazyPage(() => import("./views/WorkListView.vue"));
const ProjectSelectionView = lazyPage(() => import("./views/ProjectSelectionView.vue"));
const PublicHomeView = lazyPage(() => import("./views/PublicHomeView.vue"));
const ScopedManagementView = lazyPage(() => import("./views/ScopedManagementView.vue"));

type OwnerSection = "overview" | "workspaces" | "access" | "invitations" | "audit" | "archive";
type AppRoute =
  | { kind: "home" }
  | { kind: "selection" | "work" }
  | { identifier: string; kind: "issue" }
  | { kind: "owner"; section: OwnerSection }
  | { kind: "profile" | "notifications" }
  | { kind: "project" | "labels" | "activity" | "deleted"; projectId: string; workspaceId: string }
  | { kind: "manage"; workspaceId: string; projectId?: string }
  | { kind: "unknown" };

const session = ref<WebSessionView | null>(null);
const discovery = ref<InstanceDiscovery | null>(null);
const preferredOrigin = computed(() => {
  const value = discovery.value?.preferred_api_origin;
  return value && value !== window.location.origin ? value : null;
});
const loadingSession = ref(false);
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
    const section: OwnerSection = raw === "workspaces" || raw === "access" || raw === "invitations" || raw === "audit" || raw === "archive"
      ? raw
      : "overview";
    return { kind: "owner", section };
  }
  const project = /^\/app\/w\/([^/]+)\/p\/([^/]+)(?:\/(labels|activity|deleted))?$/.exec(path);
  if (project !== null) {
    const workspaceId = decoded(project[1] ?? "");
    const projectId = decoded(project[2] ?? "");
    if (workspaceId !== null && projectId !== null) return { kind: project[3] === "labels" || project[3] === "activity" || project[3] === "deleted" ? project[3] : "project", projectId, workspaceId };
  }
  const issue = /^\/app\/issues\/(CFK-[1-9][0-9]*)$/.exec(path);
  if (issue !== null) return { identifier: issue[1] ?? "", kind: "issue" };
  return { kind: "unknown" };
});

const authenticatedRoute = computed(() => route.value.kind !== "home");
watch(session, value => setNotificationSession(value), { flush: "sync" });

watch([route, session], ([currentRoute, verifiedSession]) => {
  if (verifiedSession === null || currentRoute.kind === "home") return;
  void AppHeader.preload().catch(() => {});
  const page = currentRoute.kind === "selection" ? ProjectSelectionView
    : currentRoute.kind === "work" ? WorkListView
    : currentRoute.kind === "project" ? ProjectBoardView
    : currentRoute.kind === "labels" ? ProjectLabelsView
    : currentRoute.kind === "activity" ? ProjectActivityView
    : currentRoute.kind === "deleted" ? ProjectDeletedIssuesView
    : currentRoute.kind === "issue" ? IssueDetailView
    : currentRoute.kind === "profile" ? ProfileView
    : currentRoute.kind === "notifications" ? NotificationsView
    : currentRoute.kind === "manage" ? ScopedManagementView
    : currentRoute.kind === "owner" && canAccessOwnerControlPlane(verifiedSession) ? OwnerView
    : null;
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

function updateProfile(principal: PrincipalResource): void {
  if (session.value?.principal.id !== principal.id) return;
  if (principal.version < session.value.principal.version) return;
  session.value.principal = {
    ...session.value.principal,
    display_name: principal.display_name,
    theme: principal.theme ?? "orange",
    version: principal.version,
  };
}

function clearSession(ended = true): void {
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
  const schedule = scheduleSessionExpiry(expiresAt, () => clearSession(true));
  if (!schedule.scheduled) {
    clearSession(true);
    return false;
  }
  cancelSessionExpiry = schedule.cancel;
  return true;
}

function acceptVerifiedSession(result: WebSessionView): void {
  // 新验证的 Session 使此前发出的读回失效，包括身份和 scope 切换。
  sessionLoadGeneration += 1;
  loadingSession.value = false;
  clearSessionError();
  sessionEnded.value = false;
  if (session.value && !sameSessionBoundary(session.value, result)) {
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
    const result = await apiRequest<WebSessionView>("/api/v1/web-session");
    if (generation !== sessionLoadGeneration || !authenticatedRoute.value) return;
    if (previous !== null && !sameSessionBoundary(previous, result)) {
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
      clearSession(false);
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
  try {
    await apiRequest("/api/v1/web-session", { method: "DELETE" });
  } catch (caught) {
    if (!(caught instanceof ApiProblem && caught.status === 401)) {
      setSessionError(caught);
      return;
    }
  }
  clearSession(false);
  navigate("/");
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
  window.addEventListener("cfkanban:session-invalid", sessionInvalid);
  window.addEventListener("cfkanban:authorization-stale", authorizationStale);
  window.addEventListener("cfkanban:session-exchanged", authorizationStale);
  window.addEventListener("focus", revalidateVisibleSession);
  window.addEventListener("pageshow", revalidateVisibleSession);
  document.addEventListener("visibilitychange", revalidateVisibleSession);
  void loadSession();
});
onUnmounted(() => {
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
  <PublicHomeView v-if="route.kind === 'home'" />

  <UApp v-else :locale="locale === 'zh-CN' ? zh_cn : en" :toaster="null">
  <div class="application-shell" :class="{ 'application-shell--board': route.kind === 'project' && session }">
    <AppHeader
      v-if="session"
      :context="context?.label"
      :role="context?.role"
      :session="session"
      :project-id="route.kind === 'project' || route.kind === 'labels' || route.kind === 'activity' || route.kind === 'deleted' ? route.projectId : context?.projectId"
      :workspace-id="route.kind === 'project' || route.kind === 'labels' || route.kind === 'activity' || route.kind === 'deleted' ? route.workspaceId : context?.workspaceId"
      @verified="acceptVerifiedSession"
      @logout="logout"
    />

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
        :key="`${sessionViewGeneration}:${currentPath}`"
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
      <AppFooter :expires-at="session.expires_at" :preferred-origin="preferredOrigin" />
    </template>
  </div>
  </UApp>
</template>
