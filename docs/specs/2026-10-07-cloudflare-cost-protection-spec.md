# Cloudflare 成本保护与用量口径

- 状态：Frozen
- 日期：2026-10-07
- 执行任务：[CFK-632](https://cfkanban.dev/app/issues/CFK-632) 至 [CFK-640](https://cfkanban.dev/app/issues/CFK-640)
- 授权依据：用户确认原成本保护方案，并进一步要求简化 Owner 设置流程、移除 WAF 与预算通知，保留已安装版本的升级和恢复。授权本地实现与验证；不包含提交、推送、线上迁移、部署、域名变更、付费或新增凭据权限。
- 本文增量覆盖匿名登录、昂贵读取、派生缓存、部署成本配置及用量投影。其他权限、CAS、原子操作、凭据、发行合同保持有效。

## 核心保护

匿名 Passkey options/verify 在 D1 访问前使用独立原生 Rate Limit binding；默认每 IP 每 60 秒 10 次。IP 只使用可信平台头，限流 key 哈希化，不记录 IP。不引入 Turnstile、KV 精确计数器或额外逐请求 D1 计数。平台原生限流按 PoP 最佳努力执行，不是全局账单封顶。WebAuthn 过期清理每 60 秒至多一次，通过单行数据库租约合并；清理失败不改变过期校验及 Challenge 一次性消费语义。

计数和标题子串查询经实时身份认证后使用独立昂贵读取限流；默认每 Principal 每 60 秒 10 次。被限流时在项目查询之前拒绝；实际执行的读取仍核验实时项目权限并在响应前重验。单 isolate 同一 Principal 最多 2 个、总计最多 32 个昂贵查询；到达限制返回现有结构化 429/Retry-After。没有新 binding 的旧部署继续兼容，升级计划显示新增保护。Owner 的 rate-limit-settings 返回 cost_protection 的 binding 启用状态、可用 policy 与并发边界，Web/API/CLI 均可读取。不能静默截断计数、搜索结果或放宽数据授权。公开查询优化优先复用已有索引，稀疏未分配筛选从 assignee 索引驱动；子串空结果、大范围计数仍可能随项目规模增长，必须在代表性规模上记录完整 HTTP 请求的 D1 meta 成本。

Paid `limits.cpu_ms` 是 Owner 在部署计划中显式选择的可选限制，只对已确认 Paid 的目标生效。不自动购买或升级方案；不能把 CPU 限制描述为 D1/R2 或账户账单上限。 供应商读回仅返回纯 `cpu_ms` / `subrequests` 配置快照，不能用 CPU 字段推断套餐。已有实例升级必须显式提供准确读回（包括确实无配置时的 `null`），否则在计划阶段拒绝并指引补读。默认原样保留全部已知限制，Free 无须声明 Paid；显式 CPU 请求另存 Owner 的 existing-paid 声明，只更改 CPU 并保留 subrequests。配置、部署前后读回与完成回执均核对完整限制；未知字段拒绝，不静默丢弃。首次部署仍不生成限制配置。

## 派生数据与客户端

附件回收每批最多 20 个对象，包含完整 D1/R2 调用预算。先确认对象删除，再原子释放已预留预算；部分失败、重试与迟到 PUT 不得重复释放。永久墓碑继续阻止迟到对象复活。回收结果只记录有界计数、失败类别与积压标志，不包含对象 key、个人信息、SQL 或供应商错误正文。

通知待提醒缓存使用新的兼容派生表保存最多 100 个 ID 的排序窗口、完整标记及续扫下界；保留旧表供回滚兼容。大规模已过期历史不能迫使每次少量通知读取重扫全历史。冷建、补窗及大量新增 sequence 的成本仍可能随候选量增长，稳态热读优化不代表任意请求恒定成本。旧未读、并发发布、乱序确认、分页和失效仍完整正确，不通过删除未读或单纯抬高缓存阈值规避问题。新的 migration 删除三个已有列级 UNIQUE 对应的重复显式索引，保留唯一约束，不修改已发行 migration。

MCP hint、touch、翻页及失败统一服从 next allowed sync、Retry-After、退避及抖动；不得自动重放不确定写入。discovery/origin/身份信任链继续校验。技能只在成功业务响应后按私有状态中每实例 45 秒的时间戳 claim 提醒通知；磁盘只保存时间，不保存通知内容或凭据。此条明确覆盖旧通知 SPEC 的无磁盘冷却约定。Web 计数请求采用 single-flight 与一次 dirty 尾随刷新，减少已启动的重复 SQL，而不只是丢弃旧响应。

已知 `/docs/assets/*` 静态资源直接由 Assets 服务；文档 HTML 继续由 Worker 路由添加安全头。缺失静态文件返回真实 404；应用 SPA 回退保留原行为。私有附件、账户与 API 不进入公共缓存。

## 可选域名与旧 WAF 兼容

Owner 仍可通过独立受限部署计划选择自定义域名，普通 Project 管理员不能代替 Cloudflare 控制权限。域名操作保留资源 preflight、漂移检查、可恢复 apply/resume、Passkey 影响确认及读回；不属于普通升级。新 WAF 接入、启用和常规管理已退役，Web、Skills、CLI 不再引导创建规则或添加 WAF 权限。

已有规则和归属事实不因升级而删除。只在明确的旧域名回退中，沿用原控制面 plan/apply 协议清理准确已归属 rule，保留共享入口与手工规则；无归属、漂移或未知写入均 fail closed。旧操作 key 查询、核验与锁恢复继续可用，不能通过功能退役清锁或重发。详情见 [Owner Cloudflare 管理增量](2026-10-07-owner-cloudflare-control-spec.md)。

自定义域名启用前仍核对新域名的实例与 Owner 身份、可信 discovery、Passkey RP 变化和恢复路径；切换后按明确计划关闭 workers.dev/preview 的直接业务入口。Web 的非秘密最后部署快照不是实时健康检查。正常管理通过普通 Worker Secret 中的统一 Token 执行配置与用量操作，凭据及安全边界遵循 Owner 管理增量，不导入本机 Wrangler OAuth。

域名启用或回退计划必须冻结 `passkey_impact` 中的新旧 RP ID、旧 Passkey 不可跨域转移、Web-only 用户需要同身份恢复后重新登记的影响。Owner 以 `passkeyRecoveryReady: true` 显式声明恢复路径已准备，该前置条件进入 plan digest；省略或 false 可生成计划，但 apply 在任何控制面写入前拒绝。新 origin 下同一 Principal 的现任 Owner 安全 API Credential 实时读回证明 Owner 的恢复路径，不代表全部普通用户已迁移；不自动创建替代身份或转移旧 rpId。

普通升级保留准确私有 `public-access.json` 归属回执所指的域名、WAF rule 和入口关闭状态，部署前后读取实时控制面。域名回退后仍携带 `domain_enabled: false` 的 inactive 回执，核对原映射已消失、workers.dev 恢复且 previews 关闭，再清除旧 Worker 状态快照 binding；不能通过遗漏回执绕过漂移保护。第二台设备接入须显式提供严格非秘密字段的 `publicAccessReceipt` 并重新验证 Instance、Owner、准确域名与规则，只保存本机回执，不根据 hostname 或 Worker vars 自动重建资源归属。恢复执行重新验证 Owner；唯一进程锁只回收已证明终止的进程文件，不继续与存活或未知进程并发写入。

## 用量与共享额度

Owner-only usage API 包含 Workers 请求/累计 CPU、D1 读写、R2 Class A/B、明确账期累计量及显式 opt-in 的账户总量。保留原六项指标、15 分钟缓存、60 秒尝试冷却、每轮最多两个 10 秒 GraphQL 请求、固定 endpoint、不自动重试和不新增统计 Cron 的边界。没有独立 USAGE account / DB / Worker 时复用固定 CONTROL 目标；保留旧配置，拒绝与固定目标不一致的采集，显式关闭继续有效。

非秘密 `worker_name` 必须等于部署目标；`billing_plan` 为 free/paid；`billing_cycle_day` 为 Owner 核对的 UTC 周期起始日 1–31，短月钳制到月末；`account_totals` 默认关闭，显式开启才聚合账户。`r2_standard_only_scope` 默认 unknown，仅在确认整个测量范围均为 Standard 后声明 instance/account；实例声明不能证明账户范围，因为 Infrequent Access 没有免费额度。旧 `warning_percent` / `USAGE_WARNING_PERCENT` 仅兼容保留和读回，不再提供新设置或派生提醒。

没有明确周期时月累计量及月额度比较保持未知，不能假定自然月；这不妨碍真实 UTC 日统计。`workers_daily_requests`、`workers_daily_cpu_microseconds`、`r2_daily_class_a_operations`、`r2_daily_class_b_operations`、`r2_daily_unclassified_operations` 明确表示当日指标，D1 原 `d1_rows_read` / `d1_rows_written` 和 R2 原 `r2_operations` 继续采用日窗口。原 `workers_requests` / `workers_cpu_microseconds` 维持 Free 日窗口、Paid 所声明账期语义；原 R2 Class A/B 指标保持账期语义。Free 的日 Workers 指标复用同一数据集，只有窗口不同才增加日查询字段，仍最多两个 GraphQL 请求。

metric scope 为 instance/account，unit 包含 microseconds。累计 CPU 直接使用 `cpuTimeUs`，不能以分位数乘请求量估算账单。R2 按操作和响应码分类；未知类型或截断则分类合计为未知，并保留未分类量，不将总请求、HEAD 或 DELETE 混称可计费类别。容量是最近观测，不是日消耗或 GB-month。Analytics 可能采样、延迟并不同于最终账单，始终标识 `analytics_not_invoice`。

`cloudflare.billing` 保留 plan、cycle_day、period_start/end、account_totals_enabled、旧 warning_percent、r2_standard_only_scope、allowances_shared=true、analytics_not_invoice=true。`cloudflare.alerts` 兼容返回空数组，预算通知及策略读取退出产品，不再访问 Notifications/Billing 端点或引导预算配置。保留旧变量不产生邮件、通知历史或高频采集。实例贡献不等于账户剩余额度，可选账户聚合也不能承诺精确账单。

顶层 `public_access` 保留 status=not_configured/configured/invalid 及可空 hostname/mode/waf_profile/verified_at，live_verified 恒 false，只表达最后部署声明。旧域名、WAF 归属和原操作仍由受限部署工具按准确证据核对。用量、状态及退役边界在 Web、Agent/API 和公共 CLI 保持一致。

## 验证与证据边界

隔离本地 D1/Worker 测试覆盖限流拒绝不产生业务写入、并发释放、完整 HTTP rows_read/rows_written、1k/10k/50k 空结果/稀疏/深分页、回收失败恢复与迟到 PUT、通知窗口续扫、唯一约束、静态路由与头、退避不提前、统计周期/分类/零与未知/错误/并发缓存/权限及双语呈现。部署控制面使用 fake provider 检查 plan/apply/resume/漂移/规则归属和恢复。没有线上授权时不使用生产实例作测试，不宣称本地 meta、模拟控制面或静态配置证明线上计费与防护已生效。

参考：[Workers GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)、[Cloudflare GraphQL 字段参考](https://github.com/cloudflare/skills/blob/main/skills/cloudflare/references/graphql-api/api.md)、[D1 Analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)、[R2 pricing](https://developers.cloudflare.com/r2/pricing/)。平台事实于 2026-10-07 核对，实际 plan 仍须实时 preflight。
