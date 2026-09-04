<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import LocaleSwitch from "../components/LocaleSwitch.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest, errorText } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { publicJoinInstruction } from "../lib/public-join-instruction";
import { navigate } from "../lib/router";
import { safeWebEntryPath } from "../lib/session-capabilities";
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
const meta = ref<InstanceDiscovery | null>(null);
const error = ref("");
const loading = ref(true);
const passkeyBusy = ref(false);
const copied = ref("");
const copyFallback = ref<{ key: string; value: string } | null>(null);
const canUsePasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;

const preferredOrigin = computed(() => {
  if (meta.value === null || meta.value.preferred_api_origin === window.location.origin) return null;
  return meta.value.preferred_api_origin;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [metaResult, publicResult] = await Promise.all([
      apiRequest<InstanceDiscovery>("/.well-known/cfkanban-instance.json"),
      apiRequest<ListResult<PublicProject>>("/api/v1/public-projects?limit=20"),
    ]);
    meta.value = metaResult;
    projects.value = publicResult.items;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
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
  return publicJoinInstruction(window.location.origin, project.public_id, role, locale.value);
}

async function chooseRole(project: PublicProject, role: "reader" | "writer"): Promise<void> {
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
    error.value = errorText(caught);
  }
}

async function signInWithPasskey(): Promise<void> {
  passkeyBusy.value = true;
  error.value = "";
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
    error.value = caught instanceof DOMException || (caught instanceof ApiProblem && caught.status === 401)
      ? t("passkey.failed")
      : errorText(caught);
  } finally {
    passkeyBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="public-home">
    <header class="public-nav">
      <a class="wordmark" href="/" @click.prevent="navigate('/')">cfKanban</a>
      <LocaleSwitch />
    </header>

    <section class="hero-section">
      <div class="hero-copy">
        <p class="eyebrow">Agent-first Kanban · Cloudflare</p>
        <h1>{{ t("home.heading") }}</h1>
        <p class="hero-description">{{ t("home.description") }}</p>
        <p class="instance-note">{{ t("home.independent") }}</p>
        <a v-if="preferredOrigin" class="preferred-origin" :href="preferredOrigin">
          {{ locale === "zh-CN" ? "推荐访问地址" : "Preferred address" }} · {{ preferredOrigin }}
        </a>
      </div>
      <aside class="agent-note">
        <p class="note-kicker">{{ locale === "zh-CN" ? "交给你的 Agent" : "Give this to your Agent" }}</p>
        <p>{{ t("home.agentInstruction") }}</p>
        <button class="primary-button" type="button" @click="copyText(t('home.agentInstruction'), 'deploy')">
          {{ copied === "deploy" ? (locale === "zh-CN" ? "已复制" : "Copied") : t("action.copy") }}
        </button>
      </aside>
    </section>

    <PageState :loading="loading" :error="error" :action-label="t('action.refresh')" @retry="load" />

    <section v-if="copyFallback" class="copy-fallback" role="status">
      <label>
        {{ t("copy.manual") }}
        <textarea :value="copyFallback.value" readonly rows="5" @focus="($event.target as HTMLTextAreaElement).select()" />
      </label>
    </section>

    <section v-if="!loading && !error" class="public-projects-section">
      <header class="section-heading-row">
        <div>
          <p class="eyebrow">Public Join</p>
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
            <button class="secondary-button" type="button" @click="chooseRole(project, 'reader')">
              {{ copied === `${project.public_id}:reader` ? (locale === "zh-CN" ? "话术已复制" : "Instruction copied") : t("home.reader") }}
            </button>
            <button class="primary-button" type="button" @click="chooseRole(project, 'writer')">
              {{ copied === `${project.public_id}:writer` ? (locale === "zh-CN" ? "话术已复制" : "Instruction copied") : t("home.writer") }}
            </button>
          </div>
        </article>
      </div>
      <p v-else class="empty-copy">
        {{ locale === "zh-CN" ? "当前没有公开 Project。" : "No projects are public right now." }}
      </p>
    </section>

    <footer class="public-footer">
      <span>service {{ meta?.service_version ?? "—" }}</span>
      <span>{{ meta?.instance_id ? `instance ${meta.instance_id.slice(0, 8)}` : "" }}</span>
    </footer>
  </main>
</template>
