<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, onMounted, onUnmounted, watch } from "vue";

import { locale } from "../lib/i18n";
import { checkNotificationAttention, notificationAttention, notificationSessionKey, setNotificationSession } from "../lib/notifications";
import { navigate } from "../lib/router";
import type { WebSessionView } from "../types";

const props = defineProps<{ session: WebSessionView }>();
const label = computed(() => notificationAttention.hasPending
  ? (locale.value === "zh-CN" ? "通知，有待确认公告" : "Notifications, announcements awaiting confirmation")
  : notificationAttention.unavailable
    ? (locale.value === "zh-CN" ? "通知，提醒检查暂不可用" : "Notifications, reminder check unavailable")
    : (locale.value === "zh-CN" ? "通知" : "Notifications"));

function check(): void { void checkNotificationAttention(); }
watch(() => notificationSessionKey(props.session), () => {
  setNotificationSession(props.session);
  check();
}, { immediate: true, flush: "sync" });
onMounted(() => {
  window.addEventListener("cfkanban:business-success", check);
  window.addEventListener("focus", check);
});
onUnmounted(() => {
  window.removeEventListener("cfkanban:business-success", check);
  window.removeEventListener("focus", check);
});
</script>

<template>
  <UButton color="neutral" variant="ghost" class="notification-bell" type="button" :aria-label="label" :title="label" @click="navigate('/app/notifications')">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 14h12l-1.5-2V8a4.5 4.5 0 0 0-9 0v4L4 14Zm4 3h4" /></svg>
    <span v-if="notificationAttention.hasPending" class="notification-dot" aria-hidden="true" />
  </UButton>
</template>

<style scoped>
.notification-bell { position: relative; width: 2.5rem; min-width: 2.5rem; height: 2.5rem; justify-content: center; }
.notification-bell svg { width: 1.25rem; height: 1.25rem; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.notification-dot { position: absolute; top: .35rem; right: .35rem; width: .5rem; height: .5rem; border-radius: 50%; background: var(--ui-primary); }
</style>
