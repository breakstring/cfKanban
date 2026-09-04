<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import cfKanbanMarkUrl from "../assets/cfkanban-mark.png";
import LocaleSwitch from "../components/LocaleSwitch.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor, cursorRequiresRestart } from "../lib/pagination";
import { deployAgentInstruction, publicGuideUrl, publicJoinInstruction } from "../lib/public-guide";
import { navigate } from "../lib/router";
import { safeWebEntryPath } from "../lib/session-capabilities";
import { WriteFence } from "../lib/write-fence";
import {
  authenticationCredential,
  authenticationOptions,
} from "../lib/webauthn";
import type { InstanceDiscovery, ListResult, PublicProject, WebSessionView, WriteResult } from "../types";

interface CeremonyEnvelope {
  challenge_id: string;
  public_key: Record<string, unknown>;
}

const projects = ref<PublicProject[]>([]);
const projectsNextCursor = ref<string | null>(null);
const projectsLoadingMore = ref(false);
const meta = ref<InstanceDiscovery | null>(null);
const { clearError, error, setError, setErrorKey, setLocalizedError } = useLocalizedError();
const loading = ref(true);
const passkeyBusy = ref(false);
const joinBusy = ref(false);
const copied = ref("");
const copyFallback = ref<{ key: string; value: string } | null>(null);
const canUsePasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;
const writeFence = new WriteFence();

const preferredOrigin = computed(() => {
  if (meta.value === null || meta.value.preferred_api_origin === window.location.origin) return null;
  return meta.value.preferred_api_origin;
});
const guideOrigin = computed(() => meta.value?.preferred_api_origin ?? window.location.origin);
const deployGuideUrl = computed(() => publicGuideUrl(guideOrigin.value, "deploy-guide", locale.value));
const joinGuideUrl = computed(() => publicGuideUrl(guideOrigin.value, "join", locale.value));
const deployInstruction = computed(() => deployAgentInstruction(guideOrigin.value, locale.value));

async function load(reset = true): Promise<void> {
  if (!reset && projectsNextCursor.value === null) return;
  if (reset) loading.value = true;
  else projectsLoadingMore.value = true;
  clearError();
  try {
    const params = new URLSearchParams({ limit: "20" });
    if (!reset && projectsNextCursor.value !== null) params.set("cursor", projectsNextCursor.value);
    const [metaResult, publicResult] = await Promise.all([
      apiRequest<InstanceDiscovery>("/.well-known/cfkanban-instance.json"),
      apiRequest<ListResult<PublicProject>>(`/api/v1/public-projects?${params}`),
    ]);
    meta.value = metaResult;
    const merged = reset ? publicResult.items : [...projects.value, ...publicResult.items];
    projects.value = [...new Map(merged.map((project) => [project.public_id, project])).values()];
    projectsNextCursor.value = continuationCursor(publicResult);
  } catch (caught) {
    if (!reset && cursorRequiresRestart(caught)) {
      projectsNextCursor.value = null;
      setLocalizedError(
        "The public Project scope changed, so the old cursor was retired. Refresh before continuing.",
        "公开项目范围已变化，原分页位置已失效。请刷新后继续。",
      );
    } else {
      setError(caught);
    }
  } finally {
    if (reset) loading.value = false;
    projectsLoadingMore.value = false;
  }
}

async function copyText(value: string, key: string): Promise<void> {
  try {
    await window.navigator.clipboard.writeText(value);
    copyFallback.value = null;
    copied.value = key;
    window.setTimeout(() => {
      if (copied.value === key) copied.value = "";
    }, 1800);
  } catch {
    copied.value = "";
    copyFallback.value = { key, value };
  }
}

function joinInstruction(project: PublicProject, role: "reader" | "writer"): string {
  return publicJoinInstruction(guideOrigin.value, project.public_id, role, locale.value);
}

async function chooseRole(project: PublicProject, role: "reader" | "writer"): Promise<void> {
  const fenceKey = "public-join-redeem";
  if (!writeFence.enter(fenceKey)) return;
  joinBusy.value = true;
  try {
    const session = await apiRequest<WebSessionView>("/api/v1/web-session");
    const result = await apiRequest<WriteResult<{
      project: { key: string; workspace_key: string };
    }>>(`/api/v1/public-joins/${project.public_id}/redeem`, {
      body: { redeem_as: "current_principal", role },
      method: "POST",
    });
    const target = result.resource.project;
    navigate(`/app/w/${encodeURIComponent(target.workspace_key)}/p/${encodeURIComponent(target.key)}`);
    void session;
  } catch (caught) {
    if (caught instanceof ApiProblem && caught.status === 401) {
      await copyText(joinInstruction(project, role), `${project.public_id}:${role}`);
      return;
    }
    setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    joinBusy.value = false;
  }
}

async function signInWithPasskey(): Promise<void> {
  const fenceKey = "passkey-sign-in";
  if (!writeFence.enter(fenceKey)) return;
  passkeyBusy.value = true;
  clearError();
  try {
    const options = await apiRequest<CeremonyEnvelope>("/api/v1/web-authentication/options", {
      body: {},
      method: "POST",
    });
    const credential = await navigator.credentials.get({ publicKey: authenticationOptions(options) });
    const result = await apiRequest<WriteResult<{ entry_path: string }>>("/api/v1/web-authentication/verify", {
      body: {
        challenge_id: options.challenge_id,
        credential: authenticationCredential(credential),
      },
      method: "POST",
    });
    const entryPath = safeWebEntryPath(result.resource.entry_path);
    if (entryPath === null) throw new Error("invalid_session_entry_path");
    window.dispatchEvent(new CustomEvent("cfkanban:session-exchanged"));
    navigate(entryPath);
  } catch (caught) {
    if (caught instanceof DOMException || (caught instanceof ApiProblem && caught.status === 401)) {
      setErrorKey("passkey.failed");
    } else {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    passkeyBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="public-home">
    <header class="public-nav">
      <a class="wordmark" href="/" @click.prevent="navigate('/')">
        <img class="brand-logo" :src="cfKanbanMarkUrl" alt="" aria-hidden="true" />
        <span>cfKanban</span>
      </a>
      <LocaleSwitch />
    </header>

    <section class="hero-section">
      <div class="hero-copy">
        <p class="eyebrow">{{ t("home.eyebrow") }}</p>
        <h1><span>{{ t("home.headingFirst") }}</span><span>{{ t("home.headingSecond") }}</span></h1>
        <p class="hero-description">{{ t("home.description") }}</p>
        <p class="instance-note">{{ t("home.independent") }}</p>
        <a v-if="preferredOrigin" class="preferred-origin" :href="preferredOrigin">
          {{ locale === "zh-CN" ? "推荐访问地址" : "Preferred address" }} · {{ preferredOrigin }}
        </a>
      </div>
      <aside class="agent-note">
        <p class="note-kicker">{{ t("home.agentGuideTitle") }}</p>
        <p class="agent-guide-description">{{ t("home.agentGuideDescription") }}</p>
        <p class="agent-prompt">{{ deployInstruction }}</p>
        <div class="agent-actions">
          <button class="primary-button" type="button" @click="copyText(deployInstruction, 'deploy')">
            {{ copied === "deploy" ? (locale === "zh-CN" ? "已复制" : "Copied") : t("home.copyDeploy") }}
          </button>
          <a class="guide-link" :href="deployGuideUrl">{{ t("home.deployGuide") }} ↗</a>
        </div>
      </aside>
    </section>

    <PageState :loading="loading" :error="error" :action-label="t('action.refresh')" @retry="load(true)" />

    <section v-if="copyFallback" class="copy-fallback" role="status">
      <label>
        {{ t("copy.manual") }}
        <textarea :value="copyFallback.value" readonly rows="5" @focus="($event.target as HTMLTextAreaElement).select()" />
      </label>
    </section>

    <section v-if="!loading && !error" class="public-projects-section">
      <header class="section-heading-row">
        <div>
          <p class="eyebrow">{{ locale === "zh-CN" ? "公开加入" : "Public Join" }}</p>
          <h2>{{ t("home.projects") }}</h2>
          <p>{{ t("home.projectsDescription") }}</p>
        </div>
        <button
          v-if="canUsePasskeys"
          class="secondary-button"
          type="button"
          :disabled="passkeyBusy"
          @click="signInWithPasskey"
        >
          {{ passkeyBusy ? "…" : t("action.usePasskey") }}
        </button>
      </header>

      <div v-if="projects.length" class="public-project-list">
        <article v-for="project in projects" :key="project.public_id" class="public-project-row">
          <div>
            <h3>{{ project.display_name }}</h3>
            <p>{{ project.public_summary }}</p>
          </div>
          <div class="role-actions">
            <button class="secondary-button" type="button" :disabled="joinBusy" @click="chooseRole(project, 'reader')">
              {{ copied === `${project.public_id}:reader` ? (locale === "zh-CN" ? "话术已复制" : "Instruction copied") : t("home.reader") }}
            </button>
            <button class="primary-button" type="button" :disabled="joinBusy" @click="chooseRole(project, 'writer')">
              {{ copied === `${project.public_id}:writer` ? (locale === "zh-CN" ? "话术已复制" : "Instruction copied") : t("home.writer") }}
            </button>
          </div>
        </article>
      </div>
      <p v-else class="empty-copy">
        {{ locale === "zh-CN" ? "当前没有公开项目。" : "No projects are public right now." }}
      </p>
      <button v-if="projectsNextCursor" class="load-more" type="button" :disabled="projectsLoadingMore" @click="load(false)">{{ projectsLoadingMore ? "…" : (locale === "zh-CN" ? "加载更多公开项目" : "Load more public projects") }}</button>
    </section>

    <footer class="public-footer">
      <div class="footer-brand">
        <img class="footer-logo" :src="cfKanbanMarkUrl" alt="" aria-hidden="true" />
        <div class="footer-brand-copy">
          <strong>cfKanban</strong>
          <span>{{ t("home.footerTagline") }}</span>
        </div>
      </div>
      <nav class="footer-links" :aria-label="locale === 'zh-CN' ? '页脚导航' : 'Footer navigation'">
        <a :href="deployGuideUrl">{{ t("home.deployGuide") }}</a>
        <a :href="joinGuideUrl">{{ t("home.joinGuide") }}</a>
        <a :href="`${guideOrigin}/openapi.json`">{{ t("home.openapi") }}</a>
        <a href="https://github.com/breakstring/cfKanban" rel="noreferrer noopener">{{ t("home.github") }}</a>
      </nav>
      <div class="footer-meta">
        <span>{{ locale === "zh-CN" ? "服务版本" : "service" }} {{ meta?.service_version ?? "—" }}</span>
        <span>{{ meta?.instance_id ? `${locale === "zh-CN" ? "实例" : "instance"} ${meta.instance_id.slice(0, 8)}` : "" }}</span>
      </div>
    </footer>
  </main>
</template>
