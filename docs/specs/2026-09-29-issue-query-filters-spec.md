# Issue 结构化筛选与有界查询

- 状态：Frozen
- 日期：2026-09-29
- 授权依据：用户要求实施 CFK-497，补齐必要参数、索引优化及 howto / 双语示例。
- 本增量覆盖 API / Schema 与 Web UI 中的 Issue 筛选；保持领域权限、写入、状态、候选分配策略和既有排序不变。

## 参数与结果

普通部署级及 Project Issue 列表保留 `project`、`workspace`、`status`、`assignee`、`blocked`、`q`、`deleted`、`cursor`、`limit`。新增可重复 `priority`（最多 5 项，`urgent / high / medium / low / none`）与 `label`（最多 20 个 Label UUID）。`assignee` 原 UUID 列表额外接受 `unassigned`，表示空负责人，仍最多 20 项。

同维度 OR，不同维度 AND。先校验原始项数，再校验值、去重和排序；空值、非法值和超限均拒绝，不静默删除错误条件。`none` 是无优先级，不表示全部优先级；省略参数才不限制该维度。`assignee=unassigned` 可与 Principal UUID 联用，不限制工作流状态。

候选端点新增相同 `priority` / `label` 参数，继续要求显式 `assignment=mine|unassigned|needs_reassignment`，只选 `todo`，按 `priority_rank ASC, created_at ASC, number ASC` 排序；普通列表保持 `updated_at DESC, number DESC`。普通未分配筛选与候选的待领取策略不是同一语义。现有候选 `blocked=exclude|include` 不变。

Label 使用项目作用域的 immutable ID。调用者先在明确项目读取 Labels 的有界分页，按已返回名称解析 ID；不同项目同名标签分别解析，再用重复 `label` 表示任一匹配。服务端仅匹配调用者可见结果项目内、未删除 Label 的当前关联。未知、其他项目、无权或已删除 Label 均不匹配，不泄露其存在性；一个 Issue 命中多个标签只返回一次。软删除 Label 的关联恢复后重新可见；Issue 删除范围仍由现有 `deleted` 和恢复授权决定。

全部输入通过 SQL 绑定传入，所有条件在分页前执行。cursor 绑定规范化的完整筛选；换条件重用 cursor 返回 `CURSOR_SCOPE_MISMATCH`，同条件不同顺序或重复值等价。`resolved_scope.filters` 保留既有 `statuses / assignees`，非空时增加 `priorities / labels`。未选新条件时省略新增字段，并保持原 cursor filter hash。权限在最终 SQL 中重新核验，不信任预读 scope 或 Web 控件。

## 查询与 schema 13

兼容 migration `0013_issue_query_indexes.sql` 仅新增索引并递增 schema，不改写已发行 migration，不修改业务行。新增三个 active 索引：`(project_id, status_key|assignee_principal_id|priority_key, updated_at DESC, number DESC) WHERE deleted_at IS NULL`；以及待办队列 `(project_id, assignee_principal_id, priority_rank, created_at, number) WHERE deleted_at IS NULL AND status_key='todo'`。旧索引保留以支持旧 Worker、恢复视图和其他读取路径。

普通 active 查询以具体负责人、优先级、状态之一驱动索引；选择包含未分配时，优先使用同时指定的优先级或状态；未选择时使用项目列表索引。每个项目与驱动值内部先执行完整谓词和 keyset，再取 `limit+1`，外层归并后才读取有界完整 Issue 投影。候选按项目及显式优先级分支取页，mine/unassigned 使用待办负责人索引。SQL 显式绑定已知索引；部署新版 Worker 前必须先应用 schema 13。

标签筛选复用 `(label_id, issue_id)` 反向覆盖索引，先物化去重的可见匹配 ID，再读取 Issue 并排序。它减少无关 Issue 读取，但成本仍随标签匹配集合增长；不承诺标签深页或任意组合仅读取页大小。其他组合中的剩余条件、可见阻塞关系和 `q` 子串仍可能增加检查量。不要把 `LIMIT`、命中某个索引或本地执行计划等同于固定 `rows_read`。

新增索引增加存储和相关写入成本；仅 active Issue 进入三个普通索引，`todo` 才进入第四个。通过隔离 D1 的实际查询计量及旧新等价结果对比验收，覆盖数据增长、稀疏/密集、多项目/多值、组合、无匹配、后续分页和时间戳并列。记录 `EXPLAIN`、`rows_read`、返回行数、耗时与写入成本，并明确本地 workerd D1 证据不代表线上测量。

## Web 与 Agent

看板和工作清单提供优先级、标签多选，标签按已选项目分页加载并显示项目区分；不自动遍历全部标签或全实例。工作清单普通负责人筛选提供未分配项，待领取仍是候选队列。筛选变更使旧结果与 cursor 失效，显式应用后重新读取；异步响应受代际检查，不能覆盖更新后的范围。既有隐藏阻塞 UI 的决策保持有效。

daily Skill、cfkanban-howto 和 `apps/docs/` 双语示例同步说明参数、多值逻辑、标签解析、候选差异及分页，示例必须可解析校验且不包含凭据。更新本地 Skill 不等于实例支持新参数，使用前核对支持本增量的 Service/schema 13；旧服务不使用客户端全量翻页模拟该能力。
