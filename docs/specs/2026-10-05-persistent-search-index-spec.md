# 持久搜索索引增量 SPEC

- 状态：Draft；用户于 2026-10-05 授权先记录详细 backlog，再在 `feat/v1.9` 实现和隔离验证
- 执行入口：[CFK-605](https://cfkanban.dev/app/issues/CFK-605)，执行卡 [CFK-606](https://cfkanban.dev/app/issues/CFK-606) 至 [CFK-610](https://cfkanban.dev/app/issues/CFK-610)
- 基础：[Foundation](2026-08-26-agent-native-kanban-foundation-spec.md)、[API / Schema](2026-08-28-api-schema-spec.md)、[本地 MCP](2026-10-02-local-mcp-dsh-spec.md)、[Issue 引用](2026-10-05-codex-issue-mentions-spec.md)

本增量直接采用本地 SQLite 持久化，覆盖编号和标题搜索，不增加正文或评论检索。它明确覆盖旧 mentions Draft 的编号限定、不保存标题索引及禁止搜索同步的范围。HTTP 请求仍按 Service 当前身份、权限及 Session scope 授权；本地候选的时效性由用户本轮确认的缓存策略定义。

## 候选与授权

候选搜索只核验当前环境私有实例与 Principal 绑定并查询本地 SQLite，不发送 HTTP，不等待后台同步，不在每次输入前远端核权。候选只是最后一次成功同步的非秘密标题投影，不证明当前权限；撤权、删除或改名可能在下一次成功同步前仍显示旧候选。选中后的 `resources/read` 与业务操作必须实时核验身份、权限、真实目标和容器状态；拒绝不能解释为无匹配或换身份重试。

本地身份、可信 origin 或 origin_version 改变时不能继续使用旧绑定。不同实例和 Principal 分别存储。多实例歧义明确要求可信 canonical 链接，不遍历实例，不从 cwd、最近工作台或未经验证的聊天信息猜范围。索引同步仅在已选择的实例内读取当前授权范围；状态响应明确回显范围，不能把同步得到的项目清单当作当前 ACL。

## 本地存储与生命周期

- 私有路径：`.cfkanban/search-index/<instance_id>/<principal_id>/index.sqlite3`。沿用实际执行环境自己的用户目录和 ownership/mode/Windows ACL 检查，拒绝同步目录、symlink、hardlink 或权限不安全的现有文件。目录和数据库分别使用 0700/0600 或等价 ACL。
- 使用 Node 内置 `node:sqlite`，同步数据库 API 放在专用 Worker；保持 Node `>=22.12.0`，必要兼容 flag 只作用于 Worker。固定预构建入口、摘要和完整文件集合一并分发；启动不下载、不编译、不调整全局工具。
- 只保存稳定事项 ID、编号、标题、归属、容器名称、独立搜索 revision、projection/schema 版本、opaque cursor 和同步租约。Credential、正文、评论和 ACL 不进入数据库。
- 默认 rollback journal、短事务、有限 busy timeout。多进程通过 SQLite 租约、递增 fencing 和预期 cursor CAS 取得唯一同步权；网络 I/O 在事务外。迟到或失去租约的进程不能提交页面。
- 每页数据 upsert/remove 与 cursor 推进在同一事务中完成。首次快照写 staging generation，追平增量后原子切为 active；未完成的数据不参与搜索。
- 首次尚未 ready 返回明确的准备中状态，不把空候选当作无匹配，不退回每次输入远端搜索。重启复用已有数据库；网络失败可保留已完成的标题候选，详情仍实时核权。
- 后台状态读取逐项目比较授权范围：新获权项目完整下载已有事项快照，再追平增量，即使近期没有任何事件也必须补齐历史；Workspace 授权按实际增加的项目展开。范围减少时清理失效项目；未变化项目保留原游标继续增量。身份绑定变化则隔离旧 DB。损坏或容量超限明确报错；仅对已验证自有缓存安全重建，不修改凭据状态，不把部分索引声称为完整索引。

## 同步时机

MCP 初始化后，一个明确的本地实例可启动后台同步。搜索活动期间每 30 秒检查增量，连续 5 分钟未搜索则停止；再次搜索恢复后台任务，当前查询不等待它。本机成功创建事项或修改标题等索引字段后合并触发后台刷新；纯正文、评论、状态或优先级变化不触发标题刷新。关闭 MCP 后释放定时器、在途同步和 Worker。

相同实例/Principal/scope 的任务合并，跨进程由 SQLite 租约协调。同步自身有有限请求、分页和时间预算，可从最后提交的 cursor 续接；不得以全历史轮询或每个按键全量下载维持新鲜度。暂时网络失败使用受控重试，不无限积累任务。

## Service 投影与游标

新增只读 `issue_search_index` capability 与三个路径：

| 路径 | 范围与结果 |
| --- | --- |
| `GET /api/v1/search-index/status` | 显式项目过滤，或显式 `allow_unfiltered=true` 选择当前实例内授权范围；返回 projection 版本、epoch、scope key、容器元数据和各项目搜索 revision / 初始 cursor |
| `GET /api/v1/search-index/snapshot?project=UUID` | 一次一个明确项目，编号稳定 keyset 分页，每页最多 100 个轻量事项；可从 status 的初始 cursor 开始 |
| `GET /api/v1/search-index/changes?project=UUID&after=CURSOR` | 一次一个明确项目，返回相关 upsert/remove、独立实体 revision、后续 cursor 和 has_more |

状态中的项目包含 `id`、`display_name`、`workspace:{id,display_name}`、独立搜索 `revision` 和 opaque `cursor`。事项投影包含 `id`、`number`、`identifier`、`title`、`project_id` 和独立实体 `revision`；增量另带 `kind:upsert|remove`。容器名称通过状态同步，改名不向所有子 Issue 扇出写入。公开整数保持 JavaScript safe integer 范围。

搜索投影和相关变化在既有业务原子操作内维护，排序基础复用 `events.sequence`。原始事件序号不作为普通公开字段；外部 cursor 绑定实例、Principal、所选项目、Session target、epoch 与 projection 版本。其他项目获权或撤权不使未受影响项目的游标失效；所选项目每次请求仍实时核权。客户端保存并回传 cursor，不解析、不自增、不把随机 UUID 当作排序位置。独立实体搜索 revision 用于拒绝迟到覆盖，不能用普通 Issue version 代替。

创建、实际标题变化、删除或恢复改变事项搜索投影；只修改正文、评论、状态、优先级等不改标题索引。变化读取使用专门的项目/顺序索引，不从普通 events 全历史逐条筛选。每个项目保留最近 10,000 条相关变化，超过保留边界明确要求重新取快照；清理应有界，不每次扫描计数全历史。同一批次同一实体合并最终状态。空变化可以返回新的已确认水位，不要求重新下载 Issue。

首次同步按“先取增量水位 → 编号稳定扫描 → 增量追平”执行，不声称多个 HTTP 分页构成同一时刻的数据库快照。增量携带的实体搜索 revision 防止较旧变化覆盖扫描中读到的较新事项；删除也保留足够 revision，避免迟到 upsert 复活。scope/epoch/保留边界变化明确拒绝旧 cursor并重建，不静默漏数据。

每次 HTTP 查询执行当前 Principal/Credential/Session、有效 Grant、活跃容器和 Cookie target 校验，查询后再核验变化；Issue-scoped Cookie 不得扩大为整个项目。隐藏项目活动不改变可见项目的搜索 revision。现有 API 列表/详情和 CLI 语义保持不变；新接口是同步载体优化，不新增业务权限。

## 后续正文和评论

[CFK-611](https://cfkanban.dev/app/issues/CFK-611) 仅记录后续方向，本轮不实现。未来需提升 projection / 本地 schema 版本、补齐历史正文或评论，再继续相应增量；不能仅放开过滤就宣称已具有之前跳过的数据。既有顺序基础和稳定实体 ID 可继续使用，缓存预算、内容保护及结果呈现另行定义。

## 验证

保护 cold/warm、重启、中断、cursor 原子性、租约接管、跨进程、snapshot/delta 交错、删除恢复、权限和 Session scope、身份切换、unsafe 文件、容器改名和保留过期。证明候选无 HTTP，正文/评论不增加标题同步，idle 停止，选中后实时拒绝无权事项。记录本地 D1 rows_read/rows_written、响应大小、请求次数和 SQLite 延迟；隔离数据不作为线上计费证据。真实 Codex 显示与其他 OS/最低 Node 环境按实际验证记录，不以 mock 或单机运行替代。
