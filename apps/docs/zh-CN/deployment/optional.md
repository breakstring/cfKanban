# 域名、附件、统计与访问限制

这些配置可以在需要时启用。先让 Agent 说明资源、费用和权限影响，再决定是否执行。

## 自定义域名

```text
请用 $cfkanban-deploy 检查如何让 <实例地址> 使用 <目标域名>。
说明需要的域名配置、影响和验证方法，先不要修改。
```

需要相应 Cloudflare 和域名控制权限。默认站点使用 `workers.dev`；新增或迁移域名需要单独安排，不会随普通升级自动完成。

Skill 与公共 CLI 已支持自动化的 `deploy public-access inspect`、`plan`、`apply` 流程。获准新增 Worker 自定义域名后，Cloudflare 管理其 DNS 与证书准备；单独的可选 WAF 计划创建限定该实例准确 hostname 的自有 custom rule，不是配置 Cloudflare Managed Rules。

**在网页中：**「管理中心 → 用量与限额」的域名与访问防护详情，按需使用已核验授权读取当前 Zone / 自定义规则状态。域名与 WAF 写入仍通过部署计划。域名计划会核验同一实例、首选地址和本机安全重绑，再关闭 `workers.dev` 与 preview 的业务入口，避免绕过新域名。Zone 规则不保护 `workers.dev`，关闭备用入口是该具体计划的明确影响。Passkey 绑定域名，迁移前需安排可用的 Owner 恢复方式。仅修改应用地址不能完成域名迁移。域名操作不偷偷重新部署 Worker；配置声明在下一次获准部署后更新。

「未记录部署工具管理的配置」不表示没有自定义域名或 WAF。旧版本或手工配置的域名可以正常工作；普通升级保留它们，不自动接管域名或安装新规则。WAF 不是使用自定义域名的必要条件。要检查现有保护，可在 Cloudflare 选择域名所在 Zone，查看 **Security / 安全 → WAF**；如需由工具管理，先让 Agent 只读核对现有映射与规则，为缺少归属回执的既有域名明确接入方案。保留现有域名，不要求为满足新域名流程而删除重建；直接重跑域名安装不会接管旧资源。

WAF 可以单独选择启用或停用，域名不强制搭配 WAF。Free 配置只管理该实例域名上的自有 custom rule，不覆盖其他规则、不自动升级付费方案。Free 速率规则不能限定 hostname，因此共享 Zone 不安装会影响其他域名的计数规则；规则槽位不足时先说明并停止。正常 Agent API、登录、邀请和恢复仍可访问。本轮不启用 Turnstile 或 Bot Fight Mode。

## 启用附件

```text
请用 $cfkanban-deploy 为 <实例地址> 准备启用附件存储的计划。
说明 Cloudflare R2 的订阅、权限和可能费用，先不要开通或部署。
```

附件使用私有 Cloudflare R2 存储，需要额外的订阅和权限检查。确认计划并部署后，由 Owner 在网页「管理中心 → 用量与限额 → 设置上限」选择[附件容量](../administration/settings.md)，才能开始上传。

单文件最多 10 MiB，每项任务最多 20 个有效附件；选择不限制总容量也不会取消这些限制。删除文件不会立即释放存储额度。

## 查看 Cloudflare 用量

```text
请用 $cfkanban-deploy 检查如何为此实例启用 Cloudflare 用量统计。
说明需要哪些权限、如何安全配置，先不要修改。
```

统计是可选功能，未配置时不影响任务协作。统一连接需要包含只读统计权限；部署技能不自动写入密钥。Owner 在「管理中心 → 概览」保存一份 Token，API 将其保存为 Worker Secret，并分别核验配置及统计能力。不要把 Token 粘贴到聊天，也不要让 Agent 输出它。

**在网页中：**「管理中心 → 用量与限额」可查看状态和刷新数据，概览只保留关键摘要。数据可能延迟，不是实时账单，也不是账户剩余额度。

部署计划可选择准确 Worker 名、Free/Paid 口径、实际 UTC 账单周期起始日、提醒阈值，以及明确开启的账户总量。Owner 用量页面也提供统计开关、Free/Paid 声明、账期日、账户总量和提醒阈值的预览 / 应用计划；账户、Worker 和数据库从固定部署目标派生，不能通过表单重新定向。未核对周期时月度指标保持未知，不默认自然月。Workers 请求与累计 CPU、D1 日/月读取写入、R2 Class A/B 分开展示；未知操作或截断结果不会显示为完整计费合计。R2 免费额度只适用于 Standard，只有 Owner 核对整个实例或账户的统计范围均为 Standard 后，才能开启对应额度比较。

日度历史是独立的可选开关，默认关闭。「每日用量历史」显示最近 7/30/90 个完整 UTC 日，未知值与缺日保持断点。启用需要配置计划与应用，不自动改变账户总量或方案声明；复用已有维护触发器，不新增默认 Cron。需要时 Owner 可手动采集最近 7 个完整 UTC 日中的一天。容量保留实际观测时间，不表示每日消耗或 GB-month 计费。

### Cloudflare 统计配置与预算警报

这里的账单周期与 [Cloudflare Billable Usage](https://developers.cloudflare.com/billing/manage/billable-usage/) 对齐，不是 cfKanban 自建周期，也不默认每月 1 日。先在 Cloudflare **Billing / 账单 → Billable Usage / 可计费使用量** 核对实际窗口，并核对 Workers/D1 方案。Free 的日额度按 UTC 当日比较；月度统计需要正确账期，R2 的容量观测也不能直接当作 GB-month 计费用量。

非秘密统计参数可在 **Workers & Pages → 目标 Worker → Settings → Variables and Secrets** 查看和编辑，保存后发布才生效。也可让支持这些字段的部署工具准备 `usageAnalytics` 配置计划，核对后发布；只查看现有日数据不需要重新安装、开通服务或更新配置。

| 变量 | 含义 |
| --- | --- |
| `USAGE_BILLING_PLAN` | 已核实的 Workers/D1 方案：`free` 或 `paid`；未核实保持未知 |
| `USAGE_BILLING_CYCLE_DAY` | Cloudflare 实际账期的 UTC 起始日，1–31；短月按月末调整 |
| `USAGE_WORKER_NAME` | 本实例准确的 Worker 名称，用于可选 Workers 统计 |
| `USAGE_WARNING_PERCENT` | cfKanban 用量提醒阈值，1–100，默认 80 |
| `USAGE_ACCOUNT_TOTALS_ENABLED` | `true` 才明确开启账户总量，默认不开启 |
| `USAGE_R2_STANDARD_ONLY_SCOPE` | `unknown`、`instance` 或 `account`；仅核实整个统计范围为 Standard 时声明 |

页面只按新鲜快照显示用量阈值提醒，不自动发送邮件或新增高频采集。`USAGE_WARNING_PERCENT` 比较用量贡献与共享额度，不是 USD 费用预算，也不是剩余配额。

Cloudflare **Billing → Billable Usage → Budget alerts / 预算警报** 在账户累计按量使用费用超过 USD 预算阈值时通知指定收件邮件。公开 API 合同尚未确认 USD 字段或预算编辑操作，cfKanban 因此明确显示限制并提供官方控制台入口。Notifications 授权核验通过后，可向 Owner 只读显示策略名称、启用状态、告警类型与收件邮件；不会把 `limit` 等通用筛选字段当作 USD 金额。读取被拒绝不表示没有预算策略。USD 预算仍在 [Cloudflare Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) 查看和管理；它不停止用量或封顶费用，应用附件预算继续独立管理。

### 可选控制面权限

新部署只为已选择的可选能力准备最小权限，默认部署不要求所有账单或安全权限。普通升级保留已有授权与已支持的实时设置；旧实例须先获准升级，补齐固定控制账户、Worker 和数据库目标。新增能力前，应先明确目标与缺少的权限，再确认最小补充授权方案。工具不会创建 Token、自动扩大授权或生成 Global API Key。

使用限定准确账户或 Zone 的 API Token，按请求操作选择权限：

| 可选操作 | 限定范围与权限 |
| --- | --- |
| 读取账户账单数据 | Account **Billing Read** |
| 读取通知策略 | Account **Notifications Read** |
| 核验 Zone 归属 | 所选 Zone 的 **Zone Read** |
| 核对 Zone WAF 规则 | Zone **Zone WAF Read** |
| 读取统计 | Account **Account Analytics Read**，只授权当前账户 |

Owner 的用量页面按需读取通知与 WAF 策略，不要求 Notifications Edit 或 Zone WAF Edit。域名 / WAF 写计划仍按独立流程核对 Worker 路由、Zone、DNS 和规则修改权限。须用真实供应商响应核验可用性；存在 Token 或勾选了某项权限，不等于已证实 endpoint 或预算策略类型可用。

Wrangler OAuth 登录不会创建 API Key，也不会为网页设置自动补齐 Billing、Notifications 或 Zone WAF 权限。不要使用 Global API Key，不导出部署 OAuth 凭据。网页连接与 Wrangler 部署身份分开。

在当前 HTTPS 实例中已认证的「管理中心 → 概览 → Cloudflare 连接」输入一份 API Token。该专用表单是受支持的秘密传输入口，普通 CLI / Agent JSON 操作不接受 Cloudflare Token。不要发到聊天、写入浏览器存储、仓库、命令参数、Shell 环境变量或 Worker 明文变量。账户、Worker 与数据库是只读部署目标；相关 Zone 在「用量与限额 → 域名与访问防护」中设置。

打开 [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)，选择页面显示的准确账户，再进入 **Manage Account → Account API Tokens → Create Token**。创建 [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) 的人需要账户 Super Administrator 或 API Token Provisioning 授权；这是创建者的权限，不应给业务 Token 添加 Token 管理权。

一份 Token 按所需能力组合权限：

| 需要的能力 | 权限与资源范围 |
| --- | --- |
| 必需：保存连接、调整访问频率及用量设置 | **Specified Workers → 当前已存在的 Worker → Editor**；不选全部 Workers 或 Admin。Editor 也能修改该 Worker 的代码与部署。 |
| 用量统计 | **Account → Account Analytics → Read**，Account Resources 只选页面目标账户；实际数据集由统计读取核验。 |
| 可选通知与账务读取 | 目标账户的 **Notifications Read / Billing Read**；不需要 Edit。 |
| 可选 WAF 读取 | 当前域名已核对 Zone 的 **Zone Read / Zone WAF Read**；不选全部 Zone，不需要 Edit。 |

当前 [Workers 权限](https://developers.cloudflare.com/workers/authorization/workers/)支持限定单个 Worker 的 Editor，[统计指引](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)说明 Account Analytics Read。通知的 account-owned Token 兼容性仍须实际核验；若某项可选读取被拒绝，页面显示该项的权限状态，其他已核验能力仍可用。不要为消除状态提示扩大到全账户编辑权。域名和 WAF 写入继续使用独立的部署计划流程。

选择「保存连接」后，Token 一次写入 `CFKANBAN_API_TOKEN` 这一普通加密 [Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/)，Free 支持，无需 Secrets Store。首次连接与轮换均用输入 Token 保存其自身，旧授权过期不妨碍有效替代 Token 接入。提交后输入清空，失败时也不恢复草稿；读回与能力核验成功后可跨设备使用，无需再次输入。

统一授权优先使用；尚未统一的实例继续按原用途使用 `CFKANBAN_CONFIGURATION_TOKEN`、`CFKANBAN_CONTROL_TOKEN` 和 `USAGE_ANALYTICS_TOKEN`。保存统一授权不会删除旧 Secret，升级保留统一及旧授权的实时配置。原统计 Token 只有读取权限时不能用于写入 Worker 配置；必须创建或选择符合当前 Worker Editor 范围的替代授权。

已配置 Secret 不等于部署或能力核验成功。「处理中」和「结果未知」必须先「核验当前状态」，不要盲目重复保存或应用。轮换时先核验替代 Token，再撤销旧 Token；实例不可访问时使用部署恢复流程。API 核验所需能力与目标绑定，但不能证明 Token 没有其他权限。Cloudflare 官方 Worker Secret 输入仍是平台配置入口，保存并部署会应用 Worker 配置变更。

`USAGE_*` 变量、Secret、限流 binding 和 CPU 上限等 Worker 配置变更，需要部署 Worker 版本才生效。在供应商控制面修改 WAF 规则或 Budget Alerts 策略，本身不需要重新部署 Worker，但保存后须读回供应商状态。保存在 D1 的应用设置保存成功后无需重新部署 Worker；后续请求按相应读取与缓存规则使用新配置，页面仍可能需要刷新，见[实例设置](../administration/settings.md)。

## 调整访问频率限制

```text
请用 $cfkanban-deploy 检查 <实例地址> 出现请求过多的原因。
结合 <发生时间和现象> 评估是否需要调整，先不要部署。
```

Owner 可在网页「概览 → 访问频率限制」查看并调整已支持的限制；先在同页的 Cloudflare 连接中核验配置授权。访问频率限制与[公开项目人数及内容配额](../administration/public-join.md)不同，出现请求过多不一定是项目已满。

**在哪里修改：** Worker 的 **Settings → Variables and Secrets** 可查看 `RATE_LIMIT_*_LIMIT` 和 `RATE_LIMIT_*_PERIOD_SECONDS`，但这些变量只用于显示和错误说明。真正限流由 `ratelimits` binding 中的 `simple.limit` / `simple.period` 执行；[Cloudflare Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) 不在 Dashboard 展示。部署工具应一起更新两者并读回核对，不能只改变量。每身份 / 每 isolate 查询并发上限由服务代码固定。

Owner 页面分别处理实例 API、单一身份、未认证敏感操作、匿名登录以及计数 / 标题搜索。填写正整数与 10 或 60 秒窗口，预览计划、核对变更前后数值，再应用；服务端保留其他设置，同时更新对应 binding 与显示变量。遇到部署漂移或未完成操作时拒绝；结果未知需要核验，不自动重发。此表单不修改 CPU 上限或查询并发。

新部署另有匿名登录与计数/标题搜索保护，并限制昂贵查询的并发。客户端遵守 Retry-After 与失败退避，重复操作不要通过换身份、不断重试或自动重放写入绕过限制。平台限流按 PoP 最佳努力执行，不是全局账单上限。Paid CPU 上限需在计划中明确配置并验证，不自动购买或升级方案。

已有可选配置在升级时应保留。停用应用功能不会自动删除云资源或停止收费。
