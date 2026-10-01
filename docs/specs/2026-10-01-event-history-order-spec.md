# 活动历史倒序与兼容增量消费

- 状态：Frozen
- 日期：2026-10-01
- 授权依据：用户要求在 `feat/v1.6.0` 完成 CFK-540。
- 本增量仅覆盖 Foundation、API / Schema 与 Web UI 中的 Event / Owner Audit 历史排序、分页和查询索引；既有写入、实时权限、关系可见性与默认增量 feed 保持有效。

## API 与兼容性

`GET /api/v1/events` 与 `GET /api/v1/admin/audit-events` 增加可选单值 `order=asc|desc`。省略或显式 `asc` 都按 `sequence ASC` 返回，并保持既有 cursor filter hash、tuple 与 write `event_cursor` 的增量消费语义。非法值、空值或重复 `order` 返回 `VALIDATION_ERROR`。

显式 `desc` 按 `created_at DESC, sequence DESC` 返回历史。同一时间戳用实例级唯一 sequence 稳定排序；不假设时间戳随 sequence 单调。`after` 继续承载 opaque cursor，`limit` 默认 20、最大 100；普通读取不执行计数，不使用 offset，也不由客户端全量正序拉取后反转。

倒序 cursor 编码上一条的时间戳、sequence 与首屏开始时已存在事件的 sequence 上界，绑定排序、Principal、规范化过滤与当前可读 Project 集合。后续页只读上界以内且早于上一条 keyset 的事件；分页期间新增事件即使有更旧时间戳也不插入该历史序列。刷新或重新应用筛选开启新序列，才能看到新增事件。时间相同的多 stream 事件也按 sequence 归并。

正序和倒序 cursor 不能混用；write cursor 仅用于默认正序 feed。排序、Project、workspace、stream、Principal 或当前可读范围改变时，旧 cursor 返回 `CURSOR_SCOPE_MISMATCH`；非法 keyset 返回 `INVALID_CURSOR`。cursor 是分页状态，不能扩大授权，仍按每次请求的实时权限过滤并在返回前复核。

参与者倒序仍只返回 domain Event。跨项目关系事件须两端 Project 都在当前可读集合中，项目筛选只缩小结果项目，不绕过另一端的可见性检查。Owner Audit 保留实例级双 stream、单 immutable Project、单 stream 及二者组合；空 Project 的安全事件只进入未限制 Project 的结果。`resolved_scope` / `resolved_filters` 保持既有结构。

## Web 与 Agent

项目活动的共享组件在参与者项目页面及 Owner 的项目入口均显式请求倒序，首屏显示最近变更，继续加载较早历史，刷新开始新序列。Owner「操作记录」同样显式请求倒序；重新应用筛选读取最新首页，修改筛选废弃旧 cursor。页面文案解释最新在前、加载更早和刷新查看新增，保留服务端顺序。

Agent 继续使用默认正序读取增量事件；读取最近历史时可以显式选择 `order=desc`。Web 与 Agent 复用同一权限、筛选和 cursor 合同。

## Schema 16 与读取成本

新增兼容 migration `0016_event_history_indexes.sql`，在 schema 15 后增加三个索引并推进 schema 到 16：

- `idx_events_history(created_at DESC, sequence DESC)`：实例级双 stream 历史。
- `idx_events_stream_history(stream, created_at DESC, sequence DESC)`：实例级单 stream 历史。
- `idx_events_project_stream_history(project_id, stream, created_at DESC, sequence DESC)`：单项目单 stream；项目双 stream 分别取有界候选再归并。

既有 sequence 索引保留，支持默认增量 feed、旧 Worker 与 cursor。不改写已发行 migration，不修改 Event 内容，部署新 Worker 前须先应用完整 schema 16 migration 序列。

领域历史每个当前结果项目先执行完整可见性谓词和时间 keyset、取 `limit+1` 候选，再归并成一页；完整 actor / Project / Workspace 投影只读取已收敛的一页。实例 Audit 使用匹配时间索引，项目双 stream 各取一页归并，不先排序整个实例或整个项目历史。

读取成本与结果项目数、stream 数和被排除的关系事件或 sequence 上界以外事件有关，不承诺任意数据分布都只读取页大小。新增索引增加每条 Event 三个索引项的写入与存储成本，不增加读取审计写入、计数器或后台任务。

隔离本地 D1 验收记录 `EXPLAIN QUERY PLAN`、`rows_read`、返回行数、耗时及索引写入代价，并以强制旧 sequence 索引的等价查询比较深页成本。覆盖同时间多页、多项目、多 stream、项目/stream筛选、旧增量 cursor、分页期间新增、Principal/权限范围漂移和跨项目关系。该证据只代表本地 workerd D1，不视为线上计量。
