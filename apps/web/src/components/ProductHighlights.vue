<script setup lang="ts">
import { computed } from "vue";

import { locale } from "../lib/i18n";

const highlights = computed(() => locale.value === "zh-CN" ? {
  title: "为 Agent 而生，也让人心里有数。",
  items: [
    {
      key: "agent",
      label: "AGENT FIRST",
      title: "一句话，事情往前走。",
      description: "建任务、改状态、指派和评论，交给 Agent。常用操作不必打开 UI。",
      detail: "“把登录问题设为高优先级。”",
    },
    {
      key: "free",
      label: "免费起步",
      title: "部署好，就能开工。",
      description: "基于 Cloudflare Workers 与 D1，核心看板可在免费额度内运行。",
      detail: "R2 附件与付费扩容按需开启。",
    },
    {
      key: "permissions",
      label: "分级权限",
      title: "各管一摊，协作有界。",
      description: "工作区、项目分级管理；管理员、协作者、只读成员，各有边界。",
      detail: "工作区 → 项目 · 管理 / 协作 / 只读",
    },
  ],
} : {
  title: "Built for Agents. Clear for everyone.",
  items: [
    {
      key: "agent",
      label: "AGENT FIRST",
      title: "Say it. Move work forward.",
      description: "Create issues, change status, assign and comment through your Agent. Everyday work needs no UI.",
      detail: "“Set the login issue to high priority.”",
    },
    {
      key: "free",
      label: "START FREE",
      title: "Deploy it. Get to work.",
      description: "Built on Cloudflare Workers and D1. The core board runs within their free allowances.",
      detail: "R2 attachments and paid capacity are optional.",
    },
    {
      key: "permissions",
      label: "SCOPED PERMISSIONS",
      title: "Clear roles. Shared work.",
      description: "Manage access by workspace and project, with scoped administrators, writers and readers.",
      detail: "Workspace → Project · Admin / Writer / Reader",
    },
  ],
});
</script>

<template>
  <section class="product-highlights" aria-labelledby="product-highlights-title">
    <h2 id="product-highlights-title">{{ highlights.title }}</h2>
    <div class="highlights-grid">
      <article v-for="item in highlights.items" :key="item.key" class="highlight">
        <p class="highlight-label">{{ item.label }}</p>
        <h3>{{ item.title }}</h3>
        <p class="highlight-description">{{ item.description }}</p>
        <p class="highlight-detail">{{ item.detail }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.product-highlights {
  padding: 32px 0 36px;
}

.product-highlights h2 {
  margin: 0 0 24px;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: 1.1rem;
  font-weight: 650;
  line-height: 1.5;
}

.highlights-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 32px;
}

.highlight {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.highlight + .highlight {
  padding-left: 32px;
  border-left: 1px solid var(--color-border);
}

.highlight-label {
  margin: 0 0 14px;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.highlight h3 {
  margin: 0 0 14px;
  font-family: var(--font-ui);
  font-size: clamp(1.4rem, 1.9vw, 1.65rem);
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.025em;
  text-wrap: balance;
}

.highlight-description {
  margin: 0 0 20px;
  color: var(--color-text-muted);
  font-size: 1rem;
  line-height: 1.65;
}

.highlight-detail {
  margin: auto 0 0;
  color: var(--color-text-muted);
  font-size: 0.85rem;
  line-height: 1.6;
}

@media (max-width: 940px) {
  .highlights-grid {
    gap: 24px;
  }

  .highlight + .highlight {
    padding-left: 24px;
  }
}

@media (max-width: 760px) {
  .product-highlights {
    padding: 28px 0 32px;
  }

  .highlights-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .highlight + .highlight {
    padding: 24px 0 0;
    border-top: 1px solid var(--color-border);
    border-left: 0;
  }

  .highlight-label {
    margin-bottom: 8px;
  }

  .highlight h3 {
    margin-bottom: 12px;
  }

  .highlight-description {
    margin-bottom: 12px;
  }
}
</style>
