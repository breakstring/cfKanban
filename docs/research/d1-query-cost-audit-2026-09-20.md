# D1 查询与迁移成本审计（2026-09-20）

本次依据：cfkanban.dev schema 9 的只读计数、EXPLAIN QUERY PLAN 和单次 D1 `meta`；0009 部署 journal；Cloudflare GraphQL 采样元数据；当前 Worker、Skill runtime 与 migrations；本地隔离的合成数据回归。没有修改远端数据库或部署 Worker。线上观测与本地优化结果不能混用。

## 指标口径与迁移误读

D1 `meta.rows_read/rows_written` 是单次执行的行计量，索引维护也计写入。SQL Insights 使用 `d1QueriesAdaptiveGroups`；它的计数、总行数和总耗时可以是采样估算，不能直接当作精确调用日志或逐条配额扣减凭证。

本次 `0009_scoped_administrators.sql` 只有一次 apply，2026-09-20 06:01:58–06:02:00 UTC 成功。它扩展事件授权 CHECK 和管理员审计字段，必须保留历史、重建事件表。

| 操作 | 原始执行 | Insights |
| --- | --- | --- |
| `INSERT INTO events_scoped … SELECT … FROM events` | 搬迁 2,896 条历史事件；读取 8,691，写入 8,689；70.0565 ms | sampleInterval=1、sampleSize=1、count=1 |
| `ALTER TABLE events_scoped RENAME TO events` | 写入 42、读取 513；4.0308 ms | sampleInterval=12、sampleSize=1，估算 12 次、504 写、6,156 读、48.3696 ms |

复制的 8,689 写恰好为 `2,896 × (主表 + id 唯一索引 + operation/event_index 唯一索引) + 1 条序列记录`；不是新建 8K 业务事件。后续查询索引重建另有一次性成本。重命名主要改变 schema 定义，不搬迁业务行；不能把 42 写进一步解释为修改了 42 个表。

重命名的估算次数 95% 区间为 `[0, 34.518…]`，不表示观察到 12 次迁移。另一个数据库聚合数据集 `d1AnalyticsAdaptiveGroups` 在 06:02 UTC 返回读取 35,714、写入 17,731，sampleInterval=1、上下置信界相等；06:03 的 ledger 补记写入 2，同样无采样放大。两个数据集不可机械相加或互相当作逐 SQL 账单。

按公开计量定义，rename 对应原始 meta 的 42 写；没有“quota deducted”接口读回，不能声称核验了 Cloudflare 内部免费额度执行器。官方推荐账户 Billing → Billable Usage 查看用量。保留已发行 0009；不因为 Insights 估算重复改历史迁移、执行 restore 或删除历史。

来源：[D1 定价与行计量](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 Metrics/Insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/)、[采样](https://developers.cloudflare.com/analytics/graphql-api/sampling/)、[置信区间](https://developers.cloudflare.com/analytics/graphql-api/features/confidence-intervals/)、[Billing](https://developers.cloudflare.com/d1/observability/billing/)、[SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)。平台资料是本日快照，不是长期产品合同。

## 线上热点证据

当前只读快照：6 个 Principal、393 条 Issue（201 条未软删除）、48 条项目记录（4 条有效、43 条永久删除墓碑、1 条归档）、30 条工作区记录（2 条有效）、147 条 Issue 标签关联。

| 查询 | 单次线上实测 | 判断 |
| --- | --- | --- |
| Owner 可见项目 | 返回 4，读取 56 | 全扫项目索引，墓碑仍参与扫描；日常多个调用点复用此查询 |
| 固定项目的同一可选 OR 查询 | 返回 1，读取 50 | `? IS NULL OR id=?` 阻止直接定位；等值对照只读 2 |
| Principal 列表和统计 | 返回 6，读取 2,390 | 每个用户都扫描以 project_id 开头的负责人索引；约 `6×393` |
| 单个 Issue 的标签 | 返回 1，读取 6 | 已命中 issue_labels 主键和 labels 主键 |
| 50 个 Issue 的标签 | 返回 55，读取 291 | 批量匹配与排序成本；没有同类全关联表扫描 |

用户给出的 1,298/18/229 次和 73K/42K/18K 是所选时间窗的 Insights 展示值，本次未逐一核验这些组的采样率。此前按展示次数乘单次成本仅用于量级解释，不能当作精确调用归因。长 Issue SQL 的“耗时占 6%”也是相对统计，不能仅凭 SQL 长度或百分比断定慢；需要计划、单次 meta、输入范围和分页位置。

## 本次实现

1. 可见项目按实际存在的固定 Session 条件构建绑定谓词；已知资源的授权直接限制 workspace/project。请求目标与固定 Session 取交集，不覆盖 Session，不缓存权限。
2. 保留确实需要的全可见项目集合，用于跨项目关系、blocked 和游标 scope；增加有效项目部分索引跳过归档/永久删除记录。保留读取结束时实时身份与 scope 检查。
3. Principal 先按过滤/游标取有界页面，再统计该页凭据、直接 Grants 和 assignment；补充匹配实际过滤前缀的索引。
4. 普通 Issue 查询保留当前身份/授权 CTE，先选出有界 Issue number 页面，再连接用户、状态、项目与资格投影；单项目走等值范围，多项目保留集合语义。仅存在筛选时构造固定白名单谓词；正常/删除/候选分页用 tuple 范围定位，保留 title substring 与 identifier OR 的原搜索语义。
5. Owner 全范围邀请列表把逐条相同鉴权收敛为入口和完整投影后的检查；局部管理员逐目标管理检查保留，空页也做最终检查。
6. 评论正常/删除列表用现有索引的 tuple 游标范围，避免深页从该 Issue 的首条评论重新读起。
7. 附件垃圾回访已释放预算时跳过两条必然无效的预算更新；仍保留 R2 delete/head、回访顺序、last_checked_at 和未释放预算的事务条件。

### schema 10 索引与写入代价

只追加 `0010_query_indexes.sql`，不改旧迁移、不重建表、不清理数据。四个索引：

| 索引 | 用途 | 持续写入影响 |
| --- | --- | --- |
| `projects(workspace_id,id) WHERE deleted_at IS NULL` | 有效项目范围 | 项目创建/归档/恢复维护；永久删除墓碑不进入索引 |
| `issues(assignee_principal_id) WHERE deleted_at IS NULL` | 用户 assignment 统计 | 活跃 Issue 创建/删除/恢复/改指派维护；普通无关列变化不扩大索引字段 |
| `principals(created_at,id)` | 用户列表有界分页 | 新用户维护，改显示名不改变索引字段 |
| `project_grants(principal_id) WHERE revoked_at IS NULL` | 用户直接授权数量 | 新增/撤销/重新授予维护 |

建索引本身需要一次扫描和写入索引条目，需计入升级 plan；不能把新增索引说成零写入成本。旧 schema 9 可运行优化 Worker 查询但没有全部索引收益；schema 10 的数据形状与 schema 9 兼容。Owner recovery 本地支持上限同步至 10。远端升级仍需独立授权、restore point、ledger/schema 读回。

## 全部数据库操作族的审计结论

| 范围 | 核对内容与处置 |
| --- | --- |
| 认证、Session、Passkey、身份 | digest 唯一索引和主键命中；last-used 低频更新。保留实时撤销检查，不引入跨请求权限缓存 |
| 项目范围/权限 | 修正热点的全列表找单项；非 Owner 有效授权视图可下推 principal/project 过滤，不因窗口 SQL 复杂替换权限模型 |
| Issue 列表、候选、恢复、指派 | 实施先分页再投影/动态条件/tuple；保留恢复资格、title substring、显式指派策略及最终 scope 竞争检查 |
| 用户、凭据、授权摘要 | 实施页面限制及针对性索引；不改变直接 Grant 和管理授权的独立含义 |
| 标签 | 已有双向关联索引及名称唯一索引；批量标签查询保留，不重复建索引 |
| 评论 | 改深页游标；保持 completion 不可变与普通评论权限 |
| 关系与 blocked 投影 | 两端索引与当前可见 Project 过滤存在；跨项目检查保留 |
| 事件与审计 | sequence/project/stream 索引和先限候选设计存在；不删除审计或缩减历史语义 |
| 幂等/事务证明 | operation ID、复合幂等唯一键、events(operation_id,event_index) 命中；不删除快照、提交哨兵或恢复读回 |
| 邀请/Public Join | 优化 Owner 列表重复鉴权；维持一次性兑换、管理授权 generation 与 quota 原子条件 |
| 附件及预算 | 列表/到期/回收索引存在；跳过已释放预算的冗余事务，保留晚到 PUT 回访 |
| 用量统计 | singleton 缓存，15 分钟 freshness/60 秒冷却；没有每请求全库统计 |
| 会话/幂等/附件定时清理 | 有界批次与到期索引；附件每小时回访上限 64，不把业务 UPDATE 次数等同 D1 计量行 |
| 容器归档、永久删除 | 正常范围索引存在；永久删除按关系两端/邀请反向/Session JSON 的部分扫描确实存在，但低频；保留最终原子影响校验 |
| bootstrap、名称、限流、迁移 | bootstrap 低频、名称唯一索引、边缘限流不逐请求写 D1；已发行 migration 只按 ledger 执行，无请求路径 DDL |

暂不增加低频永久删除的多组索引、不重写项目成员管理视图、不将任意 substring 改成精确/前缀搜索、不引入 FTS 或外部缓存。它们需要相应输入规模/调用成本证据或产品语义确认，不属于遗漏已证实热点。

## 可重复验证

成本测试使用本地 Wrangler/workerd 占位 D1、合成身份与数据，没有生产 Credential 或外部数据写入。

- `scripts/tests/database-query-cost.integration.test.mjs`：96 项目（94 归档）、1,200 Issue（600 活跃）、6 Principal；点授权 2–3 行、有效项目列表 6 行、用户统计 83 行；20 条 Issue 每页，第 1/20 页为 172/174 行；覆盖固定 Project/Issue Session 交集、多项目、删除视图、状态/负责人、同时间戳分页及候选排序。
- `scripts/tests/secondary-query-efficiency.integration.test.mjs`：Owner 邀请空页 3 次、有 20/60 条均 4 次查询；最终撤权仍 401；已释放附件仍回访而无预算 batch；评论深页 259→38 行，正常/删除与同时间戳分页完整。
- `scripts/tests/query-indexes-migration.test.mjs`：schema 9→10 数据、旧 schema artifact/约束/事件序列保留，失败完整回滚，四种查询计划命中新索引。

这些是固定夹具的真实读数，不是线上降幅承诺。RC6 发布前完整 `npm run validate` 一次通过：typecheck、344 项单元测试、OpenAPI 114 operations/错误合同、D1 schema/29 indexed query shapes/原子操作/Web 安全/Wrangler 配置、74 项本地集成测试、CI policy、Web/Worker dry-run 构建与产物检查。发行 Skill/Service bundle 两次打包的 SHA-256 一致。

独立只读复核未发现权限/分页回归；追加测试覆盖 Principal 的 project+q+cursor 联合分支、Issue 多状态/多负责人及空结果。未发布前线上仍是旧查询/索引。
