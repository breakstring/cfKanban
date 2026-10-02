# D1 读取优化验证（2026-10-02）

本记录对应 schema 18 的读取优化，沿用现有 API、权限、Session scope、排序、精确统计、配额、CAS 与审计合同。证据来自本地 Wrangler/workerd、全零占位数据库 ID 和隔离合成数据；`meta.rows_read` / `meta.rows_written` 是本地执行读数，不证明线上计费降幅。旧迁移和发行工件保持原指纹。

## 查询变化

- Project 成员先限定直接 Grant、Project administrator、Workspace administrator 三个来源，再按原有效角色优先级去重。Owner 单独投影，来源历史与角色含义保持一致。
- 精确有效人数使用限定目标的三个来源并集 `COUNT(DISTINCT principal_id)`，替代对窗口视图的相关统计。管理员来源仍核对 Project 与 Workspace 归属，Owner 只有实际来源才按既有统计口径计入；归档不会丢掉历史授权。
- Workspace、Project、Credential、Grant、Administrator、Invitation、Label、Attachment、Notification 续页使用真实索引范围。首屏省略可选游标 OR；并列排序和 cursor scope 保持原含义。
- Invitation 在同一条 SQL 中先按时间索引、原 cursor 预检最多 `max(limit+1,32)` 条记录，经完整 Project / managed 过滤后，足够成页或全局历史已穷尽时直接返回。只有预检已满且合法记录不足时，才从反向目标索引查更早记录，按剩余页容量补齐；反查以 gate 为连接起点，多目标先去重。两段时间范围严格互斥，再驱动有界资源投影。页内全部目标一次投影后，按不同 Project 一次复核，保留确切管理来源 ID / generation、实时身份、父容器与 Session 交集；混合不可管理目标仍不可见。JSON 参数避免随目标数撞到绑定参数上限。
- Relation 两个方向分别完成可见性和父状态过滤，再各取 `limit+1`；合并有界 ID 后驱动投影。自关系被既有 CHECK 禁止，两个方向互斥。稀疏或全隐藏匹配仍可能检查目标 Issue 的大量关系。
- Issue 评论摘要在同一 SQL 中分别取最新十条和覆盖索引精确计数，保留 completion、正序呈现及精确 `omitted_count`，不增加数据库往返。Relation 摘要的 CASE 优先级与精确计数保留。
- Attachment Cron 一次更新本轮最多 64 个候选的回访时间，再保持原 R2 delete/head 和逐对象预算释放原子 batch。更新失败不继续 R2；已释放墓碑仍回访晚到 PUT。进程在批次中间中断时，未实际检查的剩余候选也已推进同轮时间，但墓碑和预算保留，随后按 FIFO 再次回访。

Label 活动页实测自动优化器选择包含墓碑的旧唯一名称索引，因此明确使用新活动部分索引；Cron 集合更新实测误选 state 索引，因此明确使用已有主键索引。Invitation 明确使用时间与反向目标索引，且 gate 位于反查连接之前，避免密集页仍枚举目标全历史。其他新增索引由正常优化器选择；Relation 以有界候选作为连接起点，防止先投影全历史。

## 代表性读取证据

以下成本仅指表内标注的查询或服务调用；不同夹具、主查询与完整服务成本不能混算。随机 UUID 的排序位置会影响读数，表中保留代表性同库运行结果。

| 场景 | 旧实现 | 当前实现 |
| --- | ---: | ---: |
| 1500 人、600 项目及无关授权历史，Project 成员第一页主查询 | 38,479 行读 | 834 行读 |
| 缺少 `project_usage` 的 Project 列表第一页主查询 | 未在同库重复测旧实现 | 234 行读 |
| 精确人数重算单条 UPDATE | 未在同库重复测旧实现 | 110 行读 / 1 行写 |
| 600 条 Credential 历史，第一页 / 深页主查询 | 既有审计发现全范围排序 | 22 / 23 行读 |
| 600 条 Grant / Administrator 历史，深页主查询 | 既有审计发现重复扫描前缀 | 约 44 / 47 行读 |
| 500 个 Workspace，第一页 / 深页主查询 | 既有审计发现全范围排序 | 24 / 25 行读 |
| 5000 活动 Label + 5000 前置墓碑，首页 / 深页 | 5023 / 7524 行读 | 23 / 23 行读 |
| 5000 Label 墓碑深页 | 2523 行读 | 24 行读 |
| 5000 活动 Relation，首页 / 深页 | 35,024 / 20,018 行读 | 392 / 393 行读 |
| 两方向、4% 可见 Relation | 6235 行读 | 1359 行读 |
| 全隐藏 Relation 空结果 | 未在同库重复测旧实现 | 5026 行读，非固定上界 |
| 5000 评论的十条精确摘要 | 25,001 行读 | 5061 行读，仍精确扫描计数 |
| 600 无关 / 60 目标 Invitation，Project 主查询 | 直接时间索引匹配 642 行读 | 429 行读，含固定预检代价 |
| 相同 Invitation 夹具，管理员返回 20 / 60 条的完整服务 | 原逐条重复管理检查 | 均 5 次查询，831 / 1612 行读 |
| 20,000 条同项目邀请占满预检范围，Owner 首页主查询 | 无条件反向 JOIN 60,001 行读 | 180 行读 |
| 相同密集夹具，同时间戳深页 / 管理员 Project 首页 | 未在同库重复测对应旧分支 | 181 / 266 行读 |
| 密集项目结束 cursor 后全局仍有无关旧历史，空页 | 无条件反向 JOIN 40,002 行读 | 40,111 行读，反查仍随目标历史增长 |
| Invitation 同时间戳全历史第一页 / 深页主查询 | 可选 OR 无真正 seek | 21 / 21 行读 |
| Attachment 活动与墓碑第一页 / 深页主查询 | 深页前缀扫描 | 63 / 64 行读 |
| 10,000 条 Passkey 历史，第一页 | 20,001 行读 | 102 行读 |
| Notification 历史第一页 / 同时间戳深页主查询 | 深页前缀扫描 | 25 / 26 行读 |
| 同 64 个已释放 Attachment 墓碑回访 | 66 次调用，131 读 / 128 写 | 3 次调用，195 读 / 128 写 |

Cron 的调用减少伴随 64 行额外读取，写量不增加。未释放预算仍逐对象两语句原子 batch；最坏 64 个均未释放时为 3 次独立终结调用加 64 次 batch，不能将这项改善宣称为所有清理批次都满足线上调用上限。SQL 语句数与 binding 调用数分别记录。

Invitation 的无条件反向 JOIN 曾在密集项目引入全目标排序，评审反馈已用实际 D1 复现。修复后，密集成页路径从 10,000 增至 20,000 条时，Owner 首页 / 深页仍为 180 / 181 行，管理员 Project 首页仍为 266 行。预检给稀疏路径增加固定成本；若合法匹配位于预检之后，反查仍可扫描完整目标历史。特别是 cursor 已越过该项目末项而全局仍有无关旧历史时，无法仅凭预检证明项目穷尽，不宣称这种空页或所有项目页有固定读量上界。Owner 无过滤继续直接时间索引分页，不承担预检成本。

## schema 18 与写入代价

新增 [`0018_read_query_indexes.sql`](../../migrations/0018_read_query_indexes.sql)，只建以下 11 个索引并推进 schema version，不重建表、不改业务数据、不改历史迁移。manifest 从生成脚本更新，Owner recovery 的兼容支持和未来 schema 拒绝测试同步至 18。

| 索引范围 | 读取用途 | 持续维护影响 |
| --- | --- | --- |
| Workspace `(purged_at,deleted_at,display_name,id)` | 活动名称顺序、续页 | 新增、名称修改、归档/恢复、清理 |
| Credential `(principal_id,issued_at DESC,id DESC)` | 包含撤销记录的历史 | 新增；撤销不改变该索引字段 |
| Grant `(project_id,created_at,id)` | Project 完整授权历史 | 新增；撤销不改变该索引字段 |
| Administrator `(workspace_id,project_id,id)` | 对应管理范围完整历史 | 新增；撤销不改变该索引字段 |
| Invitation targets `(project_id,invitation_id)` | 按目标 Project 选邀请 | 新增/物理移除目标 |
| Invitation `(created_at DESC,id DESC)` | 同方向历史和 tuple seek | 新增；兑换/撤销不改变该索引字段 |
| 活动 Label `(project_id,name COLLATE NOCASE,id)` | 跳过墓碑、名称 seek | 活动新增/改名/软删除/恢复 |
| 活动 Relation 的 source / target `(issue_id,created_at,id)` | 两方向有序候选 | 活动新增/软删除/恢复，各维护一项 |
| Attachment 墓碑 `(issue_id,created_at,id)` | 已删除附件有序页 | 软删除/恢复、直接写入墓碑 |
| Passkey `(principal_id,created_at DESC,id DESC)` | 含撤销记录的个人历史 | 新增；撤销不改变该索引字段 |

建索引需一次读取既有表并写入索引条目，不能视为零成本；上线升级应根据目标实例实际行数评估迁移日写量。显式使用新索引的查询要求 schema 18，必须按已有升级流程先完成迁移再运行新 Worker。没有在远端应用这些索引。

[`read-query-indexes-cost.integration.test.mjs`](../../scripts/tests/read-query-indexes-cost.integration.test.mjs) 在独立合成数据库中去掉本次 11 个索引，先执行基线写入，再逐个建索引并重复同形写入。每类 1000 行，加上基线新增记录；全量索引覆盖 1001–1002 行，部分索引覆盖 500–501 行。

| 一次索引构建 | 本地行读 | 本地行写 |
| --- | ---: | ---: |
| Workspace | 2035 | 1002 |
| Credential | 2047 | 1003 |
| Grant | 2045 | 1002 |
| Administrator | 2053 | 1003 |
| Invitation targets | 2041 | 1002 |
| Invitation history | 2027 | 1002 |
| 活动 Label | 1525 | 502 |
| 活动 Relation source | 1523 | 502 |
| 活动 Relation target | 1523 | 502 |
| Attachment 墓碑 | 1522 | 501 |
| Passkey history | 2045 | 1002 |
| 合计 | 20,386 | 9023 |

| 同形业务 SQL | 无本次索引行写 | 有本次索引行写 |
| --- | ---: | ---: |
| Workspace 新增 / 改名 / 归档 | 4 / 1 / 2 | 5 / 2 / 3 |
| Credential 新增 / 撤销 | 6 / 2 | 7 / 2 |
| Grant 新增 / 撤销 | 6 / 2 | 7 / 2 |
| Project / Workspace Administrator 新增 / 撤销（各自） | 4 / 2 | 5 / 2 |
| Invitation 新增 / 新增目标 / 撤销 | 6 / 2 / 1 | 7 / 3 / 1 |
| 活动 Label 新增 / 改名 / 删除 / 恢复 | 6 / 3 / 2 / 2 | 7 / 4 / 2 / 3 |
| 活动 Relation 新增 / 删除 / 恢复 | 8 / 7 / 5 | 10 / 7 / 7 |
| 活动 Attachment 新增 / 删除 / 恢复 | 4 / 2 / 2 | 4 / 3 / 2 |
| Passkey 新增 / 撤销 | 5 / 2 | 6 / 2 |
| 26 种操作各一次合计 | 92 | 110 |

部分索引移除条目的本地 `rows_written` 增量为零，仍有物理索引维护，不能推导线上零成本。上述是典型业务 SQL 的索引成本对照，不含完整 API 的授权、计数、幂等与审计事务，也不代表真实业务频率下的总写量。

## 验证入口与保留边界

新增成本与行为回归已纳入根 `package.json`：

- [`identity-query-efficiency.integration.test.mjs`](../../scripts/tests/identity-query-efficiency.integration.test.mjs)：来源重叠、撤销、异常归属、实际 Owner 来源、归档、完整历史分页、cursor scope 与实时撤权。
- [`collaboration-query-efficiency.integration.test.mjs`](../../scripts/tests/collaboration-query-efficiency.integration.test.mjs)：5000 级数据、深页、并列、双方向稀疏/空结果、精确摘要和权限/父容器竞争。
- [`auxiliary-query-efficiency.integration.test.mjs`](../../scripts/tests/auxiliary-query-efficiency.integration.test.mjs)：附件、Passkey、通知续页，Cron 同候选成本、失败恢复、晚到 PUT 和并发预算释放。
- [`invitation-query-efficiency.integration.test.mjs`](../../scripts/tests/invitation-query-efficiency.integration.test.mjs)：稀疏 Project、10,000 / 20,000 密集历史、同时间戳深页和空页、预检 / 反查补页、重复多目标、混合隐藏目标、投影后撤销/归档/generation 变化。
- [`read-query-indexes-migration.test.mjs`](../../scripts/tests/read-query-indexes-migration.test.mjs)：旧数据/约束/视图/指纹保留、失败回滚、完整 ledger/schema 读回与拒绝重入。
- [`read-query-indexes-cost.integration.test.mjs`](../../scripts/tests/read-query-indexes-cost.integration.test.mjs)：11 个索引逐条构建成本和 26 种同形业务 SQL 写入放大。

精确 Issue 状态统计、精确摘要计数、稀疏权限匹配、title substring、密集标签匹配、全范围 cursor scope 与成员来源集合仍按实际匹配规模增长。通知缓存容量 50、提醒触发节奏、附件容量事实模型、目录交互和低频 purge 的额外索引需要分别讨论，不通过索引优化默默改变业务合同。

此前完整实现验收的 typecheck、669 项单元测试、OpenAPI / 错误合同、48 个双语公开文档页面校验、CI policy、Web / Worker dry-run 构建与产物检查通过；本次未改变相关合同与产物的部分沿用同轮证据。邀请查询评审修复后，重新通过 Worker typecheck、Worker dry-run 构建和完整 `npm run d1:check`：D1 schema / 原子操作 / Web 安全 / 本地 Wrangler migration 与 batch 校验，以及 208 项集成测试均通过。邀请成本及 scoped-management / scoped-administrators 等定向回归 24/24 通过，覆盖缺失 generation、投影后撤销与归档。文档本地链接和 `git diff --check` 通过。

独立只读复核发现并修复 Project 列表请求内范围复用的空结果边界：失去 Workspace 最后一个 Project Grant 时仍返回 404，正常 cursor 已到末尾时仍返回合法空页。后续评审发现邀请列表无条件反向 JOIN 的密集历史回归，已用上述预检与按需补页修复；修复后的实际 SQL 经独立内存 SQLite 对照，480 组混合目标、cursor、limit 与 managed scope 场景和完整过滤基准一致，未发现新的可操作缺陷。没有以本地结果宣称发行、部署或线上计量已经生效。
