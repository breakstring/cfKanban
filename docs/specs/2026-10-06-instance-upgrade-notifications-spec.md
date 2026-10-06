# 部署升级后的实例版本通知

- 状态：Frozen
- 日期：2026-10-06
- 关联：[CFK-620](https://cfkanban.dev/app/issues/CFK-620)、[CFK-630](https://cfkanban.dev/app/issues/CFK-630)
- 基础：[实例通知](2026-10-01-instance-notifications-spec.md)、[发行生命周期](2026-09-20-stable-release-lifecycle-spec.md)、[公共 CLI](2026-10-04-public-cli-spec.md)
- 授权：2026-10-06 用户确认默认关闭；正式版和 RC 的版本前进触发；回滚和同版本部署不触发。随后授权公告提供可复制给 Agent 的准确版本提示，仅更新本地插件和技能。

## 设置与触发

Owner 实例管理页和 API / CLI 提供持久化开关；默认关闭。不增加新的管理角色。`GET/PATCH /api/v1/admin/upgrade-notification-settings` 返回 `{enabled,version}`；PATCH 使用 `{enabled,expected_version}` 与 Idempotency-Key，实时 Owner 实例管理权限、CAS、不可变幂等结果和安全审计原子提交。Owner 窄项目 Session、局部管理员及普通参与者拒绝；Cookie 保留同源和 CSRF 检查。

成功事件仅由既有 `deploy upgrade apply/resume` 最终化产生：准确获准工件、迁移 ledger 与实际 schema、Cloudflare 部署和 Worker version、`healthz`、discovery、认证 `/meta` 与 `/me` 均已读回且匹配后，才尝试一次通知命令。首次部署、失败、仅本地 Skills 更新、同版本重部署及版本回退不发布。版本顺序使用 SemVer，仅正式版和 `rc.N` 触发，RC 到更高 RC / 正式版同样算前进；alpha / beta 及其他预发行返回 `unsupported_channel`，runtime 不发通知请求，Service 同样原子记录跳过结果；build metadata 不改变顺序。未知旧产品版本不推断为更旧，不发布。

`POST /api/v1/admin/notifications/commands/publish-upgrade` 只表达一个原子操作，body 为 `{previous_release_version,release_version,deployment_id,worker_version_id}`，需要 Owner 实例管理权限和 Idempotency-Key。Service 核对传入新版本等于正在执行的 Worker 构建声明，Owner runtime 负责上述云部署及版本变化证明；普通 Web 不构造升级成功事件。命令在一次 D1 原子 batch 内按提交时开关决定发布，返回 `{status,release_version,previous_release_version,deployment_id,worker_version_id,notification_id}`，status 为 `published/already_published/disabled/not_forward/unsupported_channel`。这些结果、业务写入、幂等快照及安全审计原子提交。

## 公告、去重与恢复

复用实例公告及个人确认 / 接收起点 / 偏好 / 历史。只存一份中英双语纯文本公告，不逐用户 fanout；关闭个人接收仍能主动查看历史。模板保留实际旧 / 新产品版本和准确 GitHub Release 链接，简短说明站点升级不会自动更新本地插件和技能，并提供可直接复制给 Agent 的中文和英文请求：使用 `cfkanban-deploy` 技能将本地 cfKanban 插件和技能更新到本次准确新版本。请求仅更新本地，不要求再次部署已经升级的站点，不执行 IP / DNS 探测；文档入口作为次要帮助信息。公告不代表本地更新已发生，读取或转述公告本身不授予自动执行权限。

schema 21 新增开关及不可变发行去重记录。以实例内 `release_version` 唯一约束去重：不同维护者、设备、部署 ID 或 Idempotency-Key 对同一发行只能创建一份自动公告；回滚后再升级到曾通知的同发行也最多一份。撤回公告不移除去重记录。同版本部署无新增公告。新的自动公告可由 Owner 沿既有 CAS 撤回，正文不可编辑。

runtime 在通知请求前将非秘密准确 request、实例、caller Principal / Credential ID、origin 和稳定 key 写入原升级私有 journal。成功读回结果另存 journal；中断或未知结果保持相同 request / key / caller，不切换渠道或创建替代 key。升级 receipt 和 `finalized:true` 独立于通知结果；通知异常返回单独的可恢复结果，不能掩盖已经验证的部署成功。同计划 resume 重新核验升级读回后，以原 request / key 恢复；若部署后来已变化，不能把当前最新设置或新请求当成原事件恢复，原请求可使用公开 CLI 保留同 key 核实。超过 23 小时安全重放窗口，不自动重放未知结果，先核对原审计和准确发行的发布记录。`GET /api/v1/admin/notifications/upgrade-releases/{release_version}` 按发行唯一键有界查询不可变发布证据；没有记录不能证明未知请求未提交。通知失败不自动再次部署 Worker，也不修改个人偏好。

## 等价入口与验收

Web 提供 Owner 开关与 CAS 反馈；公共 CLI 提供 `admin upgrade-notification show/configure/publish/release`，Agent 可使用相同 API，公开双语设置 / 部署文档同步。CLI 对实际发布通过准确发行记录核对 notification ID；无公告的关闭 / 非前进结果以原 key 重放并核对冻结 snapshot，不能从当前开关推断原结果。MCP 未覆盖的新能力按既有 Skill 安全 API / CLI 路径使用。

验收使用隔离本地 D1 与合成凭据，覆盖默认关闭、Owner / Session 范围拒绝、开关 CAS / 幂等 / 审计回滚、实际 Worker 版本不符、同版本 / 回退 / RC 前进 / alpha 和 beta 排除、不同 key 并发去重、个人关闭接收仍可查历史、通知撤回后去重、失败 / 响应丢失保留原key恢复和升级结果独立。源码及本地模拟不等于真实 Cloudflare 部署或线上通知已验收。
