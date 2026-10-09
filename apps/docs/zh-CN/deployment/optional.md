# 域名、附件、用量与访问频率

按需开启这些能力。先让 Agent 说明资源、成本及权限影响，再决定是否执行。

## 自定义域名

```text
请用 $cfkanban-deploy 检查 <实例地址> 如何接入 <目标域名>。
先说明配置、影响和验证步骤，暂不修改。
```

需要相应 Cloudflare 与域名权限。默认站点使用 `workers.dev`；新增或迁移域名须单独制定部署计划，不属于普通升级。Skill 和公共 CLI 支持 `deploy public-access inspect`、`plan`、`apply`；获准创建 Worker 自定义域名时，由 Cloudflare 管理 DNS 与证书配置。

计划先核对同一实例、首选地址和本地安全连接，再按明确范围关闭 `workers.dev` 与 preview 的直接业务入口。Passkey 绑定域名，迁移前须准备可用的 Owner 恢复方式。只修改应用首选地址不会完成域名配置。域名操作不隐式重新部署 Worker，声明随下一次获准部署更新。网页「概览 → 服务信息」显示实例地址。

Owner 页面及常规 Agent/CLI 设置已移除 WAF 管理。升级保留已有规则和归属记录，不新建或删除规则。旧域名或手工配置的域名可以继续使用，无需重建或接管。明确获准回退工具拥有的旧域名时，可沿原安全计划清理准确、未漂移的工具自有 WAF rule，保留共享规则集和其他规则。此前未确认的操作须按原记录恢复后再继续；记录缺失或规则同名不能证明归属。

## 公开页面与爬虫

实例随发行提供 API 目录、Skills 发现、`robots.txt` 和公开页面 sitemap，无需另设响应头规则。发现入口只描述已提供的能力，不开放私有项目或改变安装权限。

默认爬取范围为首页和双语公开文档，其他页面保持禁止；sitemap 跟随公开文档目录更新。robots 不代替登录和权限校验，也不声明 AI 训练许可。是否使用 Cloudflare Managed robots、允许哪些机器人或训练用途，由 Owner 单独决定；平台改写响应时，以线上最终结果和你选择的策略为准，普通部署与升级不会替你修改这些开关。

## 开启附件

```text
请用 $cfkanban-deploy 为 <实例地址> 准备附件存储。
先说明 Cloudflare R2 订阅、权限和可能费用，暂不开启或部署。
```

附件使用私有 Cloudflare R2，须核对订阅与权限。批准计划并部署后，Owner 还需在「管理中心 → 用量与配额 → 附件存储上限」选择[附件容量](../administration/settings.md)，才能开始上传。

每个文件最大 10 MiB，每个事项最多 20 个有效附件。总容量不限制也不会取消这些限制。删除文件后，只有实际清理成功才释放容量。

## 查看 Cloudflare 用量

```text
请用 $cfkanban-deploy 核对此实例固定的 Cloudflare 目标与统计配置。
说明缺少什么及安全设置步骤，暂不修改。
```

统计为可选能力，未配置不影响任务协作。打开「管理中心 → 用量与配额」，在顶部输入一份 Cloudflare API Token，点击「保存」。页面会自动确认保存、检查权限并加载各区数据。概览只保留用量摘要和进入本页的入口。

Token 下方依次为「用量与访问设置」、当日用量、每日历史及附件容量。Workers 请求与 CPU、D1 行数和 R2 操作使用各自真实统计窗口；账期累计和准确观测时间收在「数据详情」。数据可能延迟，不是实时账单或账户剩余额度。「未知」不代表零；观测容量不是每日消耗，也不是 GB-month 计费值。

每日历史默认关闭，须从本页相应设置明确开启并确认。历史提供最近 7/30/90 个完整 UTC 日，不含今天，缺日保持断点。启用后复用已有维护触发，不新增默认 Cron。进入或返回页面时，最多自动采集最近七个完整 UTC 日中的一个缺日，遵守 60 秒冷却，不持续回填。采集响应丢失时仅读回结果，不重新提交；Agent 仍可明确采集一个允许的日期。

### 统计设置

使用 Token 下方常驻的「用量与访问设置」。同时编辑多项统计或访问频率，仅核对有变化的前后值，最后一次「保存 N 项修改」；「放弃修改」恢复当前值。发生冲突时保留草稿，保存结果未确认时核验原操作，不自动重发。已有配置与数据自动加载，无需重新保存。账户、数据库和 Worker 来自固定部署目标，表单不能重定向。原 `USAGE_*` 目标与当前实例一致时继续兼容，缺失时复用固定目标；显式 `USAGE_ANALYTICS_ENABLED=false` 仍保持关闭。

「Cloudflare 方案」和「账单周期」是经你核对的 Cloudflare 配置，不是 cfKanban 收费方案。请在 [Cloudflare Billable Usage](https://developers.cloudflare.com/billing/manage/billable-usage/) 核对实际窗口；未确认账期时月累计保持未知，真实日指标仍可加载。账户汇总须另行明确开启；R2 额度比较还需确认整个测量范围都使用 Standard 存储。

部署或恢复时，可在「Workers & Pages → 当前 Worker → Settings → Variables and Secrets」核对以下非秘密变量，再 Deploy 生效：

| 变量 | 含义 |
| --- | --- |
| `USAGE_ANALYTICS_ENABLED` | `false` 显式关闭统计 |
| `USAGE_HISTORY_ENABLED` | 仅在明确开启每日历史后设为 `true` |
| `USAGE_BILLING_PLAN` | 已核对的 Workers/D1 方案，`free` 或 `paid`；未核对保持未知 |
| `USAGE_BILLING_CYCLE_DAY` | 实际 UTC 账期起始日，1–31；短月采用月末 |
| `USAGE_WORKER_NAME` | 本实例的准确 Worker，缺省使用固定部署目标 |
| `USAGE_ACCOUNT_TOTALS_ENABLED` | 明确选择 `true` 才开启，默认关闭 |
| `USAGE_R2_STANDARD_ONLY_SCOPE` | 按已核验的 Standard-only 范围选择 `unknown`、`instance` 或 `account` |

预算通知和通知策略读取已退出 cfKanban。旧 `USAGE_WARNING_PERCENT` 为升级兼容而保留，不再产生提醒。附件存储上限独立保留。

### 保存 Cloudflare Token

使用当前 HTTPS 实例的专用表单。不要把 Token 发到聊天，也不要保存到浏览器存储、仓库、命令参数、shell 环境变量或 Worker 明文变量。普通 Agent/CLI JSON 操作不接受 Cloudflare Token。Wrangler OAuth 是独立的部署身份，不要导出它，也不要在此使用 Global API Key。

打开 [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)，选择页面显示的准确账户，按「Manage Account → Account API Tokens → Create Token」创建。创建 [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) 需要 Super Administrator 或 API Token Provisioning 权限；创建出的连接 Token 本身不需要 Token 管理权限。

| 范围 | Cloudflare 选择路径 | 用途 |
| --- | --- | --- |
| **Specified Workers（指定的 Workers）** → 页面显示的当前已存在 Worker | **Developer Platform → Individual Workers → Editor** | 保存 Token、调整统计或访问频率。Editor 同时具有该 Worker 的代码修改、部署、Secret 与配置修改权。 |
| 仅页面显示的目标账户 | **Analytics & Logs → Account Analytics → Read** | 读取用量，不需要 D1 SQL 或 R2 对象编辑权限；实际数据集通过读取核验。 |

不要为消除状态提示而选择全账户 Workers Editor 或 Admin。正常设置不需要 Billing、Notifications、Zone 或 WAF 权限；域名变更及旧规则清理仍使用其独立、明确的部署权限。参见 [Workers 权限指引](https://developers.cloudflare.com/workers/authorization/workers/)和[统计权限指引](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)。

点击「保存」后，Token 写入加密 [Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/) `CFKANBAN_API_TOKEN`，Free 支持，无需 Secrets Store。首次设置与更换都使用新输入 Token 保存自身，所以旧 Token 过期或只有读取权限不会阻止有效替代 Token。提交后清空输入，不恢复 Token 草稿；持续显示的「Token 已保存」区分已保存状态与空输入框。输入新 Token 可替换，留空保持原值。

系统自动分别检查配置和统计。某项不可用不表示 Token 没有保存。状态同时有文字和图标，权限路径和证据边界收在详情；配置读取通过不证明所有写权限，单个数据集检查也不代表全部统计可用。进入或返回页面时进行有限检查，无需再点检查或读取按钮。

### 无法保存时

使用具有所需权限的替代 Token。网页仍无法完成时，打开「Cloudflare → Workers & Pages → 当前 Worker → Settings → Variables and Secrets」，将 **`CFKANBAN_API_TOKEN` 添加或替换为 Secret 类型**，然后 **Deploy**。返回用量页后系统自动更新状态；已保存 Token 变化会使旧的成功缓存失效。

页面区分保存被拒绝、正在确认与数据暂不可用，不会自动重发 Token。未确认操作保持写入锁，系统按原记录继续核对；暂未找到记录不能证明保存没有发生。如果状态持续未确认，让 Agent 恢复原操作，不要再次提交保存。先确认新 Token 生效，再撤销旧 Token；实例不可访问时使用[恢复流程](recovery.md)。

统一 Token 优先于旧 `CFKANBAN_CONFIGURATION_TOKEN`、`CFKANBAN_CONTROL_TOKEN` 和 `USAGE_ANALYTICS_TOKEN`；升级保留旧 Secret 和受支持的实时配置。缺少固定管理目标的旧实例须先获准升级。Worker 变量、Secret 与限流 binding 通过版本部署生效；D1 应用设置无需重新部署，见[实例设置](../administration/settings.md)。

## 调整访问频率

```text
请用 $cfkanban-admin 查看 <实例地址> 的访问频率。
结合 <时间与现象> 判断是否需要调整，展示修改前后的值。
```

使用 Token 下方「管理中心 → 用量与配额 → 用量与访问设置」。系统自动读取限制并核对 Token，支持实例 API、单个身份、未认证敏感操作、匿名登录和计数/标题搜索。为需要修改的限制输入正整数与 10 或 60 秒窗口，核对合并差异后，可与其他设置一次保存。

服务保留其他设置，同时更新对应原生 binding 和显示变量。只在 Dashboard 修改 `RATE_LIMIT_*_LIMIT` 或 `RATE_LIMIT_*_PERIOD_SECONDS` 不会改变实际执行：[Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) 使用 `simple.limit` 与 `simple.period`。请通过网页或获准部署计划保持两者一致；本表单不编辑 CPU 或查询并发限制。

访问频率不同于[项目成员与内容配额](../administration/public-join.md)。客户端须遵守 Retry-After 与退避，不换身份绕过或自动重放写入。平台限流按 PoP 最佳努力执行，不是账户账单封顶。Paid CPU 上限须通过明确核验的计划，不会购买或升级套餐。关闭功能不会自动删除云资源或停止相关费用。
