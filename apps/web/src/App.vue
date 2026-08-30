<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import AppHeader from "./components/AppHeader.vue";
import LocaleSwitch from "./components/LocaleSwitch.vue";
import PageState from "./components/PageState.vue";
import { ApiProblem, apiRequest, errorText } from "./lib/api";
import { locale, t } from "./lib/i18n";
import { currentPath, navigate, routePath } from "./lib/router";
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
const sessionError = ref("");
const sessionEnded = ref(false);
const context = ref<{ label: string; role: string } | null>(null);
let sessionExpiryTimer: number | null = null;
let sessionLoadGeneration = 0;

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
  if (sessionExpiryTimer !== null) window.clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = null;
  sessionLoadGeneration += 1;
  session.value = null;
  context.value = null;
  sessionError.value = "";
  sessionEnded.value = ended;
}

function scheduleSessionExpiry(expiresAt: string): boolean {
  if (sessionExpiryTimer !== null) window.clearTimeout(sessionExpiryTimer);
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    clearSession(true);
    return false;
  }
  sessionExpiryTimer = window.setTimeout(() => clearSession(true), Math.min(remaining, 2_147_483_647));
  return true;
}

async function loadSession(): Promise<void> {
  if (!authenticatedRoute.value || loadingSession.value) return;
  const generation = sessionLoadGeneration + 1;
  clearSession(false);
  sessionLoadGeneration = generation;
  loadingSession.value = true;
  sessionError.value = "";
  sessionEnded.value = false;
  try {
    const result = await apiRequest<WebSessionView>("/api/v1/web-session");
    if (generation !== sessionLoadGeneration || !authenticatedRoute.value) return;
    if (scheduleSessionExpiry(result.expires_at)) session.value = result;
  } catch (caught) {
    if (generation !== sessionLoadGeneration) return;
    session.value = null;
    if (caught instanceof ApiProblem && caught.status === 401) sessionEnded.value = true;
    else sessionError.value = errorText(caught);
  } finally {
    loadingSession.value = false;
  }
}

async function logout(): Promise<void> {
  try {
    await apiRequest("/api/v1/web-session", { method: "DELETE" });
  } catch (caught) {
    if (!(caught instanceof ApiProblem && caught.status === 401)) {
      sessionError.value = errorText(caught);
      return;
    }
  }
  clearSession(false);
  navigate("/");
}

function sessionInvalid(): void {
  if (authenticatedRoute.value) clearSession(true);
}

function authorizationStale(): void {
  if (!authenticatedRoute.value) return;
  clearSession(false);
  void loadSession();
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

    <div v-if="loadingSession" class="session-gate">
      <PageState loading />
    </div>

    <main v-else-if="!session" class="session-gate">
      <div class="session-message">
        <p class="eyebrow">Web Session</p>
        <h1>{{ sessionEnded ? t("error.session") : (locale === "zh-CN" ? "无法验证 Session" : "Session could not be verified") }}</h1>
        <p v-if="sessionError" class="inline-alert" role="alert">{{ sessionError }}</p>
        <p>{{ locale === "zh-CN" ? "请返回实例首页使用 Passkey，或让 Agent 创建新的 Browser Launch。" : "Return home to use a Passkey, or ask your Agent for a new Browser Launch." }}</p>
        <div class="form-actions">
          <button class="secondary-button" type="button" @click="loadSession">{{ t("action.refresh") }}</button>
          <button class="primary-button" type="button" @click="navigate('/')">{{ locale === "zh-CN" ? "返回实例首页" : "Return home" }}</button>
        </div>
        <LocaleSwitch />
      </div>
    </main>

    <template v-else>
      <ProjectSelectionView v-if="route.kind === 'selection'" :key="currentPath" :session="session" />
      <ProjectBoardView
        v-else-if="route.kind === 'project'"
        :key="currentPath"
        :project-key="route.projectKey"
        :session="session"
        :workspace-key="route.workspaceKey"
        @context="context = $event"
      />
      <IssueDetailView
        v-else-if="route.kind === 'issue'"
        :key="currentPath"
        :identifier="route.identifier"
        :session="session"
        @context="context = $event"
      />
      <ProfileView
        v-else-if="route.kind === 'profile'"
        :key="currentPath"
        :session="session"
        @context="context = $event"
      />
      <OwnerView
        v-else-if="route.kind === 'owner' && session.principal.is_owner"
        :key="currentPath"
        :section="route.section"
        :session="session"
        @context="context = $event"
      />
      <main v-else class="session-gate">
        <div class="session-message">
          <p class="eyebrow">404</p>
          <h1>{{ locale === "zh-CN" ? "页面不可用" : "Page unavailable" }}</h1>
          <p>{{ locale === "zh-CN" ? "此路径不在当前 Session 的可用 Web 范围内。" : "This path is not available in the current Web Session." }}</p>
          <button class="primary-button" type="button" @click="navigate('/app')">{{ t("project.choose") }}</button>
        </div>
      </main>
    </template>
  </div>
</template>
