<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import PageState from "../components/PageState.vue";
import { apiRequest } from "../lib/api";
import {
  type CasConflictState,
  captureCasConflict,
  markCasReadbackComplete,
  markCasReadbackFailed,
} from "../lib/cas-recovery";
import { locale, t } from "../lib/i18n";
import { localizedText, type LocalizedText, useLocalizedError } from "../lib/localized-error";
import { canRegisterPasskeyFromSession } from "../lib/session-capabilities";
import { registrationCredential, registrationOptions } from "../lib/webauthn";
import { WriteFence } from "../lib/write-fence";
import type { Passkey, PrincipalResource, WebSessionView, WriteResult } from "../types";

const props = defineProps<{ session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();

interface PasskeyList {
  items: Passkey[];
  truncated: boolean;
}

interface CeremonyEnvelope {
  challenge_id: string;
  public_key: Record<string, unknown>;
}

const me = ref<PrincipalResource | null>(null);
const passkeys = ref<Passkey[]>([]);
const displayName = ref("");
const loading = ref(true);
const busy = ref(false);
const { clearError, error, setError, setErrorKey } = useLocalizedError();
const casConflict = ref<CasConflictState | null>(null);
const canUsePasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;
const canRegisterPasskey = computed(() => canRegisterPasskeyFromSession(props.session, canUsePasskeys));
const writeFence = new WriteFence();
let casRecoveryGeneration = 0;
let casReadback: (() => Promise<void>) | null = null;
let casReadbackInFlight = false;

async function load(preserveDisplayName = false, throwOnFailure = false): Promise<void> {
  loading.value = true;
  clearError();
  try {
    const [principal, credentials] = await Promise.all([
      apiRequest<PrincipalResource>("/api/v1/me"),
      apiRequest<PasskeyList>("/api/v1/me/passkeys"),
    ]);
    me.value = principal;
    if (!preserveDisplayName) displayName.value = principal.display_name;
    passkeys.value = credentials.items;
    emit("context", { label: t("profile.title"), role: props.session.principal.is_owner ? "owner" : "member" });
  } catch (caught) {
    setError(caught);
    if (throwOnFailure) throw caught;
  } finally {
    loading.value = false;
  }
}

async function recoverCasConflict(caught: unknown, resource: string | LocalizedText, draft: unknown): Promise<boolean> {
  const conflict = captureCasConflict(caught, resource, draft);
  if (conflict === null) return false;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  casReadback = () => load(true, true);
  casConflict.value = conflict;
  setErrorKey("error.conflict");
  try {
    await load(true, true);
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(conflict);
  } catch {
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(conflict);
  }
  return true;
}

function dismissCasConflict(): void {
  casRecoveryGeneration += 1;
  casConflict.value = null;
  casReadback = null;
}

async function refreshCasFacts(): Promise<void> {
  const conflict = casConflict.value;
  const readback = casReadback;
  if (conflict === null || readback === null || casReadbackInFlight) return;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  const pending = { ...conflict, readbackState: "pending" as const };
  casConflict.value = pending;
  casReadbackInFlight = true;
  try {
    await readback();
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(pending);
  } catch {
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(pending);
  } finally {
    casReadbackInFlight = false;
  }
}

async function saveProfile(): Promise<void> {
  if (me.value === null || !displayName.value.trim()) return;
  const fenceKey = "profile-update";
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<PrincipalResource>>("/api/v1/me", {
      body: { display_name: displayName.value.trim(), expected_version: me.value.version },
      method: "PATCH",
    });
    me.value = result.resource;
    displayName.value = result.resource.display_name;
    dismissCasConflict();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText("Principal profile", "身份资料"), { display_name: displayName.value })) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function registerPasskey(): Promise<void> {
  const fenceKey = "passkey-register";
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  clearError();
  try {
    const options = await apiRequest<CeremonyEnvelope>("/api/v1/me/passkeys/registration-options", {
      body: {}, method: "POST",
    });
    const credential = await navigator.credentials.create({ publicKey: registrationOptions(options) });
    await apiRequest("/api/v1/me/passkeys", {
      body: {
        challenge_id: options.challenge_id,
        credential: registrationCredential(credential),
      },
      method: "POST",
    });
    await load();
  } catch (caught) {
    if (caught instanceof DOMException) setErrorKey("passkey.failed");
    else setError(caught);
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

async function revokePasskey(passkey: Passkey): Promise<void> {
  const fenceKey = `passkey-revoke:${passkey.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/me/passkeys/${passkey.id}?expected_version=${passkey.version}`, { method: "DELETE" });
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Passkey ${passkey.id}`, `通行密钥 ${passkey.id}`), { action: "revoke" })) {
      setError(caught);
    }
  } finally {
    writeFence.leave(fenceKey);
    busy.value = false;
  }
}

function formatTime(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

onMounted(load);
</script>

<template>
  <main class="page-shell profile-page">
    <header class="page-title-block">
      <p class="eyebrow">{{ locale === "zh-CN" ? "身份" : "Principal" }}</p>
      <h1>{{ t("profile.title") }}</h1>
    </header>
    <PageState :loading="loading" :error="error && !me ? error : ''" :action-label="t('action.refresh')" @retry="load" />
    <ErrorNotice v-if="error && me" :error="error" />
    <CasConflictNotice v-if="casConflict" :busy="busy || casReadbackInFlight" :conflict="casConflict" @dismiss="dismissCasConflict" @refresh="refreshCasFacts" />
    <template v-if="me">
      <section class="profile-section">
        <div class="section-heading-row"><div><h2>{{ locale === "zh-CN" ? "身份资料" : "Identity profile" }}</h2><p>{{ locale === "zh-CN" ? "显示名称不用于认证或去重。" : "Your display name is not used for authentication or deduplication." }}</p></div></div>
        <form class="profile-form" @submit.prevent="saveProfile">
          <label>{{ locale === "zh-CN" ? "显示名称" : "Display name" }}<input v-model="displayName" maxlength="128" required /></label>
          <button class="primary-button" type="submit" :disabled="busy || displayName.trim() === me.display_name">{{ t("action.save") }}</button>
        </form>
        <dl class="profile-facts"><div><dt>{{ t("profile.id") }}</dt><dd><code>{{ me.id }}</code></dd></div><div><dt>{{ locale === "zh-CN" ? "角色" : "Role" }}</dt><dd>{{ me.is_owner ? (locale === "zh-CN" ? "部署所有者" : "Deployment Owner") : (locale === "zh-CN" ? "项目参与者" : "Project participant") }}</dd></div><div><dt>{{ locale === "zh-CN" ? "版本" : "Version" }}</dt><dd>{{ me.version }}</dd></div></dl>
      </section>

      <section class="profile-section">
        <div class="section-heading-row">
          <div><h2>{{ locale === "zh-CN" ? "通行密钥" : "Passkeys" }}</h2><p>{{ t("passkey.list") }}</p></div>
          <button v-if="canRegisterPasskey" class="primary-button" type="button" :disabled="busy" @click="registerPasskey">{{ locale === "zh-CN" ? "登记通行密钥" : "Register Passkey" }}</button>
        </div>
        <div class="passkey-list">
          <article v-for="passkey in passkeys" :key="passkey.id" class="passkey-row">
            <div><strong>{{ passkey.algorithm === -7 ? "ES256" : "RS256" }}</strong><code>{{ passkey.id }}</code><span>{{ passkey.rp_id }} · {{ formatTime(passkey.last_used_at) }}</span></div>
            <button v-if="passkey.revoked_at === null" class="danger-text-button" type="button" :disabled="busy" @click="revokePasskey(passkey)">{{ locale === "zh-CN" ? "撤销" : "Revoke" }}</button>
            <span v-else class="muted-copy">{{ locale === "zh-CN" ? "已撤销" : "revoked" }}</span>
          </article>
          <p v-if="passkeys.length === 0" class="empty-copy">{{ locale === "zh-CN" ? "尚未登记通行密钥。" : "No Passkeys are registered." }}</p>
        </div>
      </section>
    </template>
  </main>
</template>
