# Owner Cloudflare 管理与用量历史

- 状态：Frozen
- 日期：2026-10-07
- 执行任务：[CFK-643](https://cfkanban.dev/app/issues/CFK-643)、[CFK-644](https://cfkanban.dev/app/issues/CFK-644)、[CFK-645](https://cfkanban.dev/app/issues/CFK-645)、[CFK-650](https://cfkanban.dev/app/issues/CFK-650)
- 授权依据：用户要求继续实现三项任务，明确 Token 最终保存于 Worker Secret，并选择将限定当前 Worker 的配置 Editor 授权长期保存在同一 Worker Secret，供跨设备管理；随后要求统一 Token 输入、将连接前移至概览、保存生效后缩为小卡片并逐项展示能力，简化用户文案、解释保存结果和禁用原因，以及将访问频率限制移至用量与限额。授权本地实现与验证；不包含实际创建 Token、线上迁移、Cloudflare 写入、部署、提交或推送。
- 本增量只覆盖 Owner 管理接入、下面列举的控制面操作和可选日度历史。覆盖成本保护及 Bootstrap 合同中该范围的“Web/Worker 不持有管理 Token”旧限制；其余身份、凭据、资源归属、发行与部署合同继续有效。

## 固定目标与授权

部署及升级从已批准目标注入 `CFKANBAN_CONTROL_ACCOUNT_ID`、`CFKANBAN_CONTROL_WORKER_NAME`、`CFKANBAN_CONTROL_DATABASE_ID`。首次部署将已核验工件 migration manifest 的 `schema_version` 冻结到 release，仅 schema 26 及以后注入管理目标，并在生成配置时核对已安装工件；省略或旧 schema 保持历史部署形态。页面只能读取，不能自由输入或替换目标。缺失目标的旧实例显示未接入，须通过正式升级补齐；不能从浏览器 hostname、用户名称或 Token 猜测账户。

Owner 在当前 HTTPS 实例的「管理中心 → 概览」设置一份 Cloudflare API Token，一次保存到 `CFKANBAN_API_TOKEN`。该授权用于当前 Worker 配置与已获授权的只读能力：

| 用途 | 预期最小权限 |
| --- | --- |
| 保存 Secret、变量及原生限流 | account-owned API Token 的 Specified Workers / 当前 Worker / Editor |
| 用量采集 | 当前账户 Account Analytics Read；数据集是否可用由实际读取核验 |
| 可选通知、账务能力与 Zone WAF 读取 | 当前账户 Notifications Read、Billing Read，指定 Zone 的 Zone Read / WAF Read；未实现的写操作不要求 Edit |

这些是同一连接的能力，不是三个配置步骤；逐项核验准确目标及实际能力。配置用途仍须满足 account-owned 单 Worker Editor 边界，不因统一输入自动添加权限。可选能力缺权限或供应商兼容性未确认时单独报告，不把连接整体标为全部可用，不要求为基本设置开通所有可选权限。一次只写入一个 Secret，不串行或批量保存三份副本。

运行时优先使用统一 Secret；缺失时各用途分别回退旧 `CFKANBAN_CONFIGURATION_TOKEN`、`CFKANBAN_CONTROL_TOKEN`、`USAGE_ANALYTICS_TOKEN`。保留旧接口用途和已配置 Secret，不删除或重写旧数据；旧授权仍可继续工作，页面只提供一处统一输入用于接入或替换。统一保存使用 `kind=connection`，操作分类复用既有 `configuration_secret`，非秘密 intent 记录准确 Secret 名称；操作读回按该名称核验实际 binding 及 hash，不能用统一优先解析器替旧操作确认结果。

首次连接和统一 Token 轮换均使用所输入的 Editor Token 写入自身 Secret；旧授权失效不阻塞使用有效替代 Token 恢复。旧用途接口保留其原保存方式。Editor 也能修改当前 Worker 的代码及部署，此权限边界必须在设置指引中明确。服务器验证本功能所需的操作能力及目标 DB 绑定；能力验证不等于证明该 Token 没有其他权限。

Token 只在表单的短暂内存及发送给固定 Cloudflare API 的请求中出现，最终仅保存普通 Worker Secret。不得进入 URL、浏览器存储、可恢复草稿、D1、业务审计正文、日志、命令参数、Agent 上下文或普通 CLI 操作日志。响应只返回已配置标志、能力状态与操作 ID，不返回 Token 或供应商错误正文。Cookie 写请求校验 CSRF，所有管理路由实时核验 Owner。普通参与者、Project / Workspace 管理员无此能力。

Worker 仅访问固定 `https://api.cloudflare.com/client/v4/`，限制 endpoint、HTTP method、Secret 名称、请求字段、目标及响应体大小，设置超时且不自动重试写入。不提供任意 URL 代理、上传 Worker 代码、创建 Token 或修改其他 Worker 的入口。同 Worker 的两个 Secret 不构成运行时隔离；不声称部署代码无法使用它们。

## 计划、应用与未知结果

Secret 保存是单一明确操作。限流与配置修改先产生冻结的 plan，再以 plan ID、当前版本和稳定幂等键 apply。配置白名单为 analytics 开关、history 开关、free/paid 声明、UTC 账单周期日、账户聚合开关和 cfKanban 额度贡献提醒百分比。Analytics 的账户、数据库、Worker 从固定目标派生，不能通过该接口重新定向。

限流允许分别修改 instance、principal、unauthenticated_sensitive、anonymous_login、expensive_reads，一次一个 scope；limit 是正整数，period_seconds 仅 10 或 60。保持已有 namespace ID，同步 binding 与对应非秘密 policy vars；不改变权限、结果完整性、套餐或 CPU 设置。

每次控制面写前核对实际 DB 绑定、当前单一 100% active deployment、最新版本等于 active version，以及冻结的版本/配置基线。存在未部署候选、分流、缺失绑定或漂移则拒绝，不能自动发布未知候选代码。更新完整保留其他 bindings、Secrets、limits、Cron、域名及配置，不把网页改动变成全量默认配置覆盖。

D1 保存非秘密 plan、持久操作 intent、幂等请求哈希、互斥锁及审计；Token 正文不持久化。外部 Cloudflare 与 D1 不构成原子事务，Cloudflare API 也未提供本功能可依赖的全局 CAS。服务写前登记 intent，外部请求不确定后保持 `unknown`，重试相同键只能读取或验证原操作，不能再次发起外部写。只有读回 active deployment 和预期配置后才标记 `verified`；无法证明时不显示“已生效”。无法验证的 intent 不因简单超时而释放并盲目重放。

保存响应缺失时，Owner 可通过 `GET /api/v1/admin/cloudflare/secret-operations/{request_key}` 查询本人、固定 Secret 保存路径和原 UUID 幂等键对应的单条 intent；仅返回原操作的非秘密投影。查询使用既有唯一索引，不扫描操作历史，不接管其他调用者或路径的操作。404 仅表示查询时未找到已登记记录，不证明仍在途的保存不会登记或提交；页面保持未确认与写入锁，不能采用 `latest_operation` 代替原请求。浏览器仅在当前 origin、Principal 与 Session 分区内短暂保留非秘密 key / operation ID，Token 和 body 均不恢复。

统一 Token 先写入并确认 Secret，不以统计、通知、账务或 WAF 探测成功为保存条件；确认生效后，各项能力独立探测，单项权限或供应商读取故障只更新对应状态并保留其他结果，不撤销保存或导致整页失败。身份、CAS、未知写锁和原子提交错误仍保留各自的拒绝与恢复合同。保存、确认生效与检查能力分别反馈。完整核验的 Cloudflare 403/409 保留权限或目标错误，不能归为未知结果，也不能触发 cfKanban Session 失效；预检 HTTP 故障仅投影固定请求类型、白名单方法与 HTTP 状态，供 Owner 定位失败步骤，不返回目标路径、供应商原始正文或请求头。未核验的响应、传输中断及写后无法确认才保留原请求待查。Token 已生效后的能力检查失败不撤销保存成功状态。

页面使用“保存 Token”“修改限制”“确认保存”“检查保存结果”等任务文案；保存前说明会更新当前实例的 Cloudflare 配置，不提供笼统重启按钮。Worker 无常驻进程重启语义，Secret / binding / vars 的生效通过版本及 deployment 读回证明。D1 中纯应用设置不需要重新部署。

正式升级使用当前控制面非秘密读回，保留页面修改后的限流、用量 vars、历史开关及统一与旧用途 Secret；旧本地回执不能覆盖新状态。未知 bindings 继续拒绝，不借此增量引入任意配置保留。

## 管理页面任务顺序

概览首先显示 Cloudflare 连接和能力列表，不重复展示整体能力总结或同义提示。缺少配置授权时给出一处 Token 输入、一个「保存 Token」按钮与创建指引，包括只有旧统计授权的实例，明确原统计授权的结果不能证明新输入 Token 的能力。保存并确认生效后缩为小卡片，提供「更换 Token」和折叠详情。逐项展示配置修改、用量读取、通知、账务、域名防护；绿色对勾仅表示该项实际核验通过，红色叉号表示明确拒绝或目标不匹配，未检查、缺少 Zone、暂不可用和未支持保持中性。每项常态同时展示用户能力名称和 Cloudflare 权限选择路径；绿色、红色及中性图标配合简短状态文字。悬停、键盘聚焦或点击显示授权来源、资源范围及证据边界，不将这些附加信息重复放在常态主行；配置读取不能声称已证明任意代码部署写权限，单数据集统计探测不能声称所有统计或最终账单已验证。

「用量与限额」集中展示指标、附件容量、日度历史和五组访问频率的单项修改，并提供单项统计配置、提醒、方案声明与账期设置。历史开关复用该设置入口。缺授权、尚未核验、部署目标不完整和未知操作分别说明原因，并提供连接或检查入口，不只禁用输入。预算、通知与 WAF 为低频展开内容；默认能力检查只读取核心配置与统计，`include_optional=true` 或明确展开对应区域才读取通知、WAF 和账务。默认检查可保留同一 Token 的既有可选检查结果，替换 Token 或相关 Zone 后清除不再适用的结果。隐藏重复的 Cloudflare 顶部标签，旧 `section=cloudflare` 链接兼容进入概览连接区域。

计划确认先显示管理员可理解的设置名称及变更前后值，版本、binding 与原始 JSON 收入详情。应用前明确会更新 Worker 配置，结果未知仍锁定写入并要求核验，不把页面简化变成省略计划或自动写入。

## 通知、预算与 WAF 真相

Owner 可主动读取 Notifications available alerts 和 policies；仅投影有界的 ID、名称、enabled、alert_type 及 email recipient。不能把 `limit` 等通用筛选字段推断为美元阈值，不根据静态 SDK enum 缺项断言平台没有 Budget Alerts。

截至本增量冻结，公开 Cloudflare API / OpenAPI 尚不能确认美元 Budget Alerts 的 alert_type、美元字段及更新合同。因此预算金额和邮件编辑能力为 `unsupported_contract`，展示官方 Dashboard 入口及原因，不实现猜测性的美元预算写入，也不把 cfKanban 共享额度贡献百分比称为美元预算。通知 API 403 表示当前授权不能读取，不表示没有配置预算邮件。后续只有确认准确平台合同及读回后才可增补金额/收件人编辑。

Zone WAF 主动读取核验 Zone 所属账户、目标 hostname 及规则。权限错误、未配置 Token、读取失败和确实没有规则分别显示；有效 Token 本身不证明规则启用。既有域名/规则的资源归属回执缺失是另一独立限制，不自动接管、删除或重建。域名和 WAF 写入继续使用已冻结的受限部署 plan / apply 流程；本增量不提供任意 Zone 规则编辑器。单 Worker Editor 不保证具有 custom domain 或 Zone WAF 权限。

## 可选日度历史

`USAGE_HISTORY_ENABLED` 缺省 false。只有显式开启时才按完整 UTC 日采集；复用已有附件清理的定时触发，不新增默认 Cron。没有触发器的实例可由 Owner 手动采集最近七个完整 UTC 日，一次一个日期。开启 history 不自动开启账户汇总或改变套餐声明。

新派生表按资源配置 key 和 day 唯一存储，保留 90 天。资源 key 由准确 account、DB、bucket、Worker 及 account totals 范围组成；Token、提醒百分比和套餐声明不制造无关历史分组。定时采集复用完整成功日期；显式手动刷新及失败或全未知数据重试均经过 60 秒冷却，刷新失败保留上次成功值。采集使用有界跨 isolate claim，最多两个 10 秒 GraphQL 请求，不自动重试。容量标识实际观测时间，不能把当下容量倒填为过去某天的容量。

历史请求仅读取本实例 D1 的最多 90 个日度点，返回完整日期缺口。趋势按 metric 的 key、unit、scope 及 window 分组；未知保持 null，缺日断线，不补零或拼接不同统计窗口。日度 Paid 指标查询完整 UTC 日，不复用账单月累计值冒充日值。跨账户 Billing Usage V1 数据没有 script / DB / bucket 归属，不能代替实例历史，也不能表示最终账单。

清理使用 day 索引，每次最多删除七个过期条目，涵盖旧配置；所有配置总计最多 630 行，容量检查读取该有界表，满额时优先淘汰其他旧配置，不扩张成无界历史扫描。没有开启采集时不产生供应商请求。保留期是可恢复的派生缓存选择，不能当作 Cloudflare 原生保留保证。历史是 Analytics 观测，不是 invoice，也不是费用封顶。

## HTTP 与业务表面

机器合同由 OpenAPI 生成器维护。管理目标/能力读取、验证、Zone 设置、统一及兼容用途 Secret 保存、操作读回、两类计划/应用、通知/WAF 读取及用量历史均须有 Owner 权限声明、结构化错误和 `no-store`。业务状态写使用当前 CAS、稳定幂等键及非秘密审计。供应商能力为 missing / unverified / verified / permission_denied / unavailable / target_mismatch / unsupported_contract，不能以一个布尔值合并。

Web、Skills/API 与公共 CLI 可读取同一投影，并执行相同的非秘密计划、apply、verify 及 history 采集。Cloudflare Secret 输入为明确的浏览器安全运输例外：Agent/CLI 通过既有受控 `web open` 引导 Owner 在当前实例表单输入，普通 generic API 和 CLI JSON/file 参数入口拒绝 Secret endpoint；不得为了形式上的 CLI 覆盖将 Cloudflare Token 写入普通操作日志。

验证使用隔离 SQLite / Worker 和 fake Cloudflare provider，覆盖权限/CSRF、漂移、未部署候选、幂等并发、未知结果、Secret 不入日志、限流 binding 保存、历史空值/窗口/读量及双语交互。没有实际线上 apply 授权时，本地通过不代表线上配置、邮件或 WAF 已生效。

参考：[Workers 单 Worker 授权](https://developers.cloudflare.com/workers/authorization/)、[普通 Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Worker settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)、[Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)、[Notifications API](https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/list/)。
