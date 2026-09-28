<script setup lang="ts">
import { computed } from "vue";
import type { ContainerState, ContainerTree } from "../lib/container-tree";
import { containerChoiceLabels } from "../lib/container-choice";
import { errorText } from "../lib/api";
import { locale } from "../lib/i18n";

const props = defineProps<{ tree: ContainerTree; archived?: boolean }>();
const emit = defineEmits<{
  workspaces: [state: ContainerState];
  projects: [workspaceId: string, state: ContainerState];
}>();
function ui(en: string, zh: string): string { return locale.value === "zh-CN" ? zh : en; }
const states = computed<ContainerState[]>(() => props.archived ? ["active", "archived"] : ["active"]);
const groups = computed(() => [...props.tree.workspaces.active.items, ...props.tree.workspaces.archived.items]);
const labels = computed(() => containerChoiceLabels(groups.value.map(item => ({ id: item.id, name: item.display_name }))));
const projectPages = computed(() => groups.value.flatMap(workspace => states.value
  .filter(state => state !== "active" || !workspace.deleted_at)
  .map(state => ({ workspace, state, page: props.tree.projectPage(workspace.id, state) }))
  .filter(({ page }) => page.cursor || page.error || page.loading)));
</script>

<template>
  <div class="container-pagination" :aria-label="ui('Load more workspaces and projects', '继续加载工作区和项目')">
    <template v-for="state in states" :key="state">
      <div v-if="tree.workspaces[state].cursor || tree.workspaces[state].error || tree.workspaces[state].loading">
        <p v-if="tree.workspaces[state].error" class="inline-alert" role="alert">{{ errorText(tree.workspaces[state].error) }}</p>
        <button class="secondary-button" type="button" :disabled="tree.workspaces[state].loading" @click="emit('workspaces', state)">{{ tree.workspaces[state].loading ? ui('Loading…', '正在加载…') : tree.workspaces[state].error ? ui('Retry workspace page', '重试工作区分页') : state === 'archived' ? ui('Load more archived workspaces', '加载更多已归档工作区') : ui('Load more workspaces', '加载更多工作区') }}</button>
      </div>
    </template>
    <div v-for="{ workspace, state, page } in projectPages" :key="`${state}:${workspace.id}`">
      <p v-if="page.error" class="inline-alert" role="alert">{{ errorText(page.error) }}</p>
      <button class="text-button" type="button" :disabled="page.loading" @click="emit('projects', workspace.id, state)">{{ page.loading ? ui('Loading…', '正在加载…') : page.error ? ui('Retry projects', '重试项目分页') : state === 'archived' ? ui('More archived projects', '更多已归档项目') : ui('More projects', '更多项目') }} · {{ labels.get(workspace.id)?.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.container-pagination { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 16px; margin: 12px 0; }
.container-pagination:empty { display: none; }
.container-pagination button { white-space: normal; text-align: left; }
</style>
