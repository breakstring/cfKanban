<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useData, withBase } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import version from "../../../../release/version.json";
import mark from "../../../web/src/assets/cfkanban-mark.png";
import { writeStoredLocale } from "../../../web/src/lib/locale-preference";

const { lang, page } = useData();
const zh = computed(() => lang.value === "zh-CN");
const rawLink = computed(() => withBase(`/${page.value.relativePath}`));
function updatePage(): void {
  const locale = page.value.relativePath.startsWith("zh-CN/") ? "zh-CN"
    : page.value.relativePath.startsWith("en/") ? "en" : null;
  if (locale) writeStoredLocale(() => window.localStorage, "cfkanban_locale", locale);
  for (const button of document.querySelectorAll<HTMLButtonElement>("div[class*='language-'] > button.copy")) {
    button.title = zh.value ? "复制提示词" : "Copy prompt";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("data-copied", zh.value ? "已复制" : "Copied");
  }
}
onMounted(updatePage);
watch(() => page.value.relativePath, updatePage, { flush: "post" });
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-before>
      <span class="docs-brand">
        <img :src="mark" alt="" />
        <span>cfKanban</span>
      </span>
    </template>
    <template #nav-bar-content-before>
      <span class="docs-label">{{ zh ? "文档" : "Documentation" }}</span>
    </template>
    <template #nav-bar-content-after>
      <a class="docs-home" href="/" target="_self">{{ zh ? "返回站点" : "Back to site" }}</a>
    </template>
    <template #doc-before>
      <div class="docs-page-meta">
        <span>{{ zh ? "适用版本" : "For version" }} {{ version.version }}</span>
        <a :href="rawLink" target="_self">{{ zh ? "读取 Markdown" : "Read Markdown" }}</a>
      </div>
    </template>
    <template #not-found>
      <main class="docs-not-found">
        <p class="code">404</p>
        <h1>Page not found · 页面不存在</h1>
        <p>This documentation link may be outdated. 此文档链接可能已过期。</p>
        <a :href="withBase('/en/overview/')">English documentation</a>
        <a :href="withBase('/zh-CN/overview/')">简体中文文档</a>
        <a href="/" target="_self">cfKanban</a>
      </main>
    </template>
  </DefaultTheme.Layout>
</template>
