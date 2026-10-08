# Owner Cloudflare 管理与用量历史

- 状态：Frozen
- 日期：2026-10-08
- 执行任务：[CFK-643](https://cfkanban.dev/app/issues/CFK-643)、[CFK-644](https://cfkanban.dev/app/issues/CFK-644)、[CFK-645](https://cfkanban.dev/app/issues/CFK-645)、[CFK-650](https://cfkanban.dev/app/issues/CFK-650)、[CFK-639](https://cfkanban.dev/app/issues/CFK-639)
- 授权依据：用户确认将 Owner 概览收敛为只读信息，把统一 Token、用量、历史与访问频率集中到用量与配额；输入 Token 后仅需一次保存，核验、能力检查与各区加载由系统自动完成；移除 WAF 和预算通知功能，并保留已安装版本的安全升级与历史操作恢复。进一步确认按「Token → 统一用量与访问设置 → 数据」组织页面，以常驻表单、草稿差异和一次保存替代逐项弹窗，执行任务为 [CFK-669](https://cfkanban.dev/app/issues/CFK-669)。授权本地实现与验证，不包含实际创建 Token、线上迁移、Cloudflare 写入、部署、提交或推送。
- 本增量覆盖 Owner 管理接入、以下控制面操作和可选日度历史。覆盖成本保护及 Bootstrap 合同中该范围的“Web/Worker 不持有管理 Token”旧限制；其余身份、凭据、资源归属、发行与部署合同继续有效。

## 固定目标与授权

部署及升级从已批准目标注入 `CFKANBAN_CONTROL_ACCOUNT_ID`、`CFKANBAN_CONTROL_WORKER_NAME`、`CFKANBAN_CONTROL_DATABASE_ID`。首次部署将已核验工件 migration manifest 的 `schema_version` 冻结到 release，仅 schema 26 及以后注入管理目标，并在生成配置时核对已安装工件；省略或旧 schema 保持历史部署形态。页面只能读取，不能自由输入或替换目标。缺失目标的旧实例须通过获准升级补齐；不能从 hostname、用户名称或 Token 猜测账户。

Owner 在当前 HTTPS 实例的「管理中心 → 用量与配额」顶部输入一份 Cloudflare API Token，点击「保存」，一次写入 `CFKANBAN_API_TOKEN`。正常功能只要求以下两组能力：

| 用途 | 预期最小权限 |
| --- | --- |
| 保存 Secret、变量及原生限流 | account-owned API Token 的 Specified Workers / 当前 Worker / Editor |
| 用量采集 | 当前账户 Account Analytics Read；数据集是否可用由实际读取核验 |

配置用途仍须满足 account-owned 单 Worker Editor 边界，不因统一输入自动扩权。Editor 同时包含当前 Worker 代码与部署修改权，设置指引必须明确。配置读取通过只证明已核验读取与目标 DB 绑定，不能声称已证明所有写权限；实际保存另核验所需写权限。单数据集检查不能证明所有统计或最终账单可用。常规连接不请求 Notifications、Billing、Zone 或 WAF 权限。

运行时优先使用统一 Secret；缺失时按原用途回退 `CFKANBAN_CONFIGURATION_TOKEN`、`CFKANBAN_CONTROL_TOKEN`、`USAGE_ANALYTICS_TOKEN`。保存统一授权不删除或重写旧 Secret，旧用途接口及历史操作仍兼容。统一保存使用 `kind=connection`，操作分类复用 `configuration_secret`；非秘密 intent 记录准确 Secret 名称，读回按该名称核验 binding 及 hash，不能用统一优先解析器替旧操作确认结果。

首次连接和 Token 轮换均使用本次输入的 Editor Token 写入自身 Secret；旧 Token 缺少写权限或失效不阻塞有效替代 Token。旧用途接口保持原保存方式。网页无法完成保存时，就地给出恢复路径：Cloudflare → Workers & Pages → 当前 Worker → Settings → Variables and Secrets，将 `CFKANBAN_API_TOKEN` 添加或替换为 **Secret 类型**，然后 Deploy。返回页面后自动重新核对，不把空输入框或旧能力缓存视为尚未保存的证据。

Token 仅在表单短暂内存、当前实例专用 HTTPS Secret 接口及固定 Cloudflare API 请求中运输，最终保存于普通 Worker Secret。正文不得进入 URL、浏览器存储、可恢复草稿、D1、业务审计、日志、命令参数、环境变量或 Agent 普通上下文。响应只返回已配置标志、能力状态与操作 ID。Cookie 写请求校验 CSRF，管理路由实时核验 Owner；普通参与者及 Project / Workspace 管理员无此能力。

控制面请求仅发送到固定 `https://api.cloudflare.com/client/v4/`，限制 endpoint、method、Secret 名称、字段、目标和响应体，设置超时且不自动重试外部写入。不提供任意 URL 代理、上传代码、创建 Token 或修改其他 Worker 的入口。同 Worker 的多个 Secret 不构成运行时隔离。

## 保存、计划与未知结果

Secret 保存是一个独立明确操作。统一设置先生成一个冻结 configuration plan，再以 plan ID、当前版本和稳定幂等键 apply。`POST /api/v1/admin/cloudflare/configuration/plan` 的 `settings` 接受 analytics 开关、history 开关、free/paid 声明、UTC 账单周期日、账户聚合开关及可选 `rate_limits`；只提交修改字段，至少一项，不接受未知字段或新的 `warning_percent` 设置。旧值、已登记操作和旧配置读回保留兼容，不在无关修改时新建提醒变量。账户、数据库和 Worker 从固定目标派生，不能重新定向。

`rate_limits` 是 instance、principal、unauthenticated_sensitive、anonymous_login、expensive_reads 的非空子集；每个 scope 只接受正安全整数 `limit` 与 10 或 60 的 `period_seconds`。保持 namespace ID，同步原生 binding 与非秘密 policy vars；不改变权限、结果完整性、套餐、CPU 或固定查询并发设置。旧单 scope plan/apply 继续兼容。统一计划的 `before` / `after` 保留五项统计字段；仅当请求限流时增加 `rate_limits`，只含此次请求的 scope。一次保存使用一个 intent、一个 CAS 和一次 Worker settings PATCH，覆盖同一 Worker 的配置变更；不形成任意资源 batch 接口。

每次 Worker 配置写前核对实际 DB 绑定、单一 100% active deployment、latest 等于 active，以及冻结的版本和配置基线。部署与版本列表只读当前/最新项，不扫描全部历史；完整规则库存不能复用这一分页例外。未部署候选、分流、缺失绑定或漂移均拒绝，不自动发布未知代码。完整保留其他 bindings、Secrets、limits、Cron、域名及配置。

D1 保存非秘密 plan、持久 intent、幂等请求哈希、互斥锁及审计；Token 正文不持久化。Cloudflare 与 D1 不构成原子事务，不能假定供应商提供全局 CAS。写前登记 intent，外部结果不确定则保留 `unknown`；同 key 只能读取或核验原操作，不再次外部写入。只有 active deployment 和预期配置读回符合原请求才标记 `verified`。未知 intent 不因超时而清锁或重放。

保存响应缺失时，用 `GET /api/v1/admin/cloudflare/secret-operations/{request_key}` 精确查询本人、Secret 保存路径及原 UUID key 的单条 intent；使用已有唯一索引，不扫描历史、不接管其他调用者。404 只表示当次未找到，不能证明在途保存不会提交，也不能用 `latest_operation` 替代原请求。浏览器仅在当前 origin、Principal 与 Session 分区短暂保存非秘密 key / operation ID，Token 和 body 均不恢复。

统一配置 apply 响应缺失时，使用 `GET /api/v1/admin/cloudflare/configuration/operations/{request_key}`，按当前 Owner、configuration apply 路径、kind 和原 key 精确核验同一 intent；key 沿用原幂等合同以支持旧 CLI key。响应复用 operation 投影，404 同样不能证明未提交。Web、Agent 与公共 CLI 均可沿原 key 查询，再核验原 operation，不能创建替代 apply。

完整合法的明确拒绝与未知结果分别处理。已确认 Cloudflare 403/409 保留权限或目标错误，不导致 cfKanban Session 失效；预检错误仅投影白名单请求类型、method、HTTP 状态及 request ID，不返回供应商正文或请求头。登记 intent 前失败可返回 `details.write_state=not_dispatched`，只说明本次 handler 没有登记或发送外部写，不证明全局不存在同 key 并发请求。浏览器只有收到原保存请求的完整合法错误及该证据时，才显示拒绝并解除本次未确认状态；不依据 lookup 404 或普通 503 推断未写入。

保存成功、等待确认和能力不可用分别反馈。完整原响应为 `configuration_secret` / `unknown` / `secret_readback_pending` 且包含结果版本与 deployment 时，系统自动另发请求核验原操作；旧 handler 仍持有旧 Secret，独立读回才可确认新值。有限重试只用于状态查询、原操作核验和读取能力，不重发 Token 或 apply。恢复始终沿用原操作和幂等语义；无法证明时保留锁及准确状态。Worker 没有常驻进程重启语义，Secret / binding / vars 通过版本与 deployment 读回证明生效；纯 D1 应用设置无需部署。

确认保存后自动独立检查配置与 analytics，并加载各区数据；某项失败不撤销保存、不覆盖其他已核验结果、不阻塞整页。能力快照在 `capabilities_json` 内绑定凭据和固定目标的非秘密身份摘要，摘要不进入公开投影或审计；Dashboard 替换 Secret、固定目标变化及无摘要旧快照均失效。相同 Token 在供应商侧增减权限仍需重新检查，页面进入或返回焦点时按有限冷却更新，不依赖用户手动检查。

## 管理页面任务顺序

「概览」只显示实例、工作区、项目、成员、用量摘要及管理入口，不承担 Token 或其他编辑表单。「首页实例说明」移至「实例设置」；版本和自动升级公告设置在「版本与更新」。旧 `section=cloudflare` 兼容进入用量与配额。

「用量与配额」依次呈现：

1. **Token 与能力状态。** 顶部始终保留空密码输入框和「保存」按钮。已有统一或配置/统计兼容授权时持续显示「Token 已保存」，输入提示新值可替换、留空保留；不显示原 Token、不用伪造掩码冒充已读取值。提交后清空输入，失败也不恢复草稿。状态使用图标和文字，权限路径、范围、证据边界及手工恢复步骤按需展开。
2. **统一用量与访问设置。** 常驻面板集中展示五项统计/口径字段和五组访问频率，各项有用途、当前值和新值。输入只改变当前页面草稿；仅列出有变化的前后值，底部一处「放弃修改」与「保存 N 项修改」。保存自动串接 plan 与 apply，前后值及版本符合草稿基线才继续，不再逐项弹窗或重复确认。远端变化时保留草稿并拒绝自动套用；未知结果保留原 key，不自动重发。账户汇总与历史须显式开启，套餐声明不购买方案。附件存储上限是独立 D1 应用设置，保留原入口。
3. **当日用量、每日历史与其他数据。** 同页连续呈现 UTC 当日指标和完整 UTC 日趋势；容量标为观测值。已有配置时自动加载，无需重新保存。没有数据时给清楚空状态并指向上方设置；数据详情只展示统计口径、账期及观测时间，不再散布设置按钮。版本、binding 和 JSON 放在详情。

保存后的核验、权限检查和分区加载由系统承担，不再提供「检查连接」「重新检查」「读取历史」「采集所选日期」或「刷新用量」等流程按钮。打开页面、成功保存或返回页面时按新鲜度和冷却自动更新；各区独立展示加载、保留数据与失败原因。短暂故障采用有次数上限的恢复，卸载、身份变化或上下文失效后停止；不循环轮询或无界回填，不为了界面简化跳过 plan、确认、实时授权或未知写锁。

## WAF 与预算通知退役兼容

常规 Web、Skills 和公共 CLI 移除 WAF 接入、启用、管理及预算通知入口，不再读取 Notifications policies / available alerts、Billing 信息或 Zone/WAF 库存作为连接检查。`include_optional` 仅兼容解析；配置及 analytics 以外的旧能力投影固定为 `unsupported_contract`。旧预算投影保留不支持状态，`cloudflare.alerts` 恒为空；不据此判断 Cloudflare 账户是否存在规则或预算邮件。

通知读取、新 Zone 设置、新服务端 WAF target-binding、新启用计划和全新 enable apply 返回结构化 `VALIDATION_ERROR`，`details.reason=cloudflare_feature_retired`。旧 plan、operation、原 request key 的查询和核验继续可用。已提交但未读回的旧 Zone 设置与 target-binding 须按原请求和 key 返回原结果，不重新执行接入；为旧客户端结案保留最小非秘密状态读回，不恢复常规 WAF 探测。已有 apply 先按原调用者、路径、key 和请求哈希查重；同 key 只返回原结果，不再次 POST / DELETE。

退役本地写入使用 `GET /api/v1/admin/cloudflare/local-operations/{request_key}?operation=zone_settings|waf_target_binding|waf_plan` 精确查原回执。服务端固定映射原 method / path，以当前 Owner principal、资源作用域及 key 摘要命中既有唯一索引，只返回未过期且有原子 commit 的原 write envelope，附 `operation`、`request_hash` 与 `idempotent_replay=true`。原子 commit 后响应缓存丢失可从原快照恢复；仅 pending、过期或不存在返回 404，不登记新请求、不补发旧写。客户端先核对原请求哈希；404 保留未确认记录，不将旧 RC6 的 POST / PATCH 重放当作查询。

`GET /cloudflare/waf` 只读本地版本、Zone、hostname 与历史 `target_binding`，顶层为 `unsupported_contract`、`protected=false`。仅本地固定目标、Instance、origin version 和 Zone 均仍一致时，`target_binding.status=verified` 表达旧登记事实，`live_verified=false`、`service_proof=false` 明确未执行在线验证；不据此声称当前 WAF 生效。

### 历史目标、归属与恢复

保留准确 Instance、account / Worker / DB、preferred origin 的 hostname、Zone、domain ID、origin version、供应商元数据摘要、binding ID 与历史操作事实。名称、ref 或相似表达式不构成归属；手工资源保持外部管理。普通升级不自动删除规则、重建域名或接管已有资源。

受限部署 runtime 只可凭准确私有域名归属回执及实时读回迁移旧事实，包括已经回退的 inactive 回执；不开放新目标接入或用 Worker vars / hostname 猜测归属。旧规则迁移还要求准确 rule / ruleset ID 与固定 profile 读回。Cloudflare Credential 保持在安全部署环境，仅发往 Cloudflare，不为恢复临时传入 Worker 或自动扩权。服务端 D1 归属是跨设备权威，旧回执不能覆盖服务端的新状态。

旧操作核验及明确域名回退中的规则清理继续证明准确目标。能读取 Workers Domains 时核对精确 hostname、service、zone_id、domain_id 和 DB 绑定。仅有部署 runtime 证据且 Token 无 Domains 读取能力时，保留固定 trusted preferred HTTPS origin 的短期服务证明：域分离 HMAC、随机 nonce、短 expiry、固定路径、不跟随 redirect、有界超时与响应体。Token、MAC 和 nonce 不进入业务日志、审计或持久状态，不形成任意签名入口。schema 27+ 保持 `global_fetch_strictly_public` 并拒绝 `global_fetch_private_origin`，证明经过公网 front door。该证明不是映射实时 CAS，也不声称抵御拥有全部配置和 Secret 的 Cloudflare 管理者恶意复制服务。

### 仅清理已归属旧规则

明确执行旧域名回退时，兼容 plan 只允许 `action=disable` 且 D1 已有 `ownership.rule_id`。完整核对当前目标、绑定、入口、旧自有 rule、foreign 内容与顺序、Token 身份和冻结基线；缺少归属、手工同名、目标或规则漂移均拒绝。只允许 `delete_owned_rule`，发出准确 rule 的 DELETE，保留共享入口及全部其他规则；不创建、追加、重排或重新启用 WAF，不购买方案。

清理沿用实时 Owner / Cookie CSRF、CAS、稳定幂等 key、持久 intent、dispatch fence、控制面互斥锁和原子审计。已消费或旧 enable plan 不能转为新创建；完成清理后原 plan/apply key 仍可读回原结果。DELETE 响应未知时保留 intent 与锁，恢复只核验原结果，不二次删除。

历史 assessor 保留对旧创建、追加、位置、随机标记和 foreign 摘要的准确核验，避免升级后永久锁住 Token 或限流。未 dispatch 的旧 intent 可确认失败后释放锁；已经 dispatch 但目标、规则或顺序不符时保持 `unknown`，不能直接清锁、补偿删除或覆盖。核验归属与结果审计同批提交。只读 verify 的响应不确定时保留本轮请求与 key；完整未确认结果之后才可开始下一核验轮，永不重发 apply。规则配置读回不等于实网边缘安全验收。

## 可选日度历史与升级

`USAGE_HISTORY_ENABLED` 缺省 false，必须显式开启；不自动开启账户聚合或更改套餐声明。启用后复用已有维护触发，不新增默认 Cron。Web 读取历史时，最多自动采集最近七个完整 UTC 日中的一个缺日，并服从 60 秒冷却；切换图表范围只读，不循环回填其余日期。采集响应丢失时有限 GET 读回，不重新提交采集。Agent/API 保留一次一个日期的显式采集能力。

日度表按准确 account、DB、bucket、Worker 与 account totals 范围组成的资源 key 和 day 唯一保存，保留 90 天；Token、旧提醒百分比及套餐声明不制造无关历史分组。定时采集复用完整成功日，显式采集、失败及全未知重试受 60 秒冷却；失败保留上次成功值。有界跨 isolate claim，每轮最多两个 10 秒 GraphQL 请求，不自动重试。历史 GET 仅读取最多 90 个点并返回日期缺口。

今日 Workers 与 R2 分类指标使用独立 `*_daily_*` key 和 UTC 当日窗口；原账期指标继续保留，Paid 未声明账期时仍可显示真实日值，不能把月累计冒充今天。完整日历史按 metric key、unit、scope 和 window 分组，未知保持 null、缺日断线、不补零。容量保留实际观测时间，不倒填过去，不表示每日消耗或 GB-month。Analytics 不是 invoice，也不是费用封顶。

清理使用 day 索引，每次最多处理七条过期记录；所有配置总计最多 630 行，满额优先淘汰其他旧配置，不扩张为无界历史扫描。关闭历史不产生历史采集请求。没有单独 USAGE account / DB / Worker 时，复用已批准固定 CONTROL 目标；保留旧 USAGE 配置并拒绝与固定目标不一致的采集，显式 `USAGE_ANALYTICS_ENABLED=false` 继续生效。

保持已发行 `0025–0027` migration、schema 27 及校验记录不变，不删表或改写旧迁移。正式升级读取当前非秘密控制面状态，保留限流、用量 vars、历史开关、统一与旧 Secret、旧 WAF 归属及未确认操作；旧本地回执不能覆盖现状。未知 bindings 继续拒绝，不借此放开任意配置保留。升级已存在 pending WAF 操作时先按原恢复合同处理，不以功能退役清锁。

## HTTP、等价表面与验证

OpenAPI 生成器维护目标/能力、Secret、配置/限流 plan/apply、历史及退役兼容接口；全部管理请求有实时 Owner、结构化错误与 `no-store`。能力状态保留 missing / unverified / verified / permission_denied / unavailable / target_mismatch / unsupported_contract，不能压成布尔值。业务写使用当前 CAS、稳定幂等 key 与非秘密审计。

Web、Skills/API 与公共 CLI 复用同一投影、计划、应用、恢复和历史采集语义，Web 将安全组合自动完成。Cloudflare Secret 输入是专用浏览器运输例外：Agent/CLI 用受控 `web open` 引导 Owner 在实例表单输入；普通 generic API 或 CLI JSON/file 参数拒绝 Secret endpoint，不能为形式覆盖把 Token 写入日志。

隔离 D1/Worker 与 fake provider 验证权限/CSRF、候选部署、漂移、幂等并发、未知结果、凭据不泄露、限流 binding、首次安装统计、UTC 日与账期、历史空值/窗口/读量和双语交互。升级兼容覆盖旧 WAF 原 key 读回、未 dispatch 结案、随机标记/位置/foreign 核验、精确旧归属清理、审计原子性、共享锁保留与目标证明失败。未获线上 apply 授权时，本地通过不表示线上配置已生效。

参考：[Workers 单 Worker 授权](https://developers.cloudflare.com/workers/authorization/)、[公网 fetch 兼容开关](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)、[普通 Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Worker settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)。
