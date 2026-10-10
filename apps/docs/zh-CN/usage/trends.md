# Issue 趋势

在网页中进入项目或工作区，打开**趋势**，查看未完成 Issue 存量和每日新增、完成次数。在项目内选择里程碑，可对比其总范围和当前完成范围随日期的变化。图表按 Issue 计件，不代表估算工作量；父 Issue 与子 Issue 各自计一件。

## 日期与统计口径

默认显示包含今天的最近 30 个 UTC 自然日，可查询 1–365 天。过去日期的存量表示该 UTC 日结束时的数量；今天的点截至显示的观察时间，新增和完成次数还会继续增长。

- **未完成**包含待整理、待办、进行中。已完成与已取消单独统计，取消不算完成。
- **新增**统计当天创建 Issue 的次数。恢复 Issue 或将它加入里程碑不算新增。
- **完成**统计进入已完成状态的操作次数。一个 Issue 完成、重开、再完成，计两次完成操作，但今天的已完成存量可能只有一件。
- **里程碑总范围 / 已完成范围**按每日实际归属统计。加入、退出、删除、恢复都会改变范围，折线可以上升或下降。它不表示固定计划或理想燃尽线；关闭里程碑也不会完成其中的 Issue。

删除 Issue 会将它从存量中移除，恢复后重新计入；已记录的历史新增与完成操作仍保留。存量和操作次数含义不同，不能简单地用累计新增减去累计完成推导当前存量。

## 范围与历史覆盖

工作区图表只统计你当前有权读取、且位于本次登录范围内的活跃项目。项目范围登录不会显示其他无权项目。对比报告时查看实际返回的项目列表：权限变化或归档项目会改变统计范围。恢复项目后，可重新读取其可用历史；永久删除项目后无法恢复它的历史。

登录范围固定为单个 Issue 时不提供项目或工作区趋势。需要查看汇总时，让 Agent 重新打开项目，或使用有相应项目范围的登录。

已保存且可恢复的历史会纳入图表。覆盖状态为 `pending` 时，实例维护者可以[按有界批次执行首次回填](../deployment/updates.md#补齐已有趋势历史)；打开或刷新图表不会启动回填。schema 30 起，它与小时维护分开执行。队列处理后刷新图表，查看经过校验的覆盖范围。

缺失区段表示**不可用**，不是零，图表会留出空段。响应逐项目提供 `stock_from`、`flow_from` 与 `history_state`（`pending`、`complete`、`partial`），存量和操作次数的历史起点可能不同。处理完整个队列也无法恢复缺失或不可靠的旧事件，因此仍可能保留 `partial` 和断点。工作区汇总中，只要有一个纳入的项目缺少某项指标的覆盖，该指标就显示不可用。

趋势使用自己的日期与范围选择，看板或列表的状态、负责人、优先级、标签和搜索条件不作用于图表。Issue 可以不属于里程碑，维护方式见[项目里程碑](milestones.md)。

## Agent 与终端

```text
查看本项目最近 30 天的未完成 Issue 存量和每日新增、完成次数，说明 UTC 日期、观察时间和缺失历史。
```

```text
对比本工作区最近 90 天的 Issue 趋势，告诉我实际包含哪些有权项目，不要把缺失历史当成零。
```

```text
查看本项目“发布”里程碑最近 30 天的 Issue 总范围与已完成范围，把范围变化和完成情况分开说明。
```

公共 CLI 的 `issue trends` 使用已核验的实例/项目上下文，`workspace issue trends` 使用工作区上下文：

```sh
cfkanban issue trends --days 30 --json
cfkanban workspace issue trends --workspace-id workspace-uuid --days 90 --json
cfkanban workspace issue trends --workspace-id workspace-uuid --project project-uuid --days 30 --json
```

查询里程碑时，在 `issue trends` 加上 `--milestone <里程碑 UUID>`。MCP 提供 `cfkanban_project_issue_trends` 和 `cfkanban_workspace_issue_trends`，宿主可能带命名空间前缀。它们读取相同的服务端统计，返回历史覆盖与实际范围。旧服务未声明 `issue_trends` 时应说明能力缺失，不遍历 Issue 列表编造历史。

REST 提供 `GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/trends?days=30`（可选 `milestone`）及 `GET /api/v1/workspaces/{workspace_id}/issues/trends?days=30`（可重复 `project` UUID，最多 100 个）。不支持分页或普通 Issue 筛选，显式无权目标和未知参数会被拒绝。所有读取沿用服务端实时权限，查看图表不会授予额外权限。
