<script setup lang="ts">
import IssueCommentHeader from "./IssueCommentHeader.vue";

defineProps<{ authorName?: string | undefined; createdAt?: string | undefined; completed?: boolean | undefined }>();
</script>

<template>
  <article class="issue-comment" :class="{ 'issue-comment-completed': completed }">
    <IssueCommentHeader :author-name="authorName" :created-at="createdAt" :completed="completed">
      <template v-if="$slots.actions" #default><slot name="actions" /></template>
    </IssueCommentHeader>
    <slot />
  </article>
</template>

<style scoped>
.issue-comment { box-sizing: border-box; min-width: 0; max-width: 100%; margin: 12px 0; padding: 16px; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg); color: var(--ui-text); font-size: 16px; overflow-wrap: anywhere; }
.issue-comment-completed { border-color: color-mix(in srgb, var(--ui-success) 25%, var(--ui-border)); }
</style>
