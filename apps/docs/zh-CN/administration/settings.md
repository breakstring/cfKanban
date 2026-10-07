# 实例设置与用量

本页能力属于 Owner 的实例管理范围。工作区或项目管理员不具有全局设置、用量或安全审计权限。

## 配置何时生效

- 首页说明、附件容量、公开加入配置和权限等保存在 D1 的应用设置，保存成功后无需重新部署 Worker。后续请求按相应读取与缓存规则使用新配置，页面仍可能需要刷新。
- `USAGE_*` 变量、Secret、限流 binding 和 CPU 上限等 Worker 配置变更，需要部署 Worker 版本。
- 在供应商控制面修改 WAF 规则或 Budget Alerts 策略，本身不需要重新部署 Worker；保存后须读回供应商状态。

## 首页实例说明

```text
请用 $cfkanban-admin 修改首页实例说明：
中文：<公开中文说明>
英文：<public English notice>
保存后核对两种语言。
```

说明对未登录访客公开，每种语言最多 500 个 Unicode 字符，仅作为纯文本显示。空值表示使用回退文案；中文缺失时先回退已配置英文，再使用内置说明。只改一种语言时，Agent 保留另一种语言的现有值。

**在网页中：** 「管理中心 → 概览 → 首页实例说明」提供中英文输入、保存和恢复默认。点击恢复默认只清空草稿，仍需保存才生效。

保存后，Agent 会核对两种语言的内容，公开首页使用对应语言的说明。不要填写私有项目内容、凭据或恢复链接。

## 发布实例通知

```text
请用 $cfkanban-admin 向实例发布公告：
标题：计划维护
正文：今晚 22:00–22:30 维护，期间可能短暂不可用。
过期时间：<选定的日期时间与时区，选填>
发布后在 Owner 历史中核对。
```

**在网页中：** 从账户区域或管理概览打开「通知」→「Owner 发布历史」，填写标题、正文和选填的未来过期时间后「发布」。选择准确记录的「撤回公告」停止提醒。发布与撤回需要 Owner 实例管理范围；只为某个项目打开的 Owner 网页及局部管理员不能操作。

标题最多 200 个 Unicode 字符，正文最多 4000 个。发布后不能编辑正文，更正需另发公告。过期或撤回仍在历史保留正文和明确状态。公告面向整个实例，不要包含凭据或私有项目内容。发布者不接收自身的自动提醒；Owner 不能绕过个人关闭设置，也不提供逐用户阅读统计。接收与确认方式见 [Owner 实例通知](../usage/notifications.md)。

## 升级成功后自动发布公告

**Web 入口：** **管理 → 概览 → 版本更新** 中可以设置 **自动公告已确认成功的升级**。默认关闭；保存后生效，需要 Owner 实例管理权限。

```text
使用 $cfkanban-admin 开启站点升级成功后的自动版本通知，核对并读回保存的设置。
```

```sh
cfkanban admin upgrade-notification show --json --no-interactive
cfkanban admin upgrade-notification configure --enabled true --expected-version <current-version> --json --no-interactive
```

获准升级成功且实际发行读回确认后，兼容的部署 runtime 发布一份中英双语公告，包含旧 / 新版本、准确 Release 链接和本地技能更新指引。正式版和 `rc.N` 版本前进均触发，alpha、beta 及其他预发行以 `unsupported_channel` 明确跳过；首次部署、失败、同版本重部署、回滚和仅本地技能更新不触发。每个发行最多一份自动公告，回滚后再升级到曾通知的发行也不会重复发布。个人接收偏好与历史规则继续适用；提醒不代表本地技能已更新。

升级与通知分别报告。通知失败不会撤销成功升级；保留维护 journal，让 Agent 核实原请求与原幂等键恢复。不要为重试通知再次部署站点。

## 查询用量

```text
请用 $cfkanban-admin 查看此实例的用量与剩余附件容量，并说明数据更新时间。
```

用量区分附件容量和可选 Cloudflare 指标。数据可能延迟；「未知」不代表零，站点用量也不等于整个账户的用量或剩余免费额度。

概览只显示附件预留容量、D1/R2 容量和统计状态；完整指标、刷新、容量设置及配置说明放在独立的「用量与限额」标签页。

可选指标分开显示 Workers 请求和 CPU、D1 读取/写入，以及 R2 月周期 Class A/B；明确启用账户统计时单列账户总量。同一单位、同一统计窗口的快照指标可用横条比较，已返回的额度提醒显示贡献进度。未返回提醒不能视为用量为零或剩余额度充足。展开「数据详情」核对准确窗口及观测时间。

独立的「每日用量历史」提供最近 7、30、90 个完整 UTC 日的图表，不含今天。历史采集默认关闭；先「预览启用历史」，核对 Worker 配置计划，再「应用此计划」，此前需核验配置授权。启用后复用已有维护触发器，没有触发器的实例可手动采集所选日期。「采集所选日期」一次只接受最近 7 个完整 UTC 日中的一天；读取图表不会后台采集或轮询。缺日与未知值保留断点，真实零值仍为零；实例与账户范围分别查看。容量与对象数保留实际观测时间，不表示每日消耗或 GB-month 计费。

「Cloudflare 方案」和「账单周期」是经 Owner 核对后记录的统计配置，不是 cfKanban 自己的收费方案或周期。未配置月账期不影响已有日用量；未知不表示 Cloudflare 未订阅。R2 免费额度比较还需要确认 Standard-only 范围。

「cfKanban 用量提醒阈值」是共享额度的百分比，不是 USD 预算或剩余配额。Cloudflare Budget Alerts 另外在账户累计按量使用费用超过 USD 预算阈值时通知指定收件邮件。公开 API 合同尚未确认 USD 预算字段及编辑操作，因此 Owner 页面提供 Cloudflare 预算控制台入口；具备对应授权时，可只读显示通知策略名称、启用状态、告警类型与收件邮件，这些字段不能证明 USD 预算金额。权限不足或没有策略投影，不表示未配置预算警报。

「管理中心 → Cloudflare 连接」显示部署固定的账户、Worker 和数据库目标；旧实例缺少这些目标配置时，需先执行获准升级。在独立密码输入框中填写配置、功能及统计 Token，再选择「保存并应用配置」。这是三种授权用途，并不强制使用三份不同凭据；兼容的同一 Token 可以用于多个用途，每项分别核验。Token 最终只保存到普通加密 [Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/)，支持 Free，无需 Secrets Store。提交后输入会清空，不作为草稿恢复，API 不返回 Token。配置 Token 仅授权当前 Worker 的 Editor，包含代码修改与部署权；首次保存其自身，后续保存其他 Token 使用已保存的配置授权。接入并核验成功后，Owner 可在另一设备登录，只读查看策略或管理已支持的配置，不必再次导入 Token。最小权限及恢复方式见[可选部署配置](../deployment/optional.md)。不要把 Token 发到聊天、写入浏览器存储或 Worker 明文变量。

在 Cloudflare 按页面显示的部署目标创建 Token：

| 用途 | 创建入口 | 权限与资源范围 |
| --- | --- | --- |
| Worker 配置 | [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)：**Manage Account → Account API Tokens → Create Token → Specified Workers → 当前已存在的 Worker → Editor** | 页面目标账户的 account-owned Token，只授权页面当前 Worker 的 [Editor](https://developers.cloudflare.com/workers/authorization/workers/)，包含代码修改、部署与 Secret 管理权。 |
| 通知、账务与 WAF 读取 | [自定义 Token 指南](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)：**My Profile → API Tokens → Create Token → Create Custom Token** | Account **Notifications Read / Billing Read**，Account Resources 只选页面目标账户。读取 WAF 时再添加 **Zone Read / Zone WAF Read**，Zone Resources 只选当前域名已核对的 Zone，不选全部 Zone；不需要 Edit。 |
| 统计 | [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)：**Create Token → Custom token** | [Account → Account Analytics → Read](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)，Account Resources 只选页面目标账户；保存时先核验 D1 统计接口；其他已配置数据集是否可用，以后续实际统计读取结果为准。 |

创建 [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) 的人需要账户 Super Administrator 或 API Token Provisioning 授权；这是创建者的权限，不是要给业务 Token 添加的 Token 管理权。先核验配置授权，再分别保存可选用途。复用同值也须逐用途核验实际能力，不能保证 account-owned Token 兼容 Notifications；只读用途核验不通过时，可为该用途使用兼容的 user Token，配置用途仍保留 account-owned 的单 Worker Editor。

已配置 Secret 不等于配置已生效。「处理中」或「结果未知」时请「核验当前状态」；即使保存或应用响应丢失，也会读取最新操作。核验结果前，输入保持清空、写操作保持锁定，不要盲目重发变更。用量设置及五组原生频率限制都先「预览」，再单独「应用此计划」；次数必须为正整数，窗口只能为 10 或 60 秒，实际 binding 与显示 policy 一起更新。这些表单不修改 CPU 设置或固定查询并发限制。

用量快照中的「域名与访问防护」仍是最后部署声明，不是实时核验。「Cloudflare 连接」页面另行读取所选 Zone 与本工具自有自定义规则；只有准确域名的阻止规则匹配且启用时，才显示防护已核验，不能凭 Token 权限推导。这不是 Cloudflare Managed Rules；没有本工具规则也不排除另有 WAF 防护。域名与 WAF 变更仍通过部署 Skill/CLI 计划和应用；旧域名缺少归属回执时需先明确接入方案，不要求删除重建。[域名指引](../deployment/optional.md)说明该边界及备用入口。

```sh
cfkanban admin usage show --mode manual --json --no-interactive
cfkanban admin rate-limits show --json --no-interactive
```

**在网页中：**「管理中心 → 用量与限额」→「刷新用量」。概览的用量摘要也可进入此页。更新时间见「数据详情」；短时间内重复刷新可能仍显示同一份数据。

附件容量包括正在上传、已上传及尚未清理的已删除文件。Cloudflare 指标显示「未配置」时，见[可选部署配置](../deployment/optional.md)。

## 选择附件容量

```text
请用 $cfkanban-admin 将此实例的附件总容量上限设为 2 GiB。
先检查现有占用，保存后确认设置已生效。
```

也可明确选择「不限制」。未设置时不能新增上传；容量设置需要 Owner 权限。要上传文件，还需先启用附件存储，仅设置容量不会自动开启它。

**在网页中：** 「管理中心 → 用量与限额 → 附件应用预算 → 设置上限」。选择容量模式，有限容量按 MiB 输入，保存后核对。`1 GiB = 1024 MiB`。降低上限不会删除已有文件，超出时暂停新上传。

这是 cfKanban 控制上传的容量上限，页面称为「附件应用预算」。它不等于 R2 实际占用，也不是 Cloudflare 账单封顶；已删除文件需实际回收后才释放预算。

## 查看操作记录

```text
请用 $cfkanban-admin 查看 <项目名称> 最近的权限变更。
只看这个项目，说明谁修改了谁的哪些权限。
```

**在网页中：**「管理中心 → 操作记录」显示最新记录在前，按项目和事件类型筛选，再按需「加载更早审计事件」。重新应用筛选开始包含新变更的列表。

## 访问地址与频率限制

```text
请用 $cfkanban-admin 检查 Agent 连接此实例使用的地址，以及当前的访问频率限制，暂不修改。
```

**在网页中：** 「概览 → 服务信息与访问限制」只读展示发行版本、实例地址和请求限制。

「首选 API 地址」用于告知 Agent 推荐的连接地址。新域名配置就绪后，可让 Agent 检查地址变更：

```text
请用 $cfkanban-admin 检查 https://<新域名> 是否确实指向同一实例；
验证通过后提出连接地址的变更方案，并核对新旧入口。
```

Agent 会先核验新地址，不提前向它发送凭据。绑定域名、DNS 和访问频率调整属于[部署操作](../deployment/optional.md)，仅修改应用中的地址不会完成这些配置。

## 保存失败时

发生冲突时，查看最新设置后再保存。结果不确定时核实原操作；能力不可用时，让 Agent 检查站点版本。
