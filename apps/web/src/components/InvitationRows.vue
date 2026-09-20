<script setup lang="ts">
import { locale } from "../lib/i18n";
import type { InvitationResource } from "../types";

defineProps<{ items: InvitationResource[]; busy: boolean }>();
const emit = defineEmits<{ revoke: [invitation: InvitationResource] }>();

function ui(english: string, chinese: string): string {
  return locale.value === "zh-CN" ? chinese : english;
}

function kindLabel(kind: string): string {
  return kind === "project_grant"
    ? ui("Project invitation", "项目授权邀请")
    : kind === "principal_recovery" ? ui("Identity recovery", "身份恢复邀请") : kind;
}

function statusLabel(status: string): string {
  const labels: Record<string, [string, string]> = {
    active: ["Active", "有效"], expired: ["Expired", "已过期"],
    redeemed: ["Accepted", "已兑换"], revoked: ["Revoked", "已撤销"],
  };
  const label = labels[status];
  return label ? ui(...label) : status;
}

function roleLabel(role: string): string {
  return role === "writer" ? ui("Writer", "协作者") : role === "reader" ? ui("Reader", "只读者") : role;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
</script>

<template>
  <div class="data-list">
    <div v-for="invitation in items" :key="invitation.id" class="data-row invitation-row">
      <span>
        <strong>{{ kindLabel(invitation.kind) }}</strong>
        <code>{{ invitation.code_fingerprint }}</code>
        <small>{{ ui("Created", "创建于") }} {{ formatTime(invitation.created_at) }}</small>
      </span>
      <span>
        <template v-if="invitation.kind === 'project_grant'">{{ invitation.grants.map((grant) => `${grant.workspace_display_name}/${grant.display_name}: ${roleLabel(grant.role)}`).join(" · ") }}</template>
        <template v-else>{{ invitation.bound_principal?.display_name ?? invitation.bound_principal?.principal_id }} · {{ invitation.recovery_mode }}</template>
        <small>{{ statusLabel(invitation.status) }} · {{ ui("Expires", "到期") }} {{ formatTime(invitation.expires_at) }}</small>
      </span>
      <button v-if="invitation.allowed_actions.includes('revoke')" class="danger-text-button" type="button" :disabled="busy" @click="emit('revoke', invitation)">{{ ui("Revoke", "撤销") }}</button>
    </div>
    <p v-if="items.length === 0" class="empty-copy">{{ ui("No invitations", "暂无邀请记录") }}</p>
  </div>
</template>
