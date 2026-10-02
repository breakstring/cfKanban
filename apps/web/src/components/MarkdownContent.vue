<script setup lang="ts">
import { computed } from "vue";

import { renderMarkdown } from "../lib/markdown";

const props = defineProps<{ source: string; baseUrl?: string; linkTarget?: "_blank" }>();
const html = computed(() => renderMarkdown(props.source, {
  ...(props.baseUrl === undefined ? {} : { baseUrl: props.baseUrl }),
  ...(props.linkTarget === undefined ? {} : { linkTarget: props.linkTarget }),
}));
</script>

<template>
  <!-- renderMarkdown escapes raw HTML and only emits allowlisted markup/URLs. -->
  <div class="markdown" v-html="html" />
</template>
