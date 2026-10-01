<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onMounted, ref, watch } from "vue";

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
import { principalDisplayNameProblemText } from "../lib/error-presentation";
import { locale, t } from "../lib/i18n";
import { localizedText, type LocalizedText, useLocalizedError } from "../lib/localized-error";
import { normalizePrincipalDisplayName, principalDisplayNameProblem } from "../lib/principal-display-name";
import { canRegisterPasskeyFromSession } from "../lib/session-capabilities";
import { navigate } from "../lib/router";
import { registrationCredential, registrationOptions } from "../lib/webauthn";
import { WriteFence } from "../lib/write-fence";
import { normalizeTheme, type Theme } from "../lib/theme";
import type { Passkey, PrincipalResource, WebSessionView, WriteResult } from "../types";

const props = defineProps<{ session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }]; updated: [value: PrincipalResource] }>();

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
const selectedTheme = ref<Theme>("orange");
const themeSaved = ref(false);
const nameProblem = computed(() => principalDisplayNameProblem(displayName.value));
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

function acceptPrincipal(principal: PrincipalResource): PrincipalResource {
  const current = me.value?.id === principal.id ? me.value : null;
  const latest = current && current.version > principal.version ? current : { ...current, ...principal };
  const sessionPrincipal = props.session.principal;
  // 首次 /me 尚未返回时，Session 也可能已读到更新的资料。
  me.value = sessionPrincipal.id === latest.id && sessionPrincipal.version > latest.version
    ? { ...latest, ...sessionPrincipal }
    : latest;
  return me.value;
}

watch(() => props.session.principal, (principal) => {
  const current = me.value;
  if (!current || current.id !== principal.id || principal.version < current.version) return;
  if (normalizeTheme(principal.theme) !== normalizeTheme(current.theme)) themeSaved.value = false;
  if (selectedTheme.value === normalizeTheme(current.theme)) selectedTheme.value = normalizeTheme(principal.theme);
  if (normalizePrincipalDisplayName(displayName.value) === current.display_name) displayName.value = principal.display_name;
  me.value = { ...current, ...principal };
});

async function load(preserveDisplayName = false, throwOnFailure = false): Promise<void> {
  loading.value = true;
  clearError();
  try {
    const [principal, credentials] = await Promise.all([
      apiRequest<PrincipalResource>("/api/v1/me"),
      apiRequest<PasskeyList>("/api/v1/me/passkeys"),
    ]);
    const current = acceptPrincipal(principal);
    emit("updated", current);
    if (!preserveDisplayName) {
      displayName.value = current.display_name;
      selectedTheme.value = normalizeTheme(current.theme);
    }
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
  if (me.value === null || nameProblem.value !== null) return;
  const fenceKey = "profile-update";
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  clearError();
  try {
    const result = await apiRequest<WriteResult<PrincipalResource>>("/api/v1/me", {
      body: { display_name: normalizePrincipalDisplayName(displayName.value), expected_version: me.value.version },
      method: "PATCH",
    });
    acceptPrincipal(result.resource);
    displayName.value = me.value.display_name;
    emit("updated", me.value);
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

async function saveTheme(): Promise<void> {
  if (me.value === null || busy.value || selectedTheme.value === normalizeTheme(me.value.theme)) return;
  if (!writeFence.enter("profile-update")) return;
  busy.value = true;
  themeSaved.value = false;
  clearError();
  try {
    const result = await apiRequest<WriteResult<PrincipalResource>>("/api/v1/me", {
      body: { theme: selectedTheme.value, expected_version: me.value.version },
      method: "PATCH",
    });
    acceptPrincipal(result.resource);
    selectedTheme.value = normalizeTheme(me.value.theme);
    emit("updated", me.value);
    themeSaved.value = true;
    dismissCasConflict();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText("Theme preference", "主题偏好"), { theme: selectedTheme.value })) setError(caught);
  } finally {
    writeFence.leave("profile-update");
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
        <div class="section-heading-row"><div><h2>{{ locale === "zh-CN" ? "通知" : "Notifications" }}</h2><p>{{ locale === "zh-CN" ? "查看实例公告，选择是否接收提醒，并逐条确认已读正文。" : "Read instance announcements, choose whether to receive reminders, and confirm each announcement after opening it." }}</p></div><UButton color="neutral" variant="outline" @click="navigate('/app/notifications')">{{ locale === "zh-CN" ? "打开通知" : "Open notifications" }}</UButton></div>
      </section>
      <section class="profile-section" aria-labelledby="theme-heading">
        <h2 id="theme-heading">{{ locale === "zh-CN" ? "外观主题" : "Appearance" }}</h2>
        <p class="muted-copy">{{ locale === "zh-CN" ? "选择适合你的配色。保存后应用到所有已登录页面，并随账号保留；布局与操作保持一致。" : "Choose your colors. Save to apply them across signed-in pages and devices. Layout and controls stay the same." }}</p>
        <form @submit.prevent="saveTheme">
          <fieldset class="theme-options" :disabled="busy" aria-labelledby="theme-heading">
            <label v-for="theme in (['orange', 'blue'] as const)" :key="theme" class="theme-option">
              <input v-model="selectedTheme" type="radio" name="theme" :value="theme" @change="themeSaved = false" />
              <span class="theme-swatch" :class="`theme-swatch--${theme}`" aria-hidden="true" />
              <span class="theme-option-copy"><strong>{{ theme === "orange" ? (locale === "zh-CN" ? "暖橙" : "Warm orange") : (locale === "zh-CN" ? "静蓝" : "Calm blue") }}</strong><small>{{ theme === "orange" ? (locale === "zh-CN" ? "温暖、清晰" : "Warm and clear") : (locale === "zh-CN" ? "冷静、专注" : "Calm and focused") }}</small></span>
            </label>
          </fieldset>
          <div class="form-actions">
            <UButton type="submit" :loading="busy" :disabled="busy || selectedTheme === normalizeTheme(me.theme)">{{ locale === "zh-CN" ? "保存主题" : "Save theme" }}</UButton>
            <span role="status" class="muted-copy">{{ themeSaved ? (locale === "zh-CN" ? "主题偏好已保存" : "Theme preference saved") : "" }}</span>
          </div>
        </form>
      </section>
      <section class="profile-section">
        <div class="section-heading-row"><div><h2>{{ locale === "zh-CN" ? "身份资料" : "Identity profile" }}</h2><p>{{ locale === "zh-CN" ? "显示名称在此实例内唯一，英文大小写及全角等兼容形式视为相同名称。身份和权限仍绑定固定 ID。" : "Display names are unique within this instance, ignoring case and equivalent forms such as full-width letters. Identity and permissions remain linked to your fixed ID." }}</p></div></div>
        <form class="profile-form" @submit.prevent="saveProfile">
          <label>{{ locale === "zh-CN" ? "显示名称" : "Display name" }}<UInput class="w-full" v-model="displayName" required aria-describedby="profile-name-rules profile-name-error" :aria-invalid="nameProblem !== null" /></label>
          <UButton color="primary" variant="solid" class="primary-button" type="submit" :disabled="busy || nameProblem !== null || normalizePrincipalDisplayName(displayName) === me.display_name">{{ t("action.save") }}</UButton>
        </form>
        <p id="profile-name-rules" class="muted-copy">{{ locale === "zh-CN" ? "1–128 个字符；允许文字、数字、组合标记及 _ - ·；禁止空格、不可见字符、Emoji 和其他符号。首尾空白自动去除，兼容字符统一规范化。admin、administrator、owner、system、管理员、所有者、系统为保留名称。" : "1–128 characters: letters, numbers, combining marks, and _ - ·. No spaces, invisible characters, emoji, or other symbols. Surrounding whitespace is trimmed and compatible characters are normalized. Reserved names: admin, administrator, owner, system, 管理员, 所有者, 系统." }}</p>
        <p id="profile-name-error" role="status" class="muted-copy">{{ nameProblem === null ? "" : principalDisplayNameProblemText(nameProblem, locale) }}</p>
        <dl class="profile-facts"><div><dt>{{ t("profile.id") }}</dt><dd><code>{{ me.id }}</code></dd></div><div><dt>{{ locale === "zh-CN" ? "角色" : "Role" }}</dt><dd>{{ me.is_owner ? (locale === "zh-CN" ? "部署所有者" : "Deployment Owner") : (locale === "zh-CN" ? "项目参与者" : "Project participant") }}</dd></div><div><dt>{{ locale === "zh-CN" ? "版本" : "Version" }}</dt><dd>{{ me.version }}</dd></div></dl>
      </section>

      <section class="profile-section">
        <div class="section-heading-row">
          <div><h2>{{ locale === "zh-CN" ? "通行密钥" : "Passkeys" }}</h2><p>{{ t("passkey.list") }}</p></div>
          <UButton color="primary" variant="solid" v-if="canRegisterPasskey" class="primary-button" type="button" :disabled="busy" @click="registerPasskey">{{ locale === "zh-CN" ? "登记通行密钥" : "Register Passkey" }}</UButton>
        </div>
        <div class="passkey-list">
          <article v-for="passkey in passkeys" :key="passkey.id" class="passkey-row">
            <div><strong>{{ passkey.algorithm === -7 ? "ES256" : "RS256" }}</strong><code>{{ passkey.id }}</code><span>{{ passkey.rp_id }} · {{ formatTime(passkey.last_used_at) }}</span></div>
            <UButton color="error" variant="ghost" v-if="passkey.revoked_at === null" class="danger-text-button" type="button" :disabled="busy" @click="revokePasskey(passkey)">{{ locale === "zh-CN" ? "撤销" : "Revoke" }}</UButton>
            <span v-else class="muted-copy">{{ locale === "zh-CN" ? "已撤销" : "revoked" }}</span>
          </article>
          <p v-if="passkeys.length === 0" class="empty-copy">{{ locale === "zh-CN" ? "尚未登记通行密钥。" : "No Passkeys are registered." }}</p>
        </div>
      </section>
    </template>
  </main>
</template>
