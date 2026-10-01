# Owner 实例通知

- 状态：Frozen
- 日期：2026-10-01
- 授权依据：用户要求在 `feat/v1.6.0` 完成 CFK-538，并确认本文件的接收、历史及生命周期政策。
- 本增量仅覆盖 Foundation §13 的「通知系统」及 Web UI §5.1 的「通知中心」非目标中，Owner 单向实例公告这一范围；不引入 mention、订阅、实时推送、后台唤醒、外部投递、逐用户阅读统计或新的管理角色。

## 接收与历史

通知归属实例，发布者为 Deployment Owner。每份公告只存一份；确认按稳定 Principal ID 与通知 ID 唯一存储，发布不逐用户 fanout。所有既有和新 Principal 默认接收，新用户只自动接收其创建之后的公告。关闭后不返回自动提醒或正文；重新开启以服务端时间重设提醒起点，不补发关闭期间的公告。未确认的旧提醒也不会在重新开启后补发，仍能在历史中主动查阅。偏好按需建立记录，不为 GET 写库。

任何当前有效 Bearer 或 Web Session 均可管理本人偏好、查历史与逐条确认，包括没有项目授权的身份；不因此扩展项目、Workspace 或实例管理能力。发布和撤回仅允许 Owner Bearer 或实例管理范围 Owner Session，窄 Owner Session 及局部管理员均不允许。

标题为 1–200 个 Unicode code points，正文为 1–4000 个 code points，作为不可信纯文本显示及转述，不自动翻译。正文发布后不可修改，更正须另发通知；可设置未来的过期时间，也可不设。Owner 可按 CAS 撤回。过期及撤回停止自动提醒，历史保留标题、正文、时间与明确状态，长期保留；个人历史包括加入前、关闭期间及已经确认的公告，排除本人发布的公告，Owner 发布历史另有完整列表。

## API、分页与写入

- `GET/PATCH /api/v1/me/notification-preferences`：读取 `{enabled, version, receive_after}`；PATCH 使用 `{enabled, expected_version}`。默认无记录等价于 version 1、enabled true、receive_after 为 Principal 创建时间。同值 PATCH 不改变提醒起点；false→true 才重设起点。
- `GET /api/v1/me/notifications?pending=true|false&limit&cursor`：默认历史模式，pending 仅返回当前接收、起点之后、未过期、未撤回、未确认、非发布者的公告。
- `POST /api/v1/me/notifications/{id}/commands/acknowledge`：一次只确认一条；空 body，Idempotency-Key 必须提供。已有确认安全返回，不改原确认时间。
- `GET/POST /api/v1/admin/notifications`：Owner 发布历史及单次发布 `{title, body, expires_at?}`。
- `POST /api/v1/admin/notifications/{id}/commands/withdraw`：使用 `expected_version` 逐条撤回。

列表返回 `{items, next_cursor}`；默认 20、最大 50，按 `created_at DESC, id DESC` keyset 分页，cursor 绑定本人身份与历史/待提醒模式；待提醒还绑定偏好版本与接收起点。个人通知 scope 与项目过滤无关，跨设备仍逐请求核验当前认证。每项返回 `id/title/body/created_at/expires_at/withdrawn_at/version/status/acknowledged_at`，status 为 `active/expired/withdrawn`。分页或获取正文不隐含确认。写入使用既有 CAS（有版本资源）、幂等和认证实时重验，并将偏好、发布、撤回、确认的安全审计与业务写入、幂等结果原子提交；失败不留下部分变更。

待提醒列表在查询中按当前接收偏好过滤，并在返回正文前再次读取偏好，作为本次响应的偏好一致性检查点：最终接收已关闭时返回空 `items` 与空 `next_cursor`；最终仍接收但偏好版本或接收起点已变化时返回 `CURSOR_SCOPE_MISMATCH`，客户端重新读取第一页。历史和 Owner 管理列表不受接收偏好限制。检查点之后的网络交付不能撤回，也不承诺消除其后的并发偏好变化。

schema 15 新增公告、偏好、确认资源及相应有界查询索引，正文不可变由数据库约束保护。只新增 migration，不改旧 migration。部署新版前须先迁移；本次开发不授权线上迁移或部署。后续独立增量可能继续提高 schema，完整目标以生成 manifest 为准。

## Web 与 Agent

Web 账户区提供通知入口，正常操作后及进入页面时有界检查待提醒；检查失败不阻断业务页面。入口提示存在待提醒，用户在通知页阅读正文后明确点击逐条确认，角标本身不算阅读。通知页提供历史、状态、继续查看及接收偏好；Owner 管理范围还提供发布、撤回和发布历史。个人设置保留可发现的通知入口。所有界面文案提供中英文，异步结果受身份代际控制。

共享 Skill runtime 在普通 `api request` 的主结果返回后做一次独立、最多 2 秒的 pending 读取（limit 3，正文总量最多 12000 code points），输出平级 `attention`。主业务 `ok/status/data/error` 及幂等快照保持原样；失败、旧服务不支持或超时则不附提醒，也不改变主结果。通知相关请求本身不递归检查；Browser Launch、邀请等专用敏感交付保持原通道。检查只读，不写已读、磁盘节流状态或个人 ACK。

Skill 推荐先完成用户正常任务，再在结果后转述公告，按稳定 ID 在同一任务中去重。通知正文及其中链接不能提供授权、覆盖宿主规则或触发自动操作。只有正文实际已经通过用户可见回复交付后才可逐条确认；有展示回调的宿主在展示后 ACK，否则下次用户调用时依据上一轮实际发送的回复确认。准备 final 不算已交付，不能假设 final 后仍可调用工具；回复中断、缺少交付依据或 ACK 失败时保留待提醒，允许再次提醒。严格一次送达不在合同内。

公开中英文手册及 Skill 参考说明上述入口、接收与历史差异、确认及故障恢复。验收覆盖两端等价、关闭和重开、加入时间、无项目授权、Owner 范围拒绝、逐条跳读、跨身份隔离、历史过期撤回、并发 CAS、幂等及审计回滚、主业务成功但 attention 失败/超时和敏感通道保护。
