# 可选公网访问与成本保护

默认仍是 Workers Free、内置 Static Assets 和应用已有保护。此流程不会自动购买域名、购买或升级 Cloudflare 套餐、安装 Turnstile 或开启 WAF。CPU 上限只允许在操作者明确确认已有 Workers Paid 套餐后配置，它限制单次调用，不是账户账单封顶。原生限流是按位置执行的近似控制，不是全局精确预算。

## Worker CPU 上限

使用 `cfkanban deploy worker cost-settings --input-file worker-readback.json`（Skill helper：`runtime worker-cost-settings`），提供准确 `accountId`、`workerName`、绝对路径 `wranglerExecutable`，以及已有 `cloudflareProfile` 或私有 `contextDirectory`。命令只读生产环境 `script.limits`，不查询或改变订阅。

每次已有实例升级前（包括第二台电脑接入后的升级），将返回的 `worker_limits` 原样放入 `resources.worker.worker_limits`；只有读回确实返回 `null` 时才能明确填入 `null`。快照只含供应商配置 `cpu_ms` 和/或 `subrequests`，不含套餐结论。缺少快照会在计划阶段返回补充只读读回的命令。省略 `workerLimits` 即精确保留全部已有值；例如 Free 的 `{ "cpu_ms": 10, "subrequests": 50 }` 无须声明 Paid。

明确设置或替换 CPU 上限时，在 `deploy upgrade plan` 输入添加 `workerLimits: { "workers_plan": "paid", "cpu_ms": 100 }`。这里的 paid 是 Owner 对已有 Paid 订阅的确认，不是从 Worker 元数据推断的事实；命令不查询或购买套餐。CPU 合法整数范围是 1–300000。计划把显式请求单独记为 `cpu_limit_request`，仅覆盖 `cpu_ms`，原样保留 `subrequests`。拒绝显式移除、Free 套餐变更请求及未知 limits 字段。生成的 Wrangler 配置保留完整目标 limits，执行和完成检查核对部署前后完整对象；漂移时先重新读回和计划。首次部署没有待保留的历史限制，仍不生成 limits 段。

包含匿名登录及昂贵读取保护的源码发行会生成对应原生 binding，普通升级保留已核实策略。匿名登录被拒绝时尚未创建或验证 challenge；跨 isolate 的持久清理租约压低常规清理频次。这些措施减少成本，不承诺全局精确封顶。

## 自定义域名计划与执行

选择部署回执所指账户内 active zone 下的一个空闲、小写准确 hostname。使用已有私有部署回执、当前已认证 Deployment Owner、以及已有授权的 Cloudflare profile/context。Cloudflare 权限需覆盖 Worker routing 和目标 zone/DNS 读取；只启用域名不需要 WAF 权限。工具不自动扩展 OAuth scopes 或换账户。

1. `cfkanban deploy public-access inspect --input-file public-access-inspect.json` 对应 `public-access inspect`。输入为 `instanceId`、`receiptPath`、`zoneId`、`hostname`、绝对路径 `wranglerExecutable`，以及二选一的 `cloudflareProfile` / `contextDirectory`。只核对域名时设 `includeWaf: false`，不写资源。
2. `cfkanban deploy public-access plan --input-file public-access-plan.json` 对应 `plan public-access`，另加 `taskId`、可选 `operationId`、`mode: "domain-enable"`。域名启用和回退都须在同身份恢复与新域名重新登记路径已准备后显式设置 `passkeyRecoveryReady: true`；省略默认为 false，apply 拒绝切换。该声明及新旧 RP ID 冻结在 `passkey_impact` 中。它核对 Owner、准确 Worker/D1 回执、active zone、完整路由清单、空闲 DNS 名及已启用的 workers.dev。拒绝接管已有域名映射/DNS、Worker routes、通配域名及分页不完整的清单。
3. 展示完整计划、新地址、旧入口关闭和受影响客户端。计划依次绑定域名、以无凭据 HTTPS discovery 核对同一 Instance、Owner CAS 修改 preferred origin、双端 discovery 核对、本机 trusted origin rebind、新地址认证读回，然后关闭 workers.dev 与 preview URLs。已有 Passkey 属于旧 RP hostname，不能转移；Web-only 用户需通过已有同身份 API 连接或 Owner 签发的同 Principal 恢复路径，在新域名重新登记。新地址 Owner API 读回只证明 Owner 恢复路径，不证明全部用户已迁移。API 客户端需更新 trusted origin，旧链接在关闭旧入口后失效。这些是本次切换的明确影响。DNS/TLS 传播尚未完成时停下，在新入口被证实可用前保留旧入口。
4. 公共 `deploy public-access apply` / `resume` 接受同一 `plan`、`instanceId`、`operationId`、`taskId` 和 `authorization: { "instance_id": "…", "operation_id": "…", "task_id": "…", "plan_digest": "…" }`，CLI 建立并授权匹配 journal。Skill 先 `journal create`、`journal authorize`，再 `public-access apply`。同一范围已有授权持续有效，不逐步骤重复询问。

请求失败可能发生在远端已提交之后。保留原计划、journal、幂等键和 ownership reference；`resume` 先读实际映射/rule/origin 再继续，并在进一步写入前重新认证 Owner。不能新建操作绕过不确定结果。每调用独立的私有进程锁阻止并发执行；resume 只回收 PID 已证实停止的唯一锁文件，包含崩溃留下的空文件或部分写入文件，存活或无法确认的进程继续阻断。工具不返回 token 或一次性凭据。

## 可选 Free WAF profile

域名启用完成后，用独立 `mode: "waf-enable"` 计划开启。当前 `anonymous-api-filter` 消耗一个 custom-rule 槽位，只过滤准确 hostname 上已知私有 API 中同时缺少 Authorization header 和 session cookie 名的请求。公开登录、discovery、加入流程保持可用。伪造 header/cookie 存在性能够越过这层负面过滤，Worker 仍须认证全部私有请求。它减少匿名无效流量，不保证防住 DDoS，也不是请求或账单封顶。

Cloudflare Free custom rules 额度为五条。工具清点该 phase，无法证实有免费槽位就停止，即使账户另有付费能力也不自动选用。Free rate-limiting 表达式不支持 Host，因此此流程不会设置可能波及同 zone 其他网站的 zone-wide rate-limit。它不使用 challenge 或 Turnstile。已有 Cloudflare 认证需有 custom rules 读写权限；失败不会触发自动登录或权限扩展。

工具只通过单条 Rulesets API 创建/删除自己的 rule。准确 ref、rule ID、ruleset ID、内容和私有归属回执必须匹配；写入前后核对其他规则内容，绝不整体替换共享 zone 的 ruleset。读回发现并发改动时不能宣称完成；Cloudflare 控制面没有此类修改的应用 CAS。

`mode: "waf-disable"` 只删除准确归属的 rule，保留域名，不删除共享 ruleset 或其他规则。`mode: "domain-rollback"` 先开启已核实的原 workers.dev、保持 previews 关闭，验证后迁回 origin trust，再删除工具自己的 WAF rule（如有），最后解绑自己的域名映射；不删除证书或无关 DNS。

## 升级与状态

核实后的非秘密归属快照保存在此 Instance 私有 `receipts/public-access.json`。普通升级把完整回执放进 `resources.public_access`，设置 `resources.workers_dev: false`、`resources.custom_domain` 为准确 hostname，并保持 routes 为空。升级保留既有域名、已关闭的 workers.dev/preview URLs 和准确 WAF profile，不能顺便启用、修复、接管或删除它们。部署前后均核对私有回执与实时 Cloudflare 路由/rule，回执缺失、入口暴露或规则漂移都会阻断。授权回退域名后，仍把该 inactive 回执放进 `resources.public_access`，保持 `resources.workers_dev: true`、`resources.custom_domain: null`；升级确认原托管映射不存在、previews 关闭，并清除旧状态快照 binding。

下一次普通升级将 `PUBLIC_ACCESS_MODE`、`PUBLIC_ACCESS_HOSTNAME`、`PUBLIC_ACCESS_WAF_PROFILE`、`PUBLIC_ACCESS_RULE_REF`、`PUBLIC_ACCESS_VERIFIED_AT` 作为非秘密 Worker vars 投影到 Owner 状态。这是最近部署时核实的快照，不是 WAF 实时监控。域名/WAF apply 写私有回执，不为刷新显示偷偷重部署未知 Worker；当前控制面证据通过 `public-access inspect` 读取。

在另一台电脑接入时，向 `deploy attach inspect` / `deploy attach plan` 显式提供非秘密 `publicAccessReceipt`。接入重新核对同一 Instance、Owner，以及准确实时 domain、zone、workers.dev/preview 状态和归属 rule，只保存本机回执，不写 Cloudflare。workers.dev 已关闭却没有回执时拒绝，不从 hostname 或状态 vars 重建归属。任何 API / Cloudflare secret 都不得作为普通输入搬运。
