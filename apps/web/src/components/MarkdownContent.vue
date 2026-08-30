<script setup lang="ts">
import { computed } from "vue";

import { renderMarkdown } from "../lib/markdown";

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- renderMarkdown escapes raw HTML and only emits allowlisted markup/URLs. -->
  <div class="markdown" v-html="html" />
</template>
