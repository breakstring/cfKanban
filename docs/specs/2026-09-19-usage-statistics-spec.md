# 管理员用量与限额

- 状态：Frozen
- 日期：2026-09-19
- 执行任务：[CFK-404](https://cfkanban.dev/app/issues/CFK-404)
- 授权依据：用户接受用量统计方案并明确授权按适当方式实现；不隐含部署、付费、凭据扩权或 Git 提交。
- 本文是 API/Schema、Web UI、Bootstrap 合同的增量修订。

## 范围与权限

提供 Owner-only `GET /api/v1/admin/usage`，Bearer Owner 和 admin target Web Session 可读；普通参与者及单 Project Session 不得读取实例统计。使用 no-store。Web 与 Agent 使用相同投影。不新增逐请求计数，不把查询次数等同于计费读写行数，不从本实例推算账户剩余额度。

首版包括附件应用预留预算和可选 Cloudflare D1/R2 统计。Workers 趋势、账户全量统计、账单估算、历史报表、手动快照上传、自动告警后置。项目 active quota 继续沿用原有 Project 管理入口，不将 Public Join 停用计数作为真实项目总量。

附件数据复用 attachment_storage.reserved_bytes；Owner 明确设置的容量上限（或不限制）、设置版本及 R2 enabled 状态。预留含上传中、就绪、软删除及未确认回收对象；仅回收成功释放。这是应用预算，不是 R2 容量或账单封顶。无 R2 仍返回准确预算与 disabled 标识。

## HTTP 投影

顶层固定 `{ generated_at, attachments, cloudflare }`。

- attachments：`{ enabled: boolean, reserved_bytes: number, limit_bytes: number|null, limit_configured: boolean, settings_version: number }`。
- cloudflare：`{ status, refreshing, collected_at, attempted_at, error, metrics }`。refreshing 为 boolean；status 为 `not_configured | pending | fresh | stale | error`；时间为 ISO UTC 或 null；error 为稳定安全分类或 null，不含供应商响应、Token、SQL、资源名称或账户 ID。
- metrics 为有界数组，各项 `{ key, value, unit, source, scope, period_start, period_end, observed_at }`。value 是有限非负 number 或 null；scope 固定 instance；source 固定 cloudflare；时间为 ISO UTC 或 null。unit 为 bytes/count。key 固定 `d1_storage_bytes | d1_rows_read | d1_rows_written | r2_storage_bytes | r2_objects | r2_operations`。
- 日读写与 R2 操作采用 UTC 当日 00:00 至采集时刻窗口；容量采用最近 24 小时最后一个完整观测桶的值，不跨时间累加；observed_at 使用供应商观测时间，不能伪装采集时间。无数据为 null。上游覆盖窗口和延迟须在 UI 清楚说明。
- 快照距采集达到 15 分钟为 stale。无配置不返回旧统计；失败保留上次成功快照并将 status 置 stale（无成功值为 error）。

## 可选采集与持久化

统计开关默认启用，`USAGE_ANALYTICS_ENABLED=false` 才显式关闭。未配置完整 `USAGE_ACCOUNT_ID`、`USAGE_D1_DATABASE_ID` 和独立只读 `USAGE_ANALYTICS_TOKEN` Worker Secret 时为 not_configured；R2 统计另需可选 `USAGE_R2_BUCKET_NAME`。开关默认启用不隐含创建 Token、扩展权限或账户枚举。Token 最小权限须在部署 preflight 实测，不复用本机 Wrangler OAuth。

`POST /api/v1/admin/usage/refresh` 接受 `{mode: "stale" | "manual"}`，返回与 GET 相同的完整投影。Owner/admin 身份与 Cookie CSRF 验证先于任何采集。该端点只刷新派生统计缓存，是领域写入合同的明确例外：不要求 Idempotency-Key，不写领域 Event/Audit 或 operation_commits，不修改业务资源。重复请求通过单行原子 claim 合并，不产生重复业务动作。

打开面板先 GET；首次/过期/上次失败时发送 mode=stale，成功快照不足15分钟则复用。手动按钮与每次技能用量查询使用 mode=manual；两种 mode 统一复用不足15分钟的成功快照，不提供绕过缓存的强制采集。技能无需先GET。所有模式受实例级60秒尝试冷却约束（含失败和资源配置变化）；最大两次10秒超时小于冷却期，不持久保存无限锁。并发失败claim返回当前投影，`refreshing` 标记正在采集，不轮询。进程中断后最多60秒可再次尝试。claim清除错误标记，但未完成尝试的旧快照始终为 stale；60秒内显示 refreshing，失败或60秒后解除。旧采集结果不得覆盖新配置/新尝试。

不设置统计 Cron，也不后台自动轮询；只有用户打开面板、查询用量或请求刷新时才按服务端缓存决定是否采集。附件每小时清理保持原合同。刷新异常保留最后成功快照与安全错误分类，不阻塞预算展示或业务。

只允许固定 https://api.cloudflare.com/client/v4/graphql，无用户自定义 endpoint，不跟随重定向。GraphQL 查询变量绑定准确账户、数据库 UUID 与可选桶名；有界结果、超时和解析，处理 HTTP 429、GraphQL errors、空值、部分结果。不能把 GraphQL HTTP 200 当作全部成功。首版每轮最多两个请求，GET 只读取快照，POST 按需采集；不自动重试失败请求。统计故障不影响附件清理。

追加兼容 migration/schema 6，单行保存最新成功快照与最近尝试状态；不保存凭据、原始供应商响应或无限历史。并发采集按尝试起始时间 CAS，旧尝试不得覆盖新尝试结果。读取和采集与核心业务写入隔离。

## 界面与交付

Owner 设置增加用量区域，显示附件字节值；仅有限上限显示预算百分比，未设置与不限制分别标识，并提供 Owner 容量设置入口（见附件 SPEC）、云端统计状态与一次简短本地更新时间（当日仅时分）。指标采用紧凑网格，不重复展示逐项日期时间；准确 UTC 窗口、采集/观测时间放在默认折叠的数据详情中。打开面板按缓存新鲜度刷新，并提供手动刷新按钮；不提供触发付费或修改凭据的操作。English/简体中文一致；未知、未配置、过期与错误独立于真实零值。保留已显示数据时清楚标记不可用或过期。日累计量、观测容量、应用预算分别说明。

部署工具必须保证升级不会静默丢失已有统计配置；附件每小时 trigger 仍独立保留；本地配置只包含非秘密资源参数，Secret 使用独立受限输入与 Cloudflare Secret 管理。实际上线与新增只读 Token 须另行授权。当前实现交付包括配置文档、API/OpenAPI、迁移验证、隔离测试与 Web 检查；不宣称真实 Analytics 凭据已验证。

## 验证

覆盖 Owner/participant/Project Session、未配置/无 R2、零与未知、UTC 窗口、容量与累计口径、过期快照、超时/429/GraphQL 错误/部分数据、资源过滤、并发旧结果保护、Secret 脱敏及附件回收预算连续性。现有合同与本地隔离测试通过后才记录完成；线上统计验证单独列为尚未执行。

## 数据源核对

2026-09-19 只读查询 Cloudflare 官方 GraphQL introspection，确认 `AccountD1StorageAdaptiveGroups.max.databaseSizeBytes`、`dimensions.datetime`，以及按 databaseId / datetime_geq / datetime_lt 过滤。参考 [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) 与 [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)。该检查只验证类型定义，不代表新部署的 Analytics Token 已获所需权限或账单口径已验证。
