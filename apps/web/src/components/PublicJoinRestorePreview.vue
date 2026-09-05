<script setup lang="ts">
import type { ContainerResource, Locale } from "../types";

const props = defineProps<{
  projects: NonNullable<ContainerResource["resumed_public_projects"]>["projects"];
  language: Locale;
}>();
const ui = (en: string, zh: string) => props.language === "zh-CN" ? zh : en;
const kinds = ["issues", "comments", "principals"] as const;
const labels = { issues: ["Issues", "事项"], comments: ["Comments", "评论"], principals: ["Participants", "参与者"] } as const;
</script>

<template>
  <div class="public-restore-list">
    <section v-for="project in projects" :key="project.id" class="public-restore-project">
      <strong>{{ project.workspace_key ? `${project.workspace_key}/` : '' }}{{ project.key }}</strong>
      <span>{{ project.display_name ?? project.id }}</span>
      <p class="public-restore-summary"><strong>{{ ui("Public summary", "公开摘要") }}</strong><span>{{ project.public_summary ?? ui("Unavailable", "暂不可用") }}</span></p>
      <p>{{ ui("Public roles", "公开角色") }}：{{ project.role_choices?.map(role => role === 'writer' ? ui('Writer', '协作者') : ui('Reader', '只读者')).join(' / ') ?? '—' }}</p>
      <table class="public-restore-quotas">
        <caption>{{ ui("Active usage and limits", "当前用量与上限") }}</caption>
        <thead><tr><th scope="col">{{ ui("Resource", "资源") }}</th><th scope="col">{{ ui("Active", "当前用量") }}</th><th scope="col">{{ ui("Limit", "上限") }}</th></tr></thead>
        <tbody><tr v-for="kind in kinds" :key="kind"><th scope="row">{{ ui(labels[kind][0], labels[kind][1]) }}</th><td>{{ project.active_usage?.[kind] ?? '—' }}</td><td>{{ project.resource_limits?.[kind] ?? '—' }}</td></tr></tbody>
      </table>
    </section>
  </div>
</template>
