<script setup lang="ts">
import { onMounted, ref } from "vue";

import PageState from "../components/PageState.vue";
import { apiRequest, errorText } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { registrationCredential, registrationOptions } from "../lib/webauthn";
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
const error = ref("");
const canUsePasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [principal, credentials] = await Promise.all([
      apiRequest<PrincipalResource>("/api/v1/me"),
      apiRequest<PasskeyList>("/api/v1/me/passkeys"),
    ]);
    me.value = principal;
    displayName.value = principal.display_name;
    passkeys.value = credentials.items;
    emit("context", { label: t("profile.title"), role: props.session.principal.is_owner ? "owner" : "member" });
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
  }
}

async function saveProfile(): Promise<void> {
  if (me.value === null || !displayName.value.trim()) return;
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<PrincipalResource>>("/api/v1/me", {
      body: { display_name: displayName.value.trim(), expected_version: me.value.version },
      method: "PATCH",
    });
    me.value = result.resource;
    displayName.value = result.resource.display_name;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function registerPasskey(): Promise<void> {
  busy.value = true;
  error.value = "";
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
    error.value = caught instanceof DOMException ? t("passkey.failed") : errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function revokePasskey(passkey: Passkey): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/me/passkeys/${passkey.id}?expected_version=${passkey.version}`, { method: "DELETE" });
    await load();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
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
      <p class="eyebrow">{{ locale === "zh-CN" ? "Principal 身份" : "Principal" }}</p>
      <h1>{{ t("profile.title") }}</h1>
    </header>
    <PageState :loading="loading" :error="error && !me ? error : ''" :action-label="t('action.refresh')" @retry="load" />
    <p v-if="error && me" class="inline-alert" role="alert">{{ error }}</p>
    <template v-if="me">
      <section class="profile-section">
        <div class="section-heading-row"><div><h2>{{ locale === "zh-CN" ? "身份资料" : "Identity profile" }}</h2><p>{{ locale === "zh-CN" ? "显示名称不用于认证或去重。" : "Your display name is not used for authentication or deduplication." }}</p></div></div>
        <form class="profile-form" @submit.prevent="saveProfile">
          <label>{{ locale === "zh-CN" ? "显示名称" : "Display name" }}<input v-model="displayName" maxlength="128" required /></label>
          <button class="primary-button" type="submit" :disabled="busy || displayName.trim() === me.display_name">{{ t("action.save") }}</button>
        </form>
        <dl class="profile-facts"><div><dt>{{ t("profile.id") }}</dt><dd><code>{{ me.id }}</code></dd></div><div><dt>{{ locale === "zh-CN" ? "角色" : "Role" }}</dt><dd>{{ me.is_owner ? (locale === "zh-CN" ? "部署 Owner" : "Deployment Owner") : (locale === "zh-CN" ? "Project 参与者" : "Project participant") }}</dd></div><div><dt>{{ locale === "zh-CN" ? "版本" : "Version" }}</dt><dd>{{ me.version }}</dd></div></dl>
      </section>

      <section class="profile-section">
        <div class="section-heading-row">
          <div><h2>Passkeys</h2><p>{{ t("passkey.list") }}</p></div>
          <button v-if="canUsePasskeys" class="primary-button" type="button" :disabled="busy" @click="registerPasskey">{{ locale === "zh-CN" ? "登记 Passkey" : "Register Passkey" }}</button>
        </div>
        <div class="passkey-list">
          <article v-for="passkey in passkeys" :key="passkey.id" class="passkey-row">
            <div><strong>{{ passkey.algorithm === -7 ? "ES256" : "RS256" }}</strong><code>{{ passkey.id }}</code><span>{{ passkey.rp_id }} · {{ formatTime(passkey.last_used_at) }}</span></div>
            <button v-if="passkey.revoked_at === null" class="danger-text-button" type="button" :disabled="busy" @click="revokePasskey(passkey)">{{ locale === "zh-CN" ? "撤销" : "Revoke" }}</button>
            <span v-else class="muted-copy">{{ locale === "zh-CN" ? "已撤销" : "revoked" }}</span>
          </article>
          <p v-if="passkeys.length === 0" class="empty-copy">{{ locale === "zh-CN" ? "尚未登记 Passkey。" : "No Passkeys are registered." }}</p>
        </div>
      </section>
    </template>
  </main>
</template>
