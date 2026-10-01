# Web Session 活动续期

- 状态：Frozen
- 日期：2026-10-01
- 任务：[CFK-529](https://cfkanban.dev/app/issues/CFK-529)
- 授权依据：用户授权完成 CFK-529，并于 2026-10-01 确认下述活动、期限、节流及草稿恢复政策，以及审核后的 Cookie 竞态修正；本合同不授予线上 migration、部署、发行或推送权限。
- 本增量仅覆盖 Foundation §5.6、API / Schema §3 及 §5.5、Web UI §4.4 及 Q-WEB-01、Agent Skills & Bootstrap 的固定 Session 期限，以及参与者项目切换增量的固定 8 小时且不可续期条款；Browser Launch 的 5 分钟、单次兑换及其余身份、权限和敏感能力交付合同继续有效。

## 活动与期限

Agent Browser Launch 与 Passkey 创建的 Session 使用相同规则。有效 Session 在前台网页发生真实鼠标、键盘或触屏操作时可自动续期，每个 Session 最多每 30 分钟实际延长一次；续期后再有效 8 小时，从首次创建起的绝对上限为 7 天。后台轮询、隐藏页签、单纯刷新或焦点/可见性校验不产生续期。过期、退出或来源撤销后不能恢复原 Session，须按既有入口重新登录。

最长有效时间为 `min(续期时服务端时间 + 8 小时, Session.created_at + 7 天)`。已有 Session 在升级时不批量延长，仅在仍有效且满足已确认续期规则时续期；绝对上限从原创建时间计算。

## 安全与一致性边界

续期只改变当前 Session 的期限，不创建 Principal、Credential、Grant 或新的 scope，不旋转或向脚本暴露 Session token。Principal、source_kind/source_id、target_kind/target_json 保持原值。每次读取、续期及业务操作仍核对实时认证、来源撤销、容器状态和有效授权；窄 Owner、旧固定项目及工作区管理 Session 均不能借续期扩大范围。

续期入口使用同源 Cookie 认证、Origin 与 double-submit CSRF；不接受 Bearer 代为续期。GET/HEAD、普通业务请求和自动数据轮询不延长期限。绝对或当前截止已到达、来源已撤销、退出已提交时，后续续期不能复活 Session。

写入遵循 CAS、幂等和原子安全审计，频率限制由服务端事实决定。并发页签不得让期限倒退或重复延长；响应不确定时保留原请求与幂等键核实，不自动重放业务写入。新登录的 Session 与 CSRF Cookie 固定保留至 Session 原创建起 7 天，服务端仍独立严格执行当前 8 小时滑动期限、绝对截止及来源/撤销校验。续期入口的成功、重放与错误响应均不设置或清除 Cookie，防止迟到响应覆盖其他页签的新登录。升级前 Cookie 保留原 8 小时截止，到期后重新登录才能使用完整的新 Cookie 保留规则；不尝试原地延长旧 Cookie。

## API 与 schema 17

`GET /api/v1/web-session` 增加当前 Session 的 `version` 与 `renewal: {renew_after, absolute_expires_at}`，时间为 ISO 8601。`renew_after` 为最近一次实际续期（没有则原创建时间）加 30 分钟；该只读端点不更新活动或期限。旧客户端忽略新增字段；新版 Web 在旧服务缺少续期 metadata 时继续使用原到期与重新登录路径，不猜测服务能力。

`POST /api/v1/web-session/renew` 只接受当前 Cookie Session、同源与 CSRF，并要求 `Idempotency-Key` 和 `{expected_version}`。标准写入 envelope 的 `resource` 为 `{session_id, version, expires_at, renew_after, absolute_expires_at, renewed}`。只有允许的延长才更新 Session version、`last_seen_at`、`expires_at` 并原子记录安全审计；节流窗口内或已达到绝对截止且无需增加期限时返回当前事实，`renewed=false`。旧版本冲突通过现有 `VERSION_CONFLICT` 返回当前 version；客户端重新读取 Session 事实，不能覆盖并发续期。

幂等重放保持原操作结果，续期响应不携带 `Set-Cookie`。Web 在续期结果后重新 GET 验证当前 Session，更新计时及授权投影；旧响应不得把本地已知截止倒退。续期的待核实客户端意图按 Session ID 隔离，同一 Session 的不确定请求保留原幂等键，新 Session 不复用旧会话的意图。续期读取与原子提交都保持原 scope 与 source 的实时核验。

新增 `0017_web_session_renewal.sql` 为既有 Session 添加默认 1 的版本及当前 expiry 清理索引；`last_seen_at` 只记录低频实际续期，不在普通 GET/HEAD 写入。不改已发行 migration，manifest/schema 目标推进至 17，部署新 Worker 前先迁移。恢复与 schema 兼容上限同步推进；Worker 回滚不回退 D1，旧 Worker 的固定期限/清理行为不能作为新版长时 Session 的保证。

Session 清理必须依据当前有效期或撤销状态，不按原创建超过 24 小时删除仍有效的会话。创建、来源绑定、退出、授权及恢复的数据保留约束继续有效。

## Web 与恢复

前端维护仅内存的真实活动与续期状态，按当前身份代际丢弃旧异步结果；续期成功更新公共 Session 事实及截止计时。多页签共享 Cookie，使用有界重校验与服务端并发规则收敛，不把 token、CSRF、业务草稿或长期凭据写入 Web Storage。

网络失败或离线不改变已成功业务操作结论，不清除未提交草稿。到期或撤销清理远端投影，但显式注册的未提交业务文本保留在当前页面内存并提供复制降级；不捕获任意 DOM 表单、凭据、CSRF、Launch/Invite 能力或附件 bytes。重新建立同一 Principal 的 Session 后由用户明确选择恢复与重新判断提交；跨 Principal 不自动恢复，显式退出清除保留草稿。草稿不写浏览器持久存储、不复用旧响应、不自动重放。页脚不持续显示会话期限或续期说明；需要重新登录时提供中英文提示，公开手册及 Agent Browser Launch 指引说明活动续期和期限，无统一后台唤醒或 refresh token。

## 验收边界

覆盖两种来源、仍有效的旧 Session、节流、空闲与绝对截止、撤销/退出及提交竞态、多页签并发、幂等与响应丢失、来源/范围不扩大、Cookie/CSRF、清理不删有效续期 Session、离线/失败、旧异步结果隔离及草稿恢复不重放。所有自动化验证使用隔离本地 D1 与合成身份；不将线上实例作为测试环境，不隐含线上 migration、部署或发行。
