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
  save: (kind: string, token: string) => Promise<void>;
}>();
const emit = defineEmits<{ verify: [] }>();
const token = ref("");
const saving = ref(false);
const uncertain = ref(false);
let mounted = true;
const inputId = computed(() => `cloudflare-token-${props.kind}`);
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
async function save(): Promise<void> {
  if (saving.value || uncertain.value || props.disabled || !token.value.trim()) return;
  const value = token.value.trim();
  token.value = "";
  saving.value = true;
  uncertain.value = false;
  try { await props.save(props.kind, value); }
  catch { if (mounted) uncertain.value = true; }
  finally { if (mounted) saving.value = false; }
}
onUnmounted(() => { mounted = false; token.value = ""; });
</script>

<template>
  <form class="cloudflare-token-form" :aria-busy="saving" @submit.prevent="save">
    <label :for="inputId">{{ label }}</label>
    <p :id="`${inputId}-description`" class="muted-copy">{{ description }}</p>
    <div class="cloudflare-token-controls">
      <UInput :id="inputId" v-model="token" type="password" autocomplete="off" autocapitalize="none" :spellcheck="false" :disabled="disabled || saving || uncertain" :aria-describedby="`${inputId}-description`" class="cloudflare-token-input" />
      <UButton color="primary" variant="solid" type="submit" :disabled="disabled || saving || uncertain || !token.trim()">{{ saving ? ui('Saving and applying…', '正在保存并应用…') : ui('Save and apply configuration', '保存并应用配置') }}</UButton>
    </div>
    <p v-if="uncertain" class="warning-panel" role="alert">{{ ui('The result could not be confirmed. The Token input has been cleared. Verify the current state before entering a Token again.', '操作结果尚未确认，Token 输入已清空。请先核验当前状态，再决定是否重新输入 Token。') }} <UButton color="neutral" variant="outline" type="button" @click="emit('verify')">{{ ui('Verify current state', '核验当前状态') }}</UButton></p>
  </form>
</template>

<style scoped>
.cloudflare-token-form { padding: 20px 0; border-bottom: 1px solid var(--color-border); }
.cloudflare-token-form label { font-weight: 600; }
.cloudflare-token-form p { margin: 8px 0; }
.cloudflare-token-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.cloudflare-token-input { width: min(100%, 440px); }
.cloudflare-token-form .warning-panel { margin-top: 12px; }
@media (max-width: 600px) { .cloudflare-token-input { width: 100%; } }
</style>
