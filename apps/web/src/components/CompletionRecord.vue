<script setup lang="ts">
import { computed } from "vue";

import { parseCompletionRecord, safeArtifactHref } from "../lib/completion-record";
import { locale } from "../lib/i18n";

const props = defineProps<{ value: unknown }>();
const completion = computed(() => parseCompletionRecord(props.value));
</script>

<template>
  <div v-if="completion" class="completion-record">
    <p>{{ completion.summary }}</p>
    <section v-if="completion.verification.length">
      <strong>{{ locale === "zh-CN" ? "验证" : "Verification" }}</strong>
      <ul><li v-for="item in completion.verification" :key="item">{{ item }}</li></ul>
    </section>
    <section v-if="completion.artifacts.length">
      <strong>{{ locale === "zh-CN" ? "产物" : "Artifacts" }}</strong>
      <ul><li v-for="artifact in completion.artifacts" :key="`${artifact.kind}:${artifact.value}`"><code>{{ artifact.kind }}</code> <a v-if="safeArtifactHref(artifact)" :href="safeArtifactHref(artifact) ?? undefined" target="_blank" rel="noreferrer noopener">{{ artifact.value }}</a><span v-else>{{ artifact.value }}</span></li></ul>
    </section>
    <section v-if="completion.follow_ups.length">
      <strong>{{ locale === "zh-CN" ? "后续" : "Follow-ups" }}</strong>
      <ul><li v-for="item in completion.follow_ups" :key="item">{{ item }}</li></ul>
    </section>
  </div>
  <slot v-else />
</template>
