# Owner Credential 全失恢复增量合同

- 状态：Frozen
- 日期：2026-09-20
- 执行任务：[CFK-418](https://cfkanban.dev/app/issues/CFK-418)
- 基线：[Foundation §5.1](2026-08-26-agent-native-kanban-foundation-spec.md)、[Agent Skills §7.4](2026-08-28-agent-skills-bootstrap-spec.md)

用户已授权补齐技能与脚本，并明确确认：恢复成功撤销同一 Owner 的全部旧 API Credential，保留独立 Passkey。实现授权不包含线上恢复、部署、发布或 Git 提交/推送。

## 身份与影响

恢复只为 D1 `instance_meta.owner_principal_id` 所指的原 Principal 重新签发 Credential；不创建或转移 Owner，不复活旧 Credential，不重建数据库，不改变业务数据、Grants、assignment、历史或 Passkey。旧 API Credential 的所有副本失效，依赖它的 Browser Launch/Session 按既有 source 校验失效；独立 Passkey 及其会话保留。

恢复不提供应用 HTTP endpoint，也不依赖仍有效的应用 Credential。操作者必须掌握准确 Cloudflare account 下的 Worker/D1 控制权限。不得使用首次部署的空库 bootstrap 冒充恢复。

## 目标与授权

用户补充要求同账户多 Worker 先排除非 cfKanban，再选择目标。`owner-recovery discover` 只在已确认账户内有界列举 Worker（可用显式 `workerNames` 缩小），按 D1 binding、实例标记与公开 discovery/health 验证，不靠 Worker 名称。无 DB 或无实例标记表可排除；已有标记但 schema 不完整、权限失败、超时、多个 DB 等必须保留为无法确认项。多个有效实例展示名称、入口和 instance ID 请用户选择；仍有无法确认项时不得假定剩余唯一；唯一候选也只进入待授权计划。工具不返回无关资源配置或业务内容，不枚举账户/profiles，不自动恢复。默认最多检查 100 个 Worker，控制面响应上限 64 KiB；超限明确停止并缩小范围，不静默截断。

`owner-recovery inspect` 与 `plan owner-recovery` 只读核对准确账户、Worker 当前单版本、`DB` binding、D1 UUID/name、instance ID、原 Owner、当前 active Credential IDs 和 D1 中的 preferred origin；再无凭据探测该 origin 的 discovery/health。不得根据 display name、同名资源或陌生 origin 自报 instance ID 建立信任。

优先使用仍存的可信 receipt/journal 目标。整个本地状态丢失时，用户从已验证候选中选择或显式指定准确目标，控制面读回证明现有 instance/Owner 与公开入口一致后，可生成新的恢复计划；这只授权该实例的 Credential 恢复，不是部署工具对未知资源的自动接管。Owner 名称与 ID 以 D1 为准，不询问新名称、不从 OS/Git 猜身份。

计划冻结 task ID、operation ID、替代 Credential/Event IDs、Cloudflare auth 上下文与资源身份、Worker 版本/bindings 摘要、实例/Owner/active Credential 快照、撤销影响及本地保存规则。用户看到准确计划后授权，journal 绑定同一 task/operation/digest；账户、目标、来源、撤销范围或快照漂移须重新计划。普通部署、正常轮换的授权不隐含全失恢复。

## 原子写入与续做

- `owner-recovery execute` 仅接受独立恢复计划及匹配的 journal 授权。先验证私有存储；替代 secret 直接进入本地 pending，不进入参数、环境、日志、普通输出或 receipt。只剩 current metadata、secret 文件丢失可恢复；仍有 current secret 时先核对并走正常轮换；不同 Principal 或其他 unresolved pending 必须停止整理。
- 控制面认证沿用准确 profile 或私有 context；捕获 Wrangler token 只留在内存，不枚举 profile，不改变登录，不输出原始 Cloudflare 响应。Cloudflare Token 与 cfKanban Credential 不能相互替代。
- 通过固定 Cloudflare D1 REST `/query` 的一个参数化 `batch`，原子完成：条件插入新 Credential、撤销全部旧 active API Credential、追加 `owner.credential_recovered` security Event、写 operation commit。SQL 不通过命令参数或文件 ingestion；不包含显式事务控制，不创建 schema 对象。active Credential 集合或实例/Owner/origin/schema 信息已变则条件拒绝，无写入。
- batch 合同参考：[Cloudflare Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) 与 [D1 batch 事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。实现与隔离测试必须覆盖失败回滚；本地测试不能冒充云端演练。
- 远端错误或响应丢失后保留同一 secret/operation，下一次执行先读回精确 Credential、Event、operation commit 及旧凭据撤销证据。完整提交则只最终化；准确未提交且原快照未变才允许同操作重试；部分记录、冲突或替代 Credential 已撤销时停止，不猜测回滚。
- 云端确认后，以 pending secret 在冻结的 origin 验证 `/meta`、`/me` 的 instance、origin、Service/schema、Owner flag、Principal ID、Credential ID/fingerprint；匹配后才写本地可信实例记录、提升 current、写脱敏恢复 receipt。最终化中断后复用 pending/current，不签发第二凭据。
- 同实例本地执行使用互斥锁。正常退出释放；进程被硬杀后，先确认锁中 PID 对应进程已停止，再移除准确的 `owner-recovery.lock`。不得因此删除 pending、journal 或整个私有目录。

当前实现每次最多恢复 256 个旧 active Credential，只支持已知 schema 1–7；越界或不兼容时停止，不截断 inventory、不迁移数据库。本轮不改变 canonical release/install 合同，源码增加命令不代表已发布或用户当前插件已更新。
