# 管理员用量与限额

- 状态：Frozen
- 日期：2026-09-19
- 执行任务：[CFK-404](https://cfkanban.dev/app/issues/CFK-404)
- 授权依据：用户接受用量统计方案并明确授权按适当方式实现；不隐含部署、付费、凭据扩权或 Git 提交。
- 本文是 API/Schema、Web UI、Bootstrap 合同的增量修订。

## 范围与权限

提供 Owner-only `GET /api/v1/admin/usage`，Bearer Owner 和 admin target Web Session 可读；普通参与者及单 Project Session 不得读取实例统计。使用 no-store。Web 与 Agent 使用相同投影。不新增逐请求计数，不把查询次数等同于计费读写行数，不从本实例推算账户剩余额度。

包含附件存储上限和可选 Cloudflare D1/R2/Workers 统计；账期、账户聚合及日度历史分别按 [成本保护](2026-10-07-cloudflare-cost-protection-spec.md) 和 [Owner 管理增量](2026-10-07-owner-cloudflare-control-spec.md) 扩展。预算通知已退役，不提供账单估算或手动快照上传。项目 active quota 继续沿用原有 Project 管理入口，不将 Public Join 停用计数作为真实项目总量。

附件数据复用 attachment_storage.reserved_bytes；Owner 明确设置的容量上限（或不限制）、设置版本及 R2 enabled 状态。预留含上传中、就绪、软删除及未确认回收对象；仅回收成功释放。这是应用预算，不是 R2 容量或账单封顶。无 R2 仍返回准确预算与 disabled 标识。

## HTTP 投影

顶层为 `{ generated_at, attachments, cloudflare, public_access }`；`public_access` 是成本保护增量定义的兼容部署快照。

- attachments：`{ enabled: boolean, reserved_bytes: number, limit_bytes: number|null, limit_configured: boolean, settings_version: number }`。
- cloudflare：`{ status, refreshing, collected_at, attempted_at, error, metrics, billing, alerts }`。refreshing 为 boolean；status 为 `not_configured | pending | fresh | stale | error`；时间为 ISO UTC 或 null；error 为稳定安全分类或 null，不含供应商响应、Token、SQL、资源名称或账户 ID。
- metrics 为有界数组，各项 `{ key, value, unit, source, scope, period_start, period_end, observed_at }`。value 是有限非负 number 或 null；scope 为 instance 或显式开启的 account；source 固定 cloudflare；时间为 ISO UTC 或 null。unit 为 bytes/count/microseconds。原六项 `d1_storage_bytes | d1_rows_read | d1_rows_written | r2_storage_bytes | r2_objects | r2_operations` 保留；Workers、R2 分类与账期指标见成本保护增量。`billing` 保留比较所需套餐及窗口，`alerts` 兼容返回空数组。
- 日读写与 R2 操作采用 UTC 当日 00:00 至采集时刻窗口；容量采用最近 24 小时最后一个完整观测桶的值，不跨时间累加；observed_at 使用供应商观测时间，不能伪装采集时间。无数据为 null。上游覆盖窗口和延迟须在 UI 清楚说明。
- 快照距采集达到 15 分钟为 stale。无配置不返回旧统计；失败保留上次成功快照并将 status 置 stale（无成功值为 error）。

## 可选采集与持久化

统计开关默认允许采集，`USAGE_ANALYTICS_ENABLED=false` 显式关闭。Token 优先使用统一 `CFKANBAN_API_TOKEN`，缺失时回退旧 `USAGE_ANALYTICS_TOKEN` Worker Secret。account / DB / Worker 优先保留明确 `USAGE_*`，缺失时取已批准 `CFKANBAN_CONTROL_*` 固定目标；存在固定目标时拒绝不一致的资源。缺少有效 account / DB / Token 为 not_configured；R2 另需可选 `USAGE_R2_BUCKET_NAME`。不开启账户枚举、不自动创建或扩权 Token、不复用本机 Wrangler OAuth。

`POST /api/v1/admin/usage/refresh` 接受 `{mode: "stale" | "manual"}`，返回与 GET 相同的完整投影。Owner/admin 身份与 Cookie CSRF 验证先于任何采集。该端点只刷新派生统计缓存，是领域写入合同的明确例外：不要求 Idempotency-Key，不写领域 Event/Audit 或 operation_commits，不修改业务资源。重复请求通过单行原子 claim 合并，不产生重复业务动作。

打开面板先 GET；首次/过期/上次失败时发送 mode=stale，成功快照不足15分钟则复用。Agent/API 显式查询可使用 mode=manual；网页不再提供手动刷新按钮。两种 mode 统一复用不足15分钟的成功快照，不提供绕过缓存的强制采集。技能无需先GET。所有模式受实例级60秒尝试冷却约束（含失败和资源配置变化）；最大两次10秒超时小于冷却期，不持久保存无限锁。并发失败claim返回当前投影，`refreshing` 标记正在采集，不轮询。进程中断后最多60秒可再次尝试。claim清除错误标记，但未完成尝试的旧快照始终为 stale；60秒内显示 refreshing，失败或60秒后解除。旧采集结果不得覆盖新配置/新尝试。

快照不新增统计 Cron，也不后台无限轮询；打开页面、保存连接、返回页面或 Agent/API 请求时按服务端缓存决定是否采集。日度历史必须显式启用，启用后复用已有维护触发；页面最多自动补采最近七个完整 UTC 日中的一个缺日，遵守 60 秒冷却，不循环回填。采集响应丢失后仅有限 GET 读回，不重发采集。附件每小时清理保持原合同，统计异常不阻塞附件容量或业务。

只允许固定 https://api.cloudflare.com/client/v4/graphql，无用户自定义 endpoint，不跟随重定向。GraphQL 查询变量绑定准确账户、数据库 UUID 与可选桶名；有界结果、超时和解析，处理 HTTP 429、GraphQL errors、空值、部分结果。不能把 GraphQL HTTP 200 当作全部成功。每轮最多两个请求，GET 只读取快照，POST 按需采集；不自动重试失败请求。统计故障不影响附件清理。

原 schema 6 单行快照继续保存最新成功值与最近尝试状态；日度历史由 Owner 管理增量的有界派生表承载。不保存凭据或原始供应商响应，不改写已发行迁移；本轮继续兼容 schema 27。并发采集按尝试起始时间 CAS，旧尝试不得覆盖新尝试结果。读取和采集与核心业务写入隔离。

## 界面与交付

Owner 的「概览」只保留用量摘要；「用量与配额」顶部为统一 Token 空输入与「保存」，已配置时持续显示已保存状态。保存、核验、权限检查及数据加载自动连续完成，具体凭据和未知结果规则见 Owner 管理增量。

当日指标与每日历史在同页连续呈现；今日仅显示 UTC 日窗口一致的日值，账期累计收进数据详情，容量单独标识观测口径。历史提供最近 7/30/90 个完整 UTC 日，不包含今天。附件区域显示实际预留字节与「附件存储上限」，仅有限上限显示占比；未设置和不限制分别表示，提供 Owner 设置入口。高级统计项从详情就地打开编辑弹窗，访问频率放在页面底部。

不再要求用户手动核验、刷新、读取或补采；有限自动恢复停止后保留当前数据及具体失败原因，不误示成功或持续请求。English/简体中文一致，未知、未配置、过期、错误与真实零值区分。准确 UTC 窗口、采集/观测时间放在默认折叠的数据详情中，不把日累计、观测容量和附件存储上限混为同一口径。

部署工具必须保证升级不会静默丢失已有统计配置；附件每小时 trigger 仍独立保留；本地配置只包含非秘密资源参数，Secret 使用专用浏览器表单或既有受限 Cloudflare Secret 管理。实际上线与新增只读 Token 须另行授权。当前实现交付包括配置文档、API/OpenAPI、迁移验证、隔离测试与 Web 检查；不宣称真实 Analytics 凭据已验证。

## 验证

覆盖 Owner/participant/Project Session、未配置/无 R2、零与未知、UTC 窗口、容量与累计口径、过期快照、超时/429/GraphQL 错误/部分数据、资源过滤、并发旧结果保护、Secret 脱敏及附件回收预算连续性。现有合同与本地隔离测试通过后才记录完成；线上统计验证单独列为尚未执行。

## 数据源核对

2026-09-19 只读查询 Cloudflare 官方 GraphQL introspection，确认 `AccountD1StorageAdaptiveGroups.max.databaseSizeBytes`、`dimensions.datetime`，以及按 databaseId / datetime_geq / datetime_lt 过滤。参考 [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) 与 [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)。该检查只验证类型定义，不代表新部署的 Analytics Token 已获所需权限或账单口径已验证。
