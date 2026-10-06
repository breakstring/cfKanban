# Owner 发行信息入口

- 状态：Frozen
- 日期：2026-10-06
- 授权依据：用户要求在 `feat/v1.10` 完成 CFK-619；只读版本发现沿用不可变工件及独立升级授权合同。同日用户进一步要求合并页面升级指引、提供可复制提示，并明确采用 GitHub 公开网页发现替代 REST API，不维护额外静态索引分支。
- 执行任务：[CFK-619](https://cfkanban.dev/app/issues/CFK-619)、[CFK-627](https://cfkanban.dev/app/issues/CFK-627)

## 入口与比较

管理中心新增「版本与更新」。仅允许 Deployment Owner Bearer 或实例管理范围 Owner Session；窄 Owner Session、局部管理员及普通用户不可访问 `GET /api/v1/admin/release-updates`。公共 CLI `admin updates show` 与 Agent 安全 API 返回相同信息。

当前版本来自执行中 Worker 的 `release_version`。GitHub 官方 `/releases/latest` 的准确 tag 重定向提供最新正式版；公开 `/releases` 列表第一页内最多检查 20 张发行卡片，按 GitHub 原生 Pre-release 标记识别预发行，按发行发布时间倒序最多展示 5 份。不翻页，不承诺第一页含完整 20 项，不以 tag 后缀推断通道或以版本名决定列表顺序。页面明确窗口范围，不将 RC 当默认升级目标；未知版本不能冒充已完成比较。

每项返回准确版本、可信官方 Release 链接、发布时间及是否较新。准确 tag 保留严格 SemVer 格式校验；「较新」继续比较目标与当前实例版本，不能以晚发布时间推断升级方向。信息不证明兼容，不替代 manifest/digest 校验；升级仍经只读发现、不可变工件快照、显式目标与获批计划。

## 查询与失败

固定 GitHub 公开网页匿名 GET，不请求 GitHub REST API，不转发 Credential/Cookie。正式通道只允许 `/releases/latest` 到同一官方仓库准确 `/releases/tag/<version>` 的一次手动重定向，再读取该页；列表页和准确 tag 页不跟随额外重定向。每通道整个请求和解析过程共用 5 秒期限，每个 HTML 响应流式限制为 1 MiB。

使用 Worker 原生 HTMLRewriter 按原生发行卡片边界提取准确 tag、发行时间和 Pre-release 标记，排除发行正文中的链接、徽标和时间。不呈现或执行远端 HTML/Markdown。未知页面结构、缺失或冲突字段、跨源/跨仓库链接和异常响应都作为查询失败；初始固定 latest 的 404 沿用无正式版语义，列表仅明确的正常空发行结构可返回成功空列表。

Worker isolate 内仅缓存公共信息，成功 15 分钟复用，失败至少 60 秒退避，合并并发请求。缓存不持久化，重启后重查，不承诺跨 isolate 全局限流。两个通道独立返回 fresh、stale、unavailable、最近成功/尝试/可再查时间。失败保留旧信息并标过期；无旧信息时明确未知，不影响其他能力，返回前重新核验 Owner。

## 技能与实例独立

页面以「交给 Agent 升级」合并操作指引，提供可复制的双语提示和次要帮助入口。本地技能与实例仍为两个独立计划：先核对本机版本、完整 bundle 与宿主安装并确认技能更新计划，再检查此实例身份、不可变工件、兼容性和升级计划，另经 Owner 确认后执行。页面不访问 OS 私有状态，不把服务端版本等同本地技能版本。

提示包含当前页面实例 origin；Owner 可显式选择已发现的准确正式版或预发行版，默认不选择 RC，也不以当前实例版本推断升级目标。没有选择时要求 Agent 先检查可用版本并让 Owner 明确目标；刷新后目标不在列表或 Session 变化时清除选择。复制只交付文本，不安装技能、不部署实例、不发布通知。复制成功与失败提供双语反馈。

自动通知设置遵循[升级通知增量](2026-10-06-instance-upgrade-notifications-spec.md)，查询本身不发布公告。双语说明同步；隔离测试覆盖缓存、并发、排序、失败、链接校验及权限。本地证据不代表线上发行或部署。

公开来源为[正式版入口](https://github.com/breakstring/cfKanban/releases/latest)与[发行列表](https://github.com/breakstring/cfKanban/releases)。网页结构不是稳定 API；解析漂移沿既有失败/旧缓存合同处理。
