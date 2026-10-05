<script setup lang="ts">
import githubMark from "../../../web/src/assets/github-mark.svg";

const githubIconStyle = { "--docs-link-icon": `url("${githubMark}")` };
defineProps<{ zh: boolean }>();
</script>

<template>
  <div class="docs-nav-links">
    <a
      href="https://github.com/breakstring/cfKanban"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="zh ? 'cfKanban GitHub 仓库（在新标签页打开）' : 'cfKanban on GitHub (opens in a new tab)'"
    >
      <span class="docs-link-icon" :style="githubIconStyle" aria-hidden="true"></span>
      <span>GitHub</span>
    </a>
    <a class="docs-home" href="/" target="_self">{{ zh ? "返回站点" : "Back to site" }}</a>
  </div>
</template>
