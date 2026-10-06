# Owner 发行信息入口

- 状态：Frozen
- 日期：2026-10-06
- 授权依据：用户要求在 `feat/v1.10` 完成 CFK-619；只读版本发现沿用不可变工件及独立升级授权合同。
- 执行任务：[CFK-619](https://cfkanban.dev/app/issues/CFK-619)

## 入口与比较

管理中心新增「版本与更新」。仅允许 Deployment Owner Bearer 或实例管理范围 Owner Session；窄 Owner Session、局部管理员及普通用户不可访问 `GET /api/v1/admin/release-updates`。公共 CLI `admin updates show` 与 Agent 安全 API 返回相同信息。

当前版本来自执行中 Worker 的 `release_version`。GitHub Latest API 提供最新正式版；最近 20 份发行中最多展示 5 份非草稿预发行，按严格 SemVer 倒序，数字预发行项按数值比较。页面明确窗口范围，不将 RC 当默认升级目标；未知版本不能冒充已完成比较。

每项返回准确版本、可信官方 Release 链接、发布时间及是否较新。信息不证明兼容，不替代 manifest/digest 校验；升级仍经只读发现、不可变工件快照、显式目标与获批计划。

## 查询与失败

固定 GitHub Release API 匿名 GET，禁止 redirect，不转发 Credential/Cookie。两个查询各超时 5 秒、响应各最多 512 KiB，不翻页。校验版本、发行属性、时间和官方链接；不呈现或执行返回 Markdown。

Worker isolate 内仅缓存公共信息，成功 15 分钟复用，失败至少 60 秒退避，合并并发请求。缓存不持久化，重启后重查，不承诺跨 isolate 全局限流。两个通道独立返回 fresh、stale、unavailable、最近成功/尝试/可再查时间。失败保留旧信息并标过期；无旧信息时明确未知，不影响其他能力，返回前重新核验 Owner。

## 技能与实例独立

页面分开提供本地技能检查/更新与实例升级指引。不访问 OS 私有状态，不把服务端版本等同本地技能版本；提示本地 `cfkanban --version` 与完整 bundle/宿主核验。查询不执行更新，预发行须明确准确版本。

自动通知设置遵循[升级通知增量](2026-10-06-instance-upgrade-notifications-spec.md)，查询本身不发布公告。双语说明同步；隔离测试覆盖缓存、并发、排序、失败、链接校验及权限。本地证据不代表线上发行或部署。

接口事实参考[GitHub 官方文档](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28)。
