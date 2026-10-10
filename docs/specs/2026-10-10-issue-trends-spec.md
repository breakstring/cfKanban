# Issue 趋势与里程碑完成进度

- 状态：Frozen
- 日期：2026-10-10
- 执行任务：[CFK-715](https://cfkanban.dev/app/issues/CFK-715)
- 确认依据：用户授权实施 CFK-715，确认第一版提供项目/工作区未完成存量、每日新增/完成，以及里程碑总范围/完成燃起图，并选择回填已有可恢复历史。
- 维护修订：[CFK-730](https://cfkanban.dev/app/issues/CFK-730)，用户于 2026-10-10 授权将首次回填与小时维护分离，连续执行有界小批次并记录实际用量。本修订适用于 schema 30；schema 29 已发行的小时回填行为保留为历史合同。
- 界面与范围修订：[CFK-731](https://cfkanban.dev/app/issues/CFK-731)，用户于 2026-10-10 确认工作区趋势合并至设置标签、只向工作区管理员开放并汇总全部未归档项目；取消项目子集与每日数值展开，里程碑图保留 burn-up 口径并命名为完成进度。工作区描述使用 schema 31；维护 runtime 明确支持 schema 30 / 31 并核对同版本 receipt、不可变 Service 与真实目标，schema 30/31 首次安装采用 [Bootstrap 的 migration 投影合同](2026-08-28-agent-skills-bootstrap-spec.md#731-schema-3031-首次部署-migration-投影)，缺失完整新计划仍拒绝。
- 上游：Foundation、API / Schema、项目里程碑、Web UI、公共 CLI、容器清理及事件历史合同。

## 1. 第一版范围

项目趋势统计该项目，沿用项目 reader 权限。工作区趋势仅向具有本工作区管理范围的实例 Owner / 工作区管理员开放，汇总工作区全部当前未归档项目，不接受项目子集。普通成员及项目管理员不能读取工作区汇总。工作区路径不扩大 Owner 或局部管理员的固定 Project Session；固定 Issue target 的 Session 不提供项目或工作区聚合，Web 隐藏其趋势入口。返回真实全项目集合，不静默截断或以部分项目代替工作区。

提供三类图：

1. 项目/工作区的未完成存量折线。
2. 项目/工作区的每日新增与完成次数折线。
3. 单项目、单里程碑的总范围与当前已完成存量燃起图。

五状态分布图和理想燃尽线不属于第一版。里程碑无目标日期时仍可显示实际趋势；不以创建日期或当前目标日期伪造历史计划基线。

## 2. 统计口径

按 UTC 日分桶，缺省最近 30 日，允许 1–365 日，包含当日。当日为尚未结束的统计窗口，所有入口明确标注 UTC。父子事项各自计一件，关系不传播归属或改变计数；不是工时、故事点或交付价值估算。

- `total`、`done`、`canceled` 为当日结束时的未软删除 Issue 存量；当日使用读取时的真实存量。
- `unfinished = total - done - canceled`，即 backlog、todo、in_progress 的和。
- `created` 是该日创建 Issue 的次数，恢复和移入里程碑不是新增。
- `completed` 是该日真实进入 done 的完成操作次数。重开后再次完成分别计数，不能与当前 done 存量混用。
- `reopened` 是从 done 回到非终态的次数；取消与完成分开。
- 删除/恢复改变存量，不能伪装成新增或完成。里程碑加入、移出或更换改变历史范围；完成次数按操作发生时的归属计算。

没有发生变化的已覆盖日期是 0 次操作、延续此前存量。历史缺失使用 null 和折线断点，不能当作 0；工作区中任一实际纳入项目缺失该日数据时，对应汇总指标也是 null，不以已知子集代替完整汇总。

## 3. 历史回填

现有 Issue 创建事件的初始状态字段从里程碑版本起才保存；更早的状态更新事件存在缺少旧/新状态的版本。可通过真实当前状态和有完整字段的事件链推导部分旧历史，但不能无条件保证完整回填。永久删除的项目数据已不可恢复。

首版分批重建可校验的已有历史，无法恢复的区段保留缺失标记。迁移原子冻结当前 Issue 状态和 Event 水位，实时写入继续记录水位之后的操作；回填只处理冻结的旧事件。每个 Issue 按 sequence 倒序有界读取，批次使用 CAS 和事务内标记保护所有派生写入，重复执行或并发争用不能重复计数。回填完成后才公开经过校验的历史覆盖范围。

schema 30 起首次回填由独立的本地 Node 维护流程执行，小时 Cron 不再读取或重放历史队列。部署计划仍显式冻结并读回 `17 * * * *`；该触发器只处理既有附件清理与按日防重的可选用量历史维护，不要求启用 R2。附件定时清理最多 8 个对象，用量历史最多 9 次调用及 4 次余量，共享 50 次 subrequest 上限；5 秒后不启动新维护工作，已发出的操作等待结果。新部署、升级和已有部署接入按实际 schema 核对 schedule，计划外触发器拒绝覆盖。schema 29 保留原有每小时 3–8 个 Issue 批次的回填行为，schema 28 及更早保留其原 schedule 合同。

维护入口为部署 Skill 的 `maintenance trends inspect/plan/run` 和公共 CLI 的 `deploy trends inspect/plan/run`。`inspect` 与 `plan` 只读；`run` 是部署控制面中专用于派生投影的受控写入，不新增 Web/API 写入口，也不改变 Issue、Event、Grant 或领域权限。Web、日常 Skills/API 与 MCP 继续只读历史覆盖信息；Web 不持有本机或 Cloudflare 凭据。

当前维护入口使用带固定 Worker deployment/version 证据的已验证升级 receipt；全新 schema 30 实例没有冻结旧历史队列，无需首次回填，bootstrap receipt 不满足此入口。计划固定已验证的私有升级 receipt、不可变 Service bundle 的完整 tree/工件摘要及回填算法版本，并绑定可信实例/origin、当前 Owner、准确 Cloudflare account/profile、Worker deployment/version、D1 UUID 和 真实 schema 30 或 31，receipt、Service manifest、健康检查及数据库元数据必须与计划目标版本一致；升级至 31 后使用新的升级 receipt 与相应不可变 Service 重新计划，不复用旧 schema 30 计划，也不提升既有预算。执行前重新核验本地来源、远端身份、绑定、版本及 migration ledger；不能从浮动源码加载算法、覆盖目标或提供任意 SQL。算法版本 1 在本地 Node 重放每个 Issue 的最多 100 个 Event，仅投影必要事件字段；按冻结水位倒序推进，游标不能原地循环。

默认单次计划预算为：每批最多 8 个 Issue 页、最多 1000 页、最多 30 分钟、最多 3000 次 provider 请求，请求间隔至少 500ms，D1 读取 250000 行、写入 50000 行。预算只能减少工作量或放慢请求；开始下一页前保守预留读取 4000 行、写入 1000 行及控制请求。计划前核对当前账户用量和剩余额度，预算不代替账户其他流量的计费核验。到达预算、429、实际用量元数据缺失、队列无进展或目标漂移时停止，保留原计划和进度，不自动循环追赶。

同机私有 lock、跨机 D1 120 秒 lease 与递增 fence 共同限制并发。每页用稳定 batch ID 和原 Issue version/cursor 做 CAS；一条 SQL 的触发器在同一原子单元内写入日投影、推进队列并更新完成覆盖。过期 lease、旧 fence、重复提交及 CAS 争用不得重复计数，不依赖远程多条 SQL 请求的事务假设。每批记录 D1 返回的实际 `meta.rows_read`、`meta.rows_written`、SQL 耗时、provider 请求数和前后待处理数量，并单独记录本地 Node CPU；它不是 Worker CPU。journal 不保存 Event 正文、Credential 或 SQL 参数。响应不确定时先按原 batch ID 读回是否提交；用量仍未知就停止，不换键或盲目重放。长任务每次控制请求前通过既有安全 Wrangler 入口读取固定 profile 的当前凭据，不启动登录或扩大权限。失败记录只保留错误码、HTTP status 与平台数值 codes。公共 CLI 的 `operation recover` 对原回填只做读取：核验原 receipt/plan/journal、同一 fence、已失效租约、控制记录及原 job version/cursor，确认提交或未提交后解除本机 pending 阻塞，不重放任何历史写入。缺失用量继续明确标注，并按固定查询的保守读写上限预留；核对账号用量后另建有限计划继续，不篡改原失败 receipt。

平台限制在 2026-10-10 核对：[D1](https://developers.cloudflare.com/d1/platform/limits/) Free 为 50 queries/invocation，[Workers](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) Free Cron CPU 为 10ms。首次回填计算不占用 Worker Cron CPU；实际 D1 用量和账户 Analytics 仍需分别读回，不能把 Node CPU 或共享请求预算当作生产 Worker CPU / 账单证明。

历史回填不能放在每次趋势 GET 中，也不能由 Web 拉取所有 Issue 或全部事件完成；不能用 Issue.updated_at 推断完成时间。Event sequence 用于状态链处理，真实事件时间用于日期分桶，不假设两者顺序一致。不能可靠验证的旧状态、缺少创建事件及时间异常按保守缺损处理；历史缺损不能因后台重试而伪装成完整。

队列清空仅表示冻结的历史已处理完。不可恢复的旧事件仍保留 `partial`、不同的存量/操作覆盖起点及图表 null 断点，不能将“待处理为零”报告为所有历史完整。

## 4. 服务端与读取边界

服务端维护按项目、按日的派生投影，里程碑使用同一口径。派生变化须与真实 Issue 操作处于同一原子单元；CAS 拒绝、配额拒绝、事务回滚和幂等重放不得重复统计。仅标题、正文、优先级等无关修改不额外写趋势计数。

读取从当前真实存量逆推所选窗口内的日变化，不扫描窗口之前的所有累计历史。提供两个独立只读 GET（工作区 GET 要求工作区管理权限）：

| Path | 参数 | operationId |
| --- | --- | --- |
| `/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/trends` | 单值 `days`（默认 30，1–365）；可选同项目 `milestone` UUID | `getProjectIssueTrends` |
| `/api/v1/workspaces/{workspace_id}/issues/trends` | 同一 `days`；工作区全部未归档项目，最多 100；超过上限显式拒绝 | `getWorkspaceIssueTrends` |

未知参数、重复单值参数、非法范围及跨 scope 项目或里程碑均拒绝；超过项目上限报错，不静默截断。响应含 `timezone=UTC`、`from_date`、`to_date`、`observed_at`、实际 `scope`、项目的 `stock_from` / `flow_from` 与 `history_state=pending|complete|partial`，以及每日 `total` / `done` / `canceled` / `unfinished` / `created` / `completed` / `reopened`。指标为非负安全整数或 null，存量与日变化来自一致数据库视图。

工作区授权查询先按工作区收窄，继续核验当前认证、容器、有效 Grant 与固定 Session scope。聚合 SQL 保留实时权限谓词；返回前复核实际项目集合，范围漂移拒绝旧结果。响应公开日期窗口、UTC、观测时间、实际范围及覆盖起点，不暴露内部事件水位。

归档项目不进入当前工作区汇总，项目恢复后重新进入；图表描述的是当前所选项目的历史。Project purge 与既有业务历史一并清除派生统计，不能通过工作区图表继续读取其历史。

## 5. Web、Agent 与 CLI

项目页在看板、列表、里程碑旁增加趋势入口；里程碑提供查看自身完成进度的入口（burn-up 口径）。工作区趋势位于工作区设置的「趋势」标签，仅实例 Owner / 本工作区管理员可见；工作区选择入口只提供「工作区设置」。旧工作区趋势 URL 进入同一设置页。

页面异步加载，沿用项目全宽布局和主题，不引入新的图表依赖。SVG 折线共享 Y 轴、图例、日期轴和数值查看，通过悬浮及键盘逐日聚焦提供日期和数值，不再提供每日数值展开表格；键盘可操作。界面支持 English / 简体中文，以及加载、空范围、缺失历史、读取失败与重试。切换项目、身份或 Session 后丢弃旧数据与迟到结果。

API、CLI 和 Skills 使用相同时间窗口、覆盖信息和统计语义；MCP 的固定项目绑定不能被工作区趋势扩大。公开双语文档说明当前范围、完成次数与存量的区别、时区及历史边界。

## 6. 验收

使用隔离本地数据覆盖空项目、零变化日、创建/完成/取消/重开、重复完成、软删除/恢复、父子独立计件、里程碑范围变化、UTC 跨日、缺失日期、当前未结束日、聚合缺损、权限交集与撤销、固定 Session、归档/恢复/purge、CAS/幂等/回滚和历史起点。

数据库验收记录代表性规模的读取行数、写入行数及查询计划；时间窗口和 LIMIT 本身不证明读量有界。Web 验证响应式、键盘、双语、异步结果隔离及现有构建预算。最终执行相关合同、D1、类型和构建检查。

首次回填维护还须覆盖 schema 29→30 兼容、单语句投影事务回滚、CAS 重放、过期 lease/旧 fence/跨机争用、不可变来源及目标漂移拒绝、预算与请求限速、未知响应读回、缺失实际用量即停止、空队列与无进展，以及 Cron 不再重放历史。线上验收记录队列前后变化、实际读写用量、覆盖/缺损和部署 schedule；不向线上注入测试故障。

本卡源码实施与本地验收不包含 Git commit/push、发行、线上 migration 或部署。
