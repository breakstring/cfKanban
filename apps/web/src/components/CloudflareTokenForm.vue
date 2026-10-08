<script setup lang="ts">
import UInput from "@nuxt/ui/components/Input.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onUnmounted, ref } from "vue";
import { locale } from "../lib/i18n";

const props = defineProps<{
  kind: string;
  label: string;
  description: string;
  disabled: boolean;
  saved?: boolean;
  save: (kind: string, token: string) => Promise<void>;
}>();
const token = ref("");
const saving = ref(false);
let mounted = true;
const inputId = computed(() => `cloudflare-token-${props.kind}`);
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
async function save(): Promise<void> {
  if (saving.value || props.disabled || !token.value.trim()) return;
  const value = token.value.trim();
  token.value = "";
  saving.value = true;
  try { await props.save(props.kind, value); }
  catch { /* 保存结果和恢复状态由父级统一呈现。 */ }
  finally { if (mounted) saving.value = false; }
}
onUnmounted(() => { mounted = false; token.value = ""; });
</script>

<template>
  <form class="cloudflare-token-form" :aria-busy="saving" @submit.prevent="save">
    <label class="sr-only" :for="inputId">{{ label }}</label>
    <p :id="`${inputId}-description`" class="muted-copy">{{ description }}</p>
    <div class="cloudflare-token-controls">
      <UInput :id="inputId" v-model="token" type="password" autocomplete="off" autocapitalize="none" :spellcheck="false" :placeholder="saved ? ui('Enter a replacement Token', '输入新 Token 可替换') : ui('Enter your Cloudflare API Token', '输入 Cloudflare API Token')" :disabled="disabled || saving" :aria-describedby="`${inputId}-description`" class="cloudflare-token-input" />
      <UButton color="primary" variant="solid" type="submit" :disabled="disabled || saving || !token.trim()">{{ saving ? ui('Saving…', '正在保存…') : ui('Save', '保存') }}</UButton>
    </div>
  </form>
</template>

<style scoped>
.cloudflare-token-form { padding: 0; }
.cloudflare-token-form label { font-weight: 600; }
.cloudflare-token-form p { margin: 8px 0; }
.cloudflare-token-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.cloudflare-token-input { width: min(100%, 560px); }
@media (max-width: 600px) { .cloudflare-token-input { width: 100%; } }
</style>
