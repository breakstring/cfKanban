<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import AppHeader from "./components/AppHeader.vue";
import ErrorNotice from "./components/ErrorNotice.vue";
import LocaleSwitch from "./components/LocaleSwitch.vue";
import PageState from "./components/PageState.vue";
import { ApiProblem, apiRequest } from "./lib/api";
import { locale, t } from "./lib/i18n";
import { useLocalizedError } from "./lib/localized-error";
import { currentPath, navigate, routePath } from "./lib/router";
import { scheduleSessionExpiry } from "./lib/session-expiry";
import { canAccessOwnerControlPlane } from "./lib/session-capabilities";
import { sameSessionBoundary, shouldClearAfterSessionRevalidation } from "./lib/session-boundary";
import type { WebSessionView } from "./types";
import IssueDetailView from "./views/IssueDetailView.vue";
import OwnerView from "./views/OwnerView.vue";
import ProfileView from "./views/ProfileView.vue";
import ProjectBoardView from "./views/ProjectBoardView.vue";
import ProjectSelectionView from "./views/ProjectSelectionView.vue";
import PublicHomeView from "./views/PublicHomeView.vue";

type OwnerSection = "overview" | "workspaces" | "access" | "audit";
type AppRoute =
  | { kind: "home" }
  | { kind: "selection" }
  | { identifier: string; kind: "issue" }
  | { kind: "owner"; section: OwnerSection }
  | { kind: "profile" }
  | { kind: "project"; projectKey: string; workspaceKey: string }
  | { kind: "unknown" };

const session = ref<WebSessionView | null>(null);
const loadingSession = ref(false);
const {
  clearError: clearSessionError,
  error: sessionError,
  setError: setSessionError,
} = useLocalizedError();
const sessionEnded = ref(false);
const context = ref<{ label: string; role: string } | null>(null);
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
  if (path === "/app/profile") return { kind: "profile" };
  if (path === "/app/admin") {
    const raw = new URLSearchParams(currentPath.value.split("?", 2)[1] ?? "").get("section");
    const section: OwnerSection = raw === "workspaces" || raw === "access" || raw === "audit"
      ? raw
      : "overview";
    return { kind: "owner", section };
  }
  const project = /^\/app\/w\/([^/]+)\/p\/([^/]+)$/.exec(path);
  if (project !== null) {
    const workspaceKey = decoded(project[1] ?? "");
    const projectKey = decoded(project[2] ?? "");
    if (workspaceKey !== null && projectKey !== null) return { kind: "project", projectKey, workspaceKey };
  }
  const issue = /^\/app\/issues\/(CFK-[1-9][0-9]*)$/.exec(path);
  if (issue !== null) return { identifier: issue[1] ?? "", kind: "issue" };
  return { kind: "unknown" };
});

const authenticatedRoute = computed(() => route.value.kind !== "home");

function clearSession(ended = true): void {
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
      sessionViewGeneration.value += 1;
      context.value = null;
    }
    if (armSessionExpiry(result.expires_at)) session.value = result;
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
});
</script>

<template>
  <PublicHomeView v-if="route.kind === 'home'" />

  <div v-else class="application-shell">
    <AppHeader
      v-if="session"
      :context="context?.label"
      :role="context?.role"
      :session="session"
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
      <ProjectBoardView
        v-else-if="route.kind === 'project'"
        :key="`${sessionViewGeneration}:${currentPath}`"
        :project-key="route.projectKey"
        :session="session"
        :workspace-key="route.workspaceKey"
        @context="context = $event"
      />
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
    </template>
  </div>
</template>
