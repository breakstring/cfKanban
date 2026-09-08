<script setup lang="ts">
defineProps<{ id: string; language: string; workspaceId?: string | undefined; workspaceName?: string | undefined; context?: string | undefined; createdAt?: string | undefined }>();
</script>

<template>
  <details class="container-identity-details">
    <summary>{{ language === 'zh-CN' ? '查看对象详情' : 'View object details' }}</summary>
    <dl>
      <div><dt>{{ language === 'zh-CN' ? '对象 ID' : 'Object ID' }}</dt><dd><code>{{ id }}</code></dd></div>
      <div v-if="workspaceId"><dt>{{ language === 'zh-CN' ? '所属工作区' : 'Workspace' }}</dt><dd>{{ workspaceName }} <code>{{ workspaceId }}</code></dd></div>
      <div v-if="context"><dt>{{ language === 'zh-CN' ? '项目说明' : 'Project notes' }}</dt><dd>{{ context }}</dd></div>
      <div v-if="createdAt"><dt>{{ language === 'zh-CN' ? '创建于' : 'Created' }}</dt><dd>{{ createdAt }}</dd></div>
    </dl>
  </details>
</template>

<style scoped>
.container-identity-details { margin-top: 6px; font-size: 0.85rem; color: var(--color-text-muted); }
summary { cursor: pointer; }
dl { margin: 8px 0; }
dd { margin: 2px 0 8px; overflow-wrap: anywhere; white-space: pre-wrap; }
code { display: block; }
</style>
