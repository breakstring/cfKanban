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

## 登记已有 WAF 目标（schema 27+）

WAF 管理与创建自定义域名独立。先核对准确 Owner，读取 `GET /api/v1/admin/cloudflare/waf`。已存 Token 能读取 Worker Custom Domains 时，通过 `POST /waf/target-binding` 登记当前 preferred hostname；Worker Editor 本身不证明该读取权限可用。否则运行 `cfkanban deploy waf-target inspect` 和 `deploy waf-target plan`（Skill helper 为 `waf-target inspect`、`plan waf-target`），提供 `instanceId`、`receiptPath`、`zoneId`、`hostname`、绝对路径 `wranglerExecutable`，以及已有 `cloudflareProfile` / `contextDirectory` 二选一；计划另需 `taskId`，可提供 `operationId`。

此流程只读核对准确账户、Worker、D1、域名映射、当前 preferred origin、Owner 与控制版本，不创建域名或 WAF 规则。展示冻结登记计划。`deploy waf-target apply` / `resume` 与 public-access 一样使用匹配的 `instanceId`、`operationId`、`taskId`、`plan` 和准确 `authorization` 摘要；Skill 先创建/授权 journal，再调用 `waf-target apply`。Apply 只向准确 D1 写非秘密目标/归属元数据，在同一原子事务核对实时 Owner Credential、origin、目标、控制版本和未锁定状态。Cloudflare 认证留在本机，不将临时凭据提交 Service。

旧本机 public-access WAF 回执只有在准确实时 rule ID、唯一 Zone entrypoint、ref 及完整受支持规则体均一致时才可迁移。手工规则或静态 ref 匹配不授权接管。后续 Service 操作用瞬时签名 challenge 核对固定 preferred origin 是否由当前 Worker 服务；此内部证明不能通过普通 API/CLI 输入调用，也不传递 Token。

## 可选 Free WAF profile

schema 27+ 的 Web、CLI 与 Skill 使用同一 Owner Service API，分别生成启用/关闭计划。公共 CLI 提供 `admin cloudflare waf`、`waf-connect`、`waf-plan`、`waf-apply`、`waf-operation`；Skill 用 `api request` 调用这些非秘密操作。部署 helper 既有 `mode:"waf-enable"|"waf-disable"` 同样生成/应用 Service 计划，在已授权 journal 保留原请求。需要共存选择时，先核对 `conflictChoice:"preserve_exemptions"|"before_conflicts"` 再计划。旧 Service 保留私有回执流程，跨设备共同事实源需显式升级。

`anonymous-api-filter` 占用一个 custom-rule 槽位，只过滤准确 hostname 上已知私有 API 中同时缺少 Authorization header 和 session cookie 名的请求。公开登录、discovery、加入保持可用。header/cookie 存在性可以绕过它，Worker 仍必须认证私有请求。它减少匿名无效流量，不保证 DDoS 防护，也不是请求或账单封顶。

Service 按 Free 五条上限清点全部 custom rules，包括子 custom rulesets；向唯一既有 Zone entrypoint 追加单条规则，或创建缺失 entrypoint。保留其他规则内容与顺序，不整体替换共享 ruleset。较早 Skip 只有明确批准位置后才可前移；IP Access Allow 和不确定表达式仍是部分覆盖。不自动购买套餐、设置 zone-wide rate-limit、challenge 或 Turnstile。启停需要准确 Zone 的 WAF Edit，Read 不足以写入；失败不触发自动登录或权限扩展。

apply 响应丢失时，只以原 UUID 键查询 `GET /waf/operations/{key}`，再调用准确 operation 的只读 verify。404 不证明供应商写入未发生；保留 intent、plan 和 journal，不重复 apply。只有已核实归属规则与当前覆盖证据共同成立才能称防护有效。关闭只删除准确登记规则，保留域名、共享 ruleset 及其他规则。

`mode:"domain-rollback"` 在当前 preferred 自定义域名仍有效时先关闭归属 Service WAF rule，再执行另行授权的域名回退：开启已核实的原 workers.dev、保持 previews 关闭，验证并迁回 origin trust，解绑准确自有域名映射。不删除证书或无关 DNS。

## 升级与状态

schema 27+ 的 `public-access inspect` 读取 Service 目标/归属事实与实时 Cloudflare 资源；升级时将其 `waf_authority` 放入 `resources.waf_authority`。计划及执行前后核对准确 D1 行、控制/origin 版本、唯一 entrypoint 和实时规则。本机旧 WAF 回执不能重新开启另一 Owner 设备已关闭的防护。已有手工配置域名可提供已核实目标投影，但该投影不证明域名归属，也不授权域名回退。

域名归属仍保存在私有 `receipts/public-access.json`；将已核实域名回执放入 `resources.public_access`，保留准确 `resources.custom_domain` 与实测 `resources.workers_dev`，routes 为空，保持 previews/入口暴露状态。旧 schema 升级仍要求完整回执与实时规则证据。证据缺失或漂移阻断升级，不隐式启用、修复、接管或删除防护。授权回退后的 inactive 回执用于核对映射不存在并清除旧状态 binding。

`PUBLIC_ACCESS_*` Worker vars 仍是最后部署声明，不能替代实时 WAF 事实。Owner `/waf` 提供当前共享状态，本机 inspect 主动读取控制面。另一电脑接入时分别核对非秘密域名回执与当前 Service WAF 事实，不能通过普通输入搬运凭据。
