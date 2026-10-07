# Owner Cloudflare 管理与用量历史

- 状态：Frozen
- 日期：2026-10-07
- 执行任务：[CFK-643](https://cfkanban.dev/app/issues/CFK-643)、[CFK-644](https://cfkanban.dev/app/issues/CFK-644)、[CFK-645](https://cfkanban.dev/app/issues/CFK-645)、[CFK-650](https://cfkanban.dev/app/issues/CFK-650)、[CFK-639](https://cfkanban.dev/app/issues/CFK-639)
- 授权依据：用户要求继续实现三项任务，明确 Token 最终保存于 Worker Secret，并选择将限定当前 Worker 的配置 Editor 授权长期保存在同一 Worker Secret，供跨设备管理；随后要求统一 Token 输入、将连接前移至概览、保存生效后缩为小卡片并逐项展示能力，简化用户文案、解释保存结果和禁用原因，以及将访问频率限制移至用量与限额。用户进一步确认包含目标接入、规则集创建或复用、手工规则共存、启停、核验与恢复的完整 WAF 管理方案并要求实现。授权本地实现与验证；不包含实际创建 Token、线上迁移、Cloudflare 写入、部署、提交或推送。
- 本增量只覆盖 Owner 管理接入、下面列举的控制面操作和可选日度历史。覆盖成本保护及 Bootstrap 合同中该范围的“Web/Worker 不持有管理 Token”旧限制；其余身份、凭据、资源归属、发行与部署合同继续有效。

## 固定目标与授权

部署及升级从已批准目标注入 `CFKANBAN_CONTROL_ACCOUNT_ID`、`CFKANBAN_CONTROL_WORKER_NAME`、`CFKANBAN_CONTROL_DATABASE_ID`。首次部署将已核验工件 migration manifest 的 `schema_version` 冻结到 release，仅 schema 26 及以后注入管理目标，并在生成配置时核对已安装工件；省略或旧 schema 保持历史部署形态。页面只能读取，不能自由输入或替换目标。缺失目标的旧实例显示未接入，须通过正式升级补齐；不能从浏览器 hostname、用户名称或 Token 猜测账户。

Owner 在当前 HTTPS 实例的「管理中心 → 概览」设置一份 Cloudflare API Token，一次保存到 `CFKANBAN_API_TOKEN`。该授权用于当前 Worker 配置与已获授权的只读能力：

| 用途 | 预期最小权限 |
| --- | --- |
| 保存 Secret、变量及原生限流 | account-owned API Token 的 Specified Workers / 当前 Worker / Editor |
| 用量采集 | 当前账户 Account Analytics Read；数据集是否可用由实际读取核验 |
| 可选通知、账务能力与 Zone WAF 读取 | 当前账户 Notifications Read、Billing Read，指定 Zone 的 Zone Read / WAF Read |
| 明确启用或关闭本工具 WAF 规则 | 指定 Zone 的 Zone WAF Edit（Rulesets API 名称为 Write）；读取通过不能证明写权限 |

这些是同一连接的能力，不是三个配置步骤；逐项核验准确目标及实际能力。配置用途仍须满足 account-owned 单 Worker Editor 边界，不因统一输入自动添加权限。可选能力缺权限或供应商兼容性未确认时单独报告，不把连接整体标为全部可用，不要求为基本设置开通所有可选权限。一次只写入一个 Secret，不串行或批量保存三份副本。

运行时优先使用统一 Secret；缺失时各用途分别回退旧 `CFKANBAN_CONFIGURATION_TOKEN`、`CFKANBAN_CONTROL_TOKEN`、`USAGE_ANALYTICS_TOKEN`。保留旧接口用途和已配置 Secret，不删除或重写旧数据；旧授权仍可继续工作，页面只提供一处统一输入用于接入或替换。统一保存使用 `kind=connection`，操作分类复用既有 `configuration_secret`，非秘密 intent 记录准确 Secret 名称；操作读回按该名称核验实际 binding 及 hash，不能用统一优先解析器替旧操作确认结果。

首次连接和统一 Token 轮换均使用所输入的 Editor Token 写入自身 Secret；旧授权失效不阻塞使用有效替代 Token 恢复。旧用途接口保留其原保存方式。Editor 也能修改当前 Worker 的代码及部署，此权限边界必须在设置指引中明确。服务器验证本功能所需的操作能力及目标 DB 绑定；能力验证不等于证明该 Token 没有其他权限。

Token 只在表单的短暂内存及发送给固定 Cloudflare API 的请求中出现，最终仅保存普通 Worker Secret。不得进入 URL、浏览器存储、可恢复草稿、D1、业务审计正文、日志、命令参数、Agent 上下文或普通 CLI 操作日志。响应只返回已配置标志、能力状态与操作 ID，不返回 Token 或供应商错误正文。Cookie 写请求校验 CSRF，所有管理路由实时核验 Owner。普通参与者、Project / Workspace 管理员无此能力。

Worker 仅访问固定 `https://api.cloudflare.com/client/v4/`，限制 endpoint、HTTP method、Secret 名称、请求字段、目标及响应体大小，设置超时且不自动重试写入。不提供任意 URL 代理、上传 Worker 代码、创建 Token 或修改其他 Worker 的入口。同 Worker 的两个 Secret 不构成运行时隔离；不声称部署代码无法使用它们。

## 计划、应用与未知结果

Secret 保存是单一明确操作。限流与配置修改先产生冻结的 plan，再以 plan ID、当前版本和稳定幂等键 apply。配置白名单为 analytics 开关、history 开关、free/paid 声明、UTC 账单周期日、账户聚合开关和 cfKanban 额度贡献提醒百分比。Analytics 的账户、数据库、Worker 从固定目标派生，不能通过该接口重新定向。

限流允许分别修改 instance、principal、unauthenticated_sensitive、anonymous_login、expensive_reads，一次一个 scope；limit 是正整数，period_seconds 仅 10 或 60。保持已有 namespace ID，同步 binding 与对应非秘密 policy vars；不改变权限、结果完整性、套餐或 CPU 设置。

每次控制面写前核对实际 DB 绑定、当前单一 100% active deployment、最新版本等于 active version，以及冻结的版本/配置基线。部署与版本列表只读取当前/最新项；历史总页数大于一不表示目标不完整，不扫描全部部署历史。响应体和库存仍有界；通知等需要完整列表的用途不能复用这个分页例外。存在未部署候选、分流、缺失绑定或漂移则拒绝，不能自动发布未知候选代码。更新完整保留其他 bindings、Secrets、limits、Cron、域名及配置，不把网页改动变成全量默认配置覆盖。

D1 保存非秘密 plan、持久操作 intent、幂等请求哈希、互斥锁及审计；Token 正文不持久化。外部 Cloudflare 与 D1 不构成原子事务，Cloudflare API 也未提供本功能可依赖的全局 CAS。服务写前登记 intent，外部请求不确定后保持 `unknown`，重试相同键只能读取或验证原操作，不能再次发起外部写。只有读回 active deployment 和预期配置后才标记 `verified`；无法证明时不显示“已生效”。无法验证的 intent 不因简单超时而释放并盲目重放。

保存响应缺失时，Owner 可通过 `GET /api/v1/admin/cloudflare/secret-operations/{request_key}` 查询本人、固定 Secret 保存路径和原 UUID 幂等键对应的单条 intent；仅返回原操作的非秘密投影。查询使用既有唯一索引，不扫描操作历史，不接管其他调用者或路径的操作。404 仅表示查询时未找到已登记记录，不证明仍在途的保存不会登记或提交；页面保持未确认与写入锁，不能采用 `latest_operation` 代替原请求。浏览器仅在当前 origin、Principal 与 Session 分区内短暂保留非秘密 key / operation ID，Token 和 body 均不恢复。

所有用途的 Token 均先写入并确认 Secret，不以统计、通知、账务或 WAF 探测成功为保存条件；旧用途仍使用既有配置 Editor 写者核验目标并保存。确认生效后，各项能力独立探测，单项权限或供应商读取故障只更新对应状态并保留其他结果，不撤销保存或导致整页失败。能力检查命令整体未完成时保留已核验结果，提示本次检查尚未完成，不能将多项能力一并改判为失败；展开区域的加载和结果独立呈现。身份、CAS、未知写锁和原子提交错误仍保留各自的拒绝与恢复合同。保存、确认生效与检查能力分别反馈。完整核验的 Cloudflare 403/409 保留权限或目标错误，不能归为未知结果，也不能触发 cfKanban Session 失效；预检 HTTP 故障仅投影固定请求类型、白名单方法与 HTTP 状态，供 Owner 定位失败步骤，不返回目标路径、供应商原始正文或请求头。首次基线检查在登记 intent 前明确失败时，错误可携带 `details.write_state=not_dispatched`，表示本次 handler 未登记或发送外部写；它不是全局同 key 永无并发写的证明。浏览器在单次发送的原保存请求收到完整合法错误包及该明确证据时显示保存被拒绝并解除本次未确认状态；不自动重发 Token，不以查询 404 或任意 503 推断未写入。未核验的响应、传输中断及写后无法确认仍保留原请求待查。Token 已生效后的能力检查失败不撤销保存成功状态。

页面使用“保存 Token”“修改限制”“确认保存”“检查保存结果”等任务文案；保存前说明会更新当前实例的 Cloudflare 配置，不提供笼统重启按钮。Worker 无常驻进程重启语义，Secret / binding / vars 的生效通过版本及 deployment 读回证明。D1 中纯应用设置不需要重新部署。

正式升级使用当前控制面非秘密读回，保留页面修改后的限流、用量 vars、历史开关及统一与旧用途 Secret；旧本地回执不能覆盖新状态。未知 bindings 继续拒绝，不借此增量引入任意配置保留。

## 管理页面任务顺序

概览首先显示 Cloudflare 连接和能力列表，不重复展示整体能力总结或同义提示。缺少配置授权时给出一处 Token 输入、一个「保存 Token」按钮与创建指引，包括只有旧统计授权的实例，明确原统计授权的结果不能证明新输入 Token 的能力。保存并确认生效后缩为小卡片，提供「更换 Token」和折叠详情。逐项展示配置修改、用量读取、通知、账务、域名防护；绿色对勾仅表示该项实际核验通过，红色叉号表示明确拒绝或目标不匹配，未检查、缺少 Zone、暂不可用和未支持保持中性。每项常态同时展示用户能力名称和 Cloudflare 权限选择路径；绿色、红色及中性图标配合简短状态文字。悬停、键盘聚焦或点击显示授权来源、资源范围及证据边界，不将这些附加信息重复放在常态主行；配置读取不能声称已证明任意代码部署写权限，单数据集统计探测不能声称所有统计或最终账单已验证。

「用量与限额」集中展示指标、附件容量、日度历史和五组访问频率的单项修改，并提供单项统计配置、提醒、方案声明与账期设置。历史开关复用该设置入口。缺授权、尚未核验、部署目标不完整和未知操作分别说明原因，并提供连接或检查入口，不只禁用输入。预算、通知与 WAF 为低频展开内容；默认能力检查只读取核心配置与统计，`include_optional=true` 或明确展开对应区域才读取通知、WAF 和账务。默认检查可保留同一 Token 的既有可选检查结果，替换 Token 或相关 Zone 后清除不再适用的结果。隐藏重复的 Cloudflare 顶部标签，旧 `section=cloudflare` 链接兼容进入概览连接区域。

计划确认先显示管理员可理解的设置名称及变更前后值，版本、binding 与原始 JSON 收入详情。应用前明确会更新 Worker 配置，结果未知仍锁定写入并要求核验，不把页面简化变成省略计划或自动写入。

## 通知、预算与 WAF 真相

Owner 可主动读取 Notifications available alerts 和 policies；仅投影有界的 ID、名称、enabled、alert_type 及 email recipient。不能把 `limit` 等通用筛选字段推断为美元阈值，不根据静态 SDK enum 缺项断言平台没有 Budget Alerts。

截至本增量冻结，公开 Cloudflare API / OpenAPI 尚不能确认美元 Budget Alerts 的 alert_type、美元字段及更新合同。因此预算金额和邮件编辑能力为 `unsupported_contract`，展示官方 Dashboard 入口及原因，不实现猜测性的美元预算写入，也不把 cfKanban 共享额度贡献百分比称为美元预算。通知 API 403 表示当前授权不能读取，不表示没有配置预算邮件。后续只有确认准确平台合同及读回后才可增补金额/收件人编辑。

Zone WAF 主动读取核验 Zone 所属账户、目标 hostname 及规则。权限错误、未配置 Token、读取失败和确实没有规则分别显示；有效 Token 本身不证明规则启用。Zone 校验通过后，自定义规则集入口 404 表示尚无该规则集，读取能力仍可核验通过，同时显示本工具防护未启用；没有本工具规则不排除其他 Cloudflare 防护。保存 Token 和检查能力不创建规则集或开启防护。

### WAF 目标接入与跨设备事实

WAF 管理仍限定当前 Instance、固定 account / Worker / DB 和 D1 已批准 preferred origin 的准确 hostname；不能选择任意 Zone hostname，也不修改 DNS、Custom Domain、preferred origin 或 Passkey RP。域名切换继续使用独立受限部署计划。网页管理复用已保存的统一 Secret；缺少 WAF Edit 不阻断 Token 保存或其他能力。

启用前必须证明该 hostname 绑定准确 Worker、Zone 和 Instance。统一 Token 能读取 Workers Domains 时，服务端读取精确 hostname 的有界库存并核验 service、zone_id、domain_id 及 DB 绑定。官方当前不保证指定 Worker Editor 可读取 Custom Domains，不能把这种权限失败归为 Token 整体无效。不能读取时，由安全部署 runtime 使用既有 Cloudflare 授权在本地核验准确目标、当前 Owner 与可信 origin，再按批准计划通过 Cloudflare D1 参数化原子 batch 登记非秘密绑定证据；Cloudflare Credential 只发往 Cloudflare，不临时传给 Worker，也不自动扩权。

服务端保存绑定 ID、准确 account / Worker / DB / Instance / hostname / Zone / domain ID、origin version、供应商元数据 hash、来源、核验时间和操作 ID。登记不创建、删除或接管域名映射。Zone、origin version 或固定目标改变使旧证据失效。旧部署无需重新创建已有域名；旧工具自有规则的迁移还必须有准确私有归属回执及 live rule ID / ruleset ID / 固定 profile 读回，名称、ref 或表达式相同不能代替归属。

部署工具登记的证据是上次 Cloudflare 映射核验，不能称为当前云映射读回。每次计划、应用和验证仍核验当前服务目标；Token 无 Domains 读取能力时，使用固定 trusted preferred HTTPS origin 的专用短期服务证明，核验响应服务持有当前 Worker Secret 并绑定准确 Instance / account / Worker / DB / origin version。证明使用域分离 HMAC、随机 nonce 与短 expiry，只允许固定证明路径、不跟随 redirect，限制时间和响应体；MAC 只用于这个协议，不是任意签名服务，Token、签名和 nonce 不进入业务审计、日志、持久状态或普通 CLI 输出。schema 27+ 的发行模板和生成部署配置必须启用 `global_fetch_strictly_public`，保留完整受核验 compatibility flags，并拒绝冲突的 `global_fetch_private_origin`；证明请求须经过公网 front door，不能绕过 Cloudflare 安全规则直接请求 origin。缺证据、证明失败或目标变化时拒绝外部写入。服务证明不声称 Cloudflare 映射实时 CAS，也不能发现由拥有 Cloudflare 管理权的人恶意复制全部 Worker 配置和 Secret 的情形。

### 规则库存、共存与计划

有界完整读取 `http_request_firewall_custom` 的唯一 Zone 入口及相关 custom 子规则集，核对准确 phase / kind、规则 ID、顺序、enabled、action、expression、action_parameters 和完整分页。读取被拒绝不是不存在；只有已核验 Zone 后的准确入口 404 才可计划创建。Free profile 总容量按 Zone 的全部 custom rules 计算，保守使用五条额度，不假定子规则集、disabled 或 execute 包装免费，不自动购买或升级方案。

页面显示自动识别的入口、服务端自有规则、其他规则数量、容量、前置豁免或终止规则、可能重复及无法判断的冲突；复杂表达式交集不能保证可判定。不存在自有规则不表示不存在其他 Cloudflare 防护。本功能是精确 hostname 下缺少认证材料的私有 API 过滤，不替代应用认证、原生限流或全部 Cloudflare WAF 能力。

正常启用在已有入口末尾追加一条自有规则；没有入口时创建 `kind=zone` 的该 phase 入口并携带这条规则。不让用户任意选择无关规则集，不采用会丢失未提交规则的全规则集覆盖式 PUT。前置 Skip 可使末尾规则不执行；用户必须明确选择保留已有豁免，或批准将自有规则置于具体冲突规则之前。只改变自有规则位置，不修改其他规则的正文或相对顺序；IP Access Allow、未知表达式和无法解决的绕过不能靠改顺序声称消除。保留豁免或覆盖不完整时准确显示限制，不显示完整防护。

单个冻结 plan 包含绑定及当前目标、Token 身份摘要、准确入口 ID / 创建或追加策略、完整库存摘要、原自有规则、foreign 规则及顺序 hash、准确规则正文、插入位置、冲突选择、容量与覆盖证据。应用时重新核对；入口、规则、顺序、目标、权限或配置变化后不静默换策略，而是拒绝并要求新计划。页面首先解释保护请求及变更前后，ID / 原始 JSON 收入详情。

### 启停、未知结果与升级

D1 是跨设备 WAF 归属及操作事实源，持久记录 binding ID、准确 rule / ruleset ID、固定 ref、规则 hash、操作 ID 与核验时间。已有手工同名规则保持外部管理；不能仅凭 ref 将其显示为可修改的自有规则。明确关闭只删除已证明归属且未漂移的自有 rule，保留共享入口和所有外部规则；重新启用重新核对库存及容量。

WAF 复用 Owner、Cookie CSRF、当前 CAS、稳定幂等键、持久 intent、原子审计及控制面互斥锁。发出外部请求前持久登记 dispatch；响应未知后同 key 只读回原操作，不再次 POST / DELETE。WAF 独立 assessor 核对准确目标、预期自有 rule、位置和外部规则摘要，不依赖 Worker deployment 变化。只在读回符合原计划后记录归属和 verified；原操作的外部写已发生而目标或外部规则变化时保持待核验，不自动补偿、删除或覆盖。缺失当前规则不证明仍在途的创建不会提交。部署 runtime 在每 Instance 的有界私有文件保留原未确认 WAF dispatch，原操作之外的目标、域名和防护修改及升级均须先解除该未确认状态；不扫描全历史 journal，也不因 lookup 404 清除。只读 verify 的本轮响应丢失复用本轮键，完整未确认结果后下次恢复可生成新核验轮，但永不重发 apply。

读取状态、规则配置已核验和覆盖状态分别表达；`workers.dev`、preview、其他入口或外部豁免仍可绕过时标记覆盖不完整，不自动关闭入口或修改手工策略。正常 Web、CLI/MCP、Passkey 登录、Invite、Public Join 和同身份恢复不被本工具 profile 阻断。真实边缘行为未实测时不能把规则配置读回称为实网安全验收。

schema 27 及以后的普通升级和安全部署工具读取服务端 WAF 归属与实时规则，保留网页修改后的配置；旧私有回执只作迁移证据，不能反向覆盖服务端新状态。旧 schema 保留原受限工具路径及回执合同，不尝试不存在的新端点。Web、公共 CLI 和 Skills 使用相同 WAF plan / apply / verify 语义，部署 runtime 仅负责应用不能完成的目标证明和受控迁移，不成为另一份 WAF 规则权威。

## 可选日度历史

`USAGE_HISTORY_ENABLED` 缺省 false。只有显式开启时才按完整 UTC 日采集；复用已有附件清理的定时触发，不新增默认 Cron。没有触发器的实例可由 Owner 手动采集最近七个完整 UTC 日，一次一个日期。开启 history 不自动开启账户汇总或改变套餐声明。

新派生表按资源配置 key 和 day 唯一存储，保留 90 天。资源 key 由准确 account、DB、bucket、Worker 及 account totals 范围组成；Token、提醒百分比和套餐声明不制造无关历史分组。定时采集复用完整成功日期；显式手动刷新及失败或全未知数据重试均经过 60 秒冷却，刷新失败保留上次成功值。采集使用有界跨 isolate claim，最多两个 10 秒 GraphQL 请求，不自动重试。容量标识实际观测时间，不能把当下容量倒填为过去某天的容量。

历史请求仅读取本实例 D1 的最多 90 个日度点，返回完整日期缺口。趋势按 metric 的 key、unit、scope 及 window 分组；未知保持 null，缺日断线，不补零或拼接不同统计窗口。日度 Paid 指标查询完整 UTC 日，不复用账单月累计值冒充日值。跨账户 Billing Usage V1 数据没有 script / DB / bucket 归属，不能代替实例历史，也不能表示最终账单。

清理使用 day 索引，每次最多删除七个过期条目，涵盖旧配置；所有配置总计最多 630 行，容量检查读取该有界表，满额时优先淘汰其他旧配置，不扩张成无界历史扫描。没有开启采集时不产生供应商请求。保留期是可恢复的派生缓存选择，不能当作 Cloudflare 原生保留保证。历史是 Analytics 观测，不是 invoice，也不是费用封顶。

## HTTP 与业务表面

机器合同由 OpenAPI 生成器维护。管理目标/能力读取、验证、Zone 设置、统一及兼容用途 Secret 保存、操作读回、配置/限流/WAF 计划应用、WAF 目标登记、通知/WAF 读取及用量历史均须有 Owner 权限声明、结构化错误和 `no-store`。WAF 目标登记只接受当前版本，不接受 Token、任意目标或手工 receipt 字典。专用服务证明是机器内部、无业务写入的固定入口，普通 Web/API/CLI 不提供提交签名的通用命令。业务状态写使用当前 CAS、稳定幂等键及非秘密审计。供应商能力为 missing / unverified / verified / permission_denied / unavailable / target_mismatch / unsupported_contract，不能以一个布尔值合并。

Web、Skills/API 与公共 CLI 可读取同一投影，并执行相同的非秘密计划、apply、verify 及 history 采集。Cloudflare Secret 输入为明确的浏览器安全运输例外：Agent/CLI 通过既有受控 `web open` 引导 Owner 在当前实例表单输入，普通 generic API 和 CLI JSON/file 参数入口拒绝 Secret endpoint；不得为了形式上的 CLI 覆盖将 Cloudflare Token 写入普通操作日志。

验证使用隔离 SQLite / Worker 和 fake Cloudflare provider，覆盖权限/CSRF、漂移、未部署候选、幂等并发、未知结果、Secret 不入日志、限流 binding 保存、历史空值/窗口/读量及双语交互。WAF 增量覆盖空入口创建、共享入口追加、手工同名不接管、前置 Skip / 未知表达式 / IP Access 豁免、总容量、准确自有规则启停、跨设备和旧部署接入、计划后外部变更、dispatch 后未知结果不重放、归属与审计原子提交、目标证明失败以及升级保留。没有实际线上 apply 授权时，本地通过不代表线上配置、邮件或 WAF 已生效。

参考：[Workers 单 Worker 授权](https://developers.cloudflare.com/workers/authorization/)、[公网 fetch 兼容开关](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)、[普通 Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Worker settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)、[Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)、[Notifications API](https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/list/)。
