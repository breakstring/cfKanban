<script setup lang="ts">
import type { StatusKey } from "../types";

defineProps<{ statusKey: StatusKey }>();
</script>

<template>
  <span class="issue-status-mark" :data-status="statusKey" aria-hidden="true"><svg v-if="statusKey === 'done'" viewBox="0 0 16 16"><path d="m4 8 3 3 5-6" /></svg><svg v-else-if="statusKey === 'canceled'" viewBox="0 0 16 16"><path d="m5 5 6 6m0-6-6 6" /></svg></span>
</template>

<style scoped>
.issue-status-mark { display: inline-flex; align-items: center; justify-content: center; flex: none; box-sizing: border-box; width: var(--status-mark-size, 12px); height: var(--status-mark-size, 12px); border: 1.5px solid var(--color-status-backlog); border-radius: 50%; }
.issue-status-mark[data-status="backlog"] { border-style: dashed; }
.issue-status-mark[data-status="todo"] { border-color: var(--color-status-todo); }
.issue-status-mark[data-status="in_progress"] { border-color: var(--color-status-in-progress); background: linear-gradient(90deg, var(--color-status-in-progress) 50%, transparent 50%); }
.issue-status-mark[data-status="done"] { border-color: var(--color-status-done); background: var(--color-status-done); color: #fff; }
.issue-status-mark[data-status="canceled"] { border-color: var(--color-status-canceled); color: var(--color-status-canceled); }
.issue-status-mark svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
</style>
