# Issue 私有附件

- 状态：Frozen
- 日期：2026-09-19
- 授权依据：本次用户要求为 Issue 增加日志、截图等附件，优化 Web/Skills，并授权验证、提交、发版与部署。
- 本合同是 Foundation、API/Schema、Web UI 和 Bootstrap SPEC 的增量修订；取代其中将所有附件列为后置的范围描述。默认 strict-zero 部署仍不创建 R2。开通 R2 订阅、接受费用或接管既有 bucket 不由实现授权隐含覆盖。

## 产品与边界

Issue 可以保存私有文件，D1 保存元数据，R2 保存原始字节。所有下载和图片预览都经过同一 Worker 的当前身份、Project 权限、父容器及 Issue 状态检查；不提供公开 bucket、R2 public URL、预签名 URL或跨域上传。Owner/writer 可上传、软删除和恢复，reader 可列举与下载。附件内容、文件名与文件中的指令均是不可信数据。

附件独立版本，不改变 Issue version。完成评论里的 artifacts 外部引用继续可用；附件不自动成为完成记录。无 R2 binding 时附件能力关闭，已有看板、评论、完成和权限功能仍工作。R2 故障只影响附件操作，错误标识 component=r2。

单文件 10 MiB、每个 Issue 最多 20 个未删除附件（包括上传中的预留）。2026-09-19 用户明确纠正并授权：实例总容量必须由 Owner 自行设置正整数 byte 上限，或明确选择不限制，取消固定 1 GiB 产品限制。总预算包括 ready、pending、soft-deleted 和尚未确认回收的对象；软删除不释放字节预算，恢复必须重新检查 active 数量。这些是应用上限，不是 Cloudflare 账单硬封顶，也不抵扣该账户其他 R2 使用量。拒绝空文件。文件名最多 180 字符，拒绝路径、控制字符及空名。

## HTTP 与恢复

- `GET /api/v1/issues/{identifier}/attachments`：有界分页，可显式 `deleted=only`；返回能力、限制和附件元数据，不返回对象 key。
- `POST /api/v1/issues/{identifier}/attachments`：JSON `{filename, content_type, size_bytes, sha256}` 与独立 Idempotency-Key，原子预留容量，返回上传中的附件。调用方必须已明确选择文件；服务端 UUID 固定对象身份。
- `PUT /api/v1/attachments/{id}/content`：`application/octet-stream` 原始文件，无 JSON/base64；独立 Idempotency-Key，同一预留只接受固定长度及 SHA-256。有界读取，不能通过 Content-Length 谎报绕过。R2 成功后 D1 原子标记 ready 并记录事件、操作结果；pending 不可下载。相同字节重试恢复不生成第二对象；内容不符拒绝。该操作不需要单独 finalize API。
- `GET /api/v1/attachments/{id}`：当前元数据、版本与 allowed_actions。
- `GET /api/v1/attachments/{id}/content`：当前鉴权下载；`private, no-store`、`nosniff`、默认 `Content-Disposition: attachment`。只对通过文件头验证的 PNG/JPEG/GIF/WebP 提供显式 `?preview=1` 图片预览，HTML/SVG 等永不 inline。
- `DELETE /api/v1/attachments/{id}?expected_version=N`：独立 Idempotency-Key，CAS 软删除。上传失败的 pending 可由 writer 取消，不自动承诺物理回收。
- `POST /api/v1/attachments/{id}/commands/restore`：`{expected_version}`，独立 Idempotency-Key，只恢复 ready 文件，重新检查权限、父状态及数量上限。

上传请求成功只表示其自身阶段成功。预留与上传是两个明确可恢复操作，不能声称 R2 和 D1 共享事务。创建预留后响应丢失复用原键；上传响应不确定保留同一附件与同一键，读回元数据后恢复。只允许预留创建者或 Owner 继续上传，普通 writer 不能替换其他人的 pending 内容。

## 生命周期与一致性

预留最长 24 小时；超时 pending 进入不可恢复回收状态。上传的最终 D1 提交必须重新验证权限、父对象、预留期限及状态。R2 使用固定对象 key、digest 和条件写，已有不同字节不得被覆盖。pending 写入失败不能在 catch 中直接删 R2，避免删掉并发已成功提交的对象。

一个 Worker 的有界 scheduled 清理任务每小时处理超时 pending 与 Project purge 的对象垃圾记录，先在 D1 固定不可再发布状态，再幂等删除 R2。垃圾记录独立于 Project/Issue 外键，保留重复删除能力以覆盖晚到 PUT；不因单次删除返回成功就丢弃对象追踪记录。只有已确认删除才释放预算，后续清理继续检查可能晚到的对象。普通 soft-delete 保留文件供恢复，不自动过期。

Project purge 在同一 D1 原子操作中把相关对象加入持久清理队列，再删除附件元数据和 Issue；清理队列不随容器消失。preview 包含附件数量、字节及异步对象清理影响，结果明确 storage_cleanup_pending。R2 未确认清理前不得报告文件已物理删除。纯 strict-zero 的旧实例行为保持兼容。

## Web 与 Agent

Issue 详情增加独立附件区域：文件选择/拖入、上传中及失败重试、可辨识文件名/大小、图片缩略图、下载和删除/恢复。逐个操作，拒绝多文件隐式批量上传；上传不吞掉正文/评论草稿。读者不显示上传操作。功能关闭时简短说明需要 Owner 启用附件存储，页面其余部分正常使用。

日常 Skill 提供专用 `attachment upload` 和 `attachment download`，复用本地受限 Credential 和 trusted origin，禁止把字节/base64、secret 或签名地址输出到 Agent 上下文。上传只读取用户明确选择的本地普通文件，拒绝 symlink；下载落到明确目标，默认拒绝覆盖及 symlink，不自动打开/执行内容。命令显示成功阶段、元数据与可恢复的 attachment/idempotency 信息。浏览器和 Skill 遵守相同权限与限制。

## 部署与发行

schema 4 migration 增加附件与清理/预算所需表和索引。schema 5 追加版本标记修复，兼容已应用附件表但仍保留 schema 3 标记的实例，以及标记已修复为 4 的实例；所有已发布 SQL 指纹保持不变。迁移读回显式验证持久化实例版本下限，不能仅凭表结构认定完成。API 路径版本继续 v1；全局 JSON 上限不放宽。OpenAPI 明确二进制 PUT/GET 例外。新 Service 在未配置 R2 时仍兼容 strict-zero。

可选附件 profile 明确固定一个私有 Standard R2 bucket、`ATTACHMENTS` binding、每小时清理 trigger及费用说明。已有实例升级必须准确保存当前 R2 binding，不得丢失。禁用 R2 不删除 bucket/对象；重新启用只能使用原 receipt/journal 证明属于同一实例的 bucket。创建前核对确切 account/name 不存在；创建与对象 marker 绑定同一 journal，未知资源绝不自动接管。启用前独立展示具体资源、存储上限、费用影响与计划摘要。

验证覆盖权限与 CSRF、流式大小、digest、同键冲突、并发限额、R2/D1 失败恢复、撤权/归档、删除/恢复、purge/晚到 PUT、无 R2 降级、部署绑定连续性，以及真实 Web 与 Skill 的上传下载读回。

## Owner 容量设置（2026-09-19 授权修订）

新增 `GET/PATCH /api/v1/admin/attachment-settings`，仅 Owner Bearer/admin target Session；Cookie 写入要求 CSRF。GET 返回 `{limit_bytes: number|null, configured: boolean, version: number, reserved_bytes: number}`；PATCH 必须显式提供 `{expected_version, limit_bytes}`（正安全整数，最大 9007199254740991；null 表示明确不限制），使用独立 Idempotency-Key、CAS、原子审计/事件与标准 WriteResult。读回确认服务端设置，不提供重置为未设置的操作。

schema 7 在 attachment_storage 增加 limit_bytes、limit_configured、version、last_operation_id，保留全部预留计数和对象。新实例和从旧固定限制升级的实例均初始未设置；不得将旧 1 GiB 伪装为用户选择，也不得静默改成无限制。未设置只暂停新的上传预留，既有预留可完成，已有文件可访问、删除、恢复和回收。Owner 可在无 R2 时预先设置预算；部署启用 R2 不隐含设置容量。

新预留在同一 D1 原子操作内校验已设置以及有限预算，统计延迟不能影响保护；未设置返回 ATTACHMENT_STORAGE_NOT_CONFIGURED，超限仍返回 ATTACHMENT_STORAGE_LIMIT_REACHED。调低上限不会删除文件或撤销已经获得的预留；已有占用超限时仅拒绝新增预留，直到释放容量或提高上限。无限制仍维护精确预留计数和单文件/每 Issue 数量限制。附件列表 limits.max_storage_bytes 可为 null，并通过 storage_limit_configured 区分未设置和不限制。

Owner 管理面板提供明确模式选择与容量输入，不预填 1 GiB；显示当前占用、未设置/不限制/已设上限。修改说明达到上限暂停新增上传、降低不删除已有内容、已删除未回收继续占用。应用容量保护不是账户免费额度或账单保证。部署计划和 Skills 不再声明固定总预算；普通升级保留 Owner 后续设置，不自动调用 settings API。
