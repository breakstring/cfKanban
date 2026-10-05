<script setup lang="ts">
import { computed } from "vue";

import bookOpenUrl from "../assets/book-open.svg";
import githubMarkUrl from "../assets/github-mark.svg?no-inline";

const props = defineProps<{ name: "documentation" | "github" }>();
const iconStyle = computed(() => ({
  "--footer-link-icon": `url("${props.name === 'github' ? githubMarkUrl : bookOpenUrl}")`,
}));
</script>

<template>
  <span class="footer-link-icon" :style="iconStyle" aria-hidden="true"></span>
</template>

<style scoped>
.footer-link-icon {
  display: inline-block;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  background-color: currentColor;
  mask: var(--footer-link-icon) center / contain no-repeat;
}
</style>
