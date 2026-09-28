# 参与者邀请与本人 Passkey 双端能力

- 状态：Frozen
- 日期：2026-09-28
- 授权依据：用户确认 CFK-448 的已登录参与者普通邀请与 Bearer 本人 Passkey 管理范围，并要求实施。
- 本文是 Foundation、API / Schema、Web UI 与 Agent Skills / Bootstrap 的增量合同；只覆盖下述认证表面差异。不包含提交、发行或部署授权。

## 普通邀请与现有网页身份

`POST /api/v1/invitations/redeem` 的 `project_grant + current_principal` 模式新增有效 Cookie Session 认证；既有 Bearer 路径保持兼容。Cookie 只允许非 Owner 参与者，必须校验当前 Session、Principal、来源 Credential / Passkey、同源 Origin 与 CSRF，在幂等 claim 和任何业务写入前拒绝无效请求。携带无效 Session 的请求不得降为匿名兑换。

Cookie 不用于创建新 Principal / Credential、Principal Recovery、Owner device 或 Owner recovery。既有 Agent 的新身份与恢复安全脚本流程不变，不提供网页长期 Credential 输入、上传或复制入口。

`project_selection` Session 可以接受邀请所授予的新项目。固定 Project / Issue 或 Workspace Session 只能接受当前仍可见且在原范围内的目标；同一多项目邀请中任一目标越界，整单拒绝，不消费 Invitation、不部分授予项目。事务内复核实时认证及固定范围，避免鉴权后撤销来源或撤权产生部分授权。

成功沿用原有 Invitation 语义：活动 Grant 的角色不改写；已撤销 Grant 可以按邀请重新授予；多项目结果为 `created / regranted / already_has_access`。Invitation、Grants、用量、Event / Audit 与幂等快照在同一原子操作内提交。Cookie 兑换不生成新 Credential 或 Session，不改变当前 Session 的 target、scope、source、expires_at；后续读取仍受原 Session 范围与实时权限共同限制。

## 网页接受邀请

`GET /invite?code=…` 永远只读。页面保留准确项目、角色、到期与恢复提示；普通邀请在核对当前登录参与者后展示其名称和稳定 Principal ID，只有明确点击“以当前身份接受邀请”才提交。点击时重新核对 Session 与身份；已变更时停止并要求重新打开原链接核对。未登录、Owner 与 Recovery 显示可信 Agent 处理路径，不尝试身份替换。

code 从 URL 读入页面闭包后立即移除可见地址；仅在闭包保留原请求及 Idempotency-Key。不得把 code / 完整 URL / 请求体写入浏览器存储、日志或错误。页面与 API 使用 `no-store`，页面保留 `no-referrer` 与无第三方资源；CSP 仅开放同源连接用于 Session 读取和兑换。界面支持 English / 简体中文，后端机器字段不翻译。

请求结果不确定时保留页面并用原请求、原 key 重试；不重新生成 key 或猜测成功。刷新后丢失内存不能恢复 secret 或自动重放，用户需重新打开原链接。成功明确说明既有 Session 范围与有效期未改变，提供项目入口。

## Bearer 本人 Passkey 管理

`GET /api/v1/me/passkeys` 接受当前 Bearer Principal 或 Cookie Session。只返回本人服务端登记的非秘密摘要：`id / version / rp_id / algorithm / transports / backup_eligible / backup_state / created_at / last_used_at / revoked_at`；不返回 WebAuthn credential ID、公钥、user handle 或认证材料，不声称枚举设备私钥或证明当前设备可用性。查询后重新校验当前认证，避免认证与读取之间撤销来源而泄露清单。

`DELETE /api/v1/me/passkeys/{passkey_id}?expected_version=…` 接受当前 Bearer Principal，要求准确 UUID、当前版本及 `Idempotency-Key`。目标只能属于本人，包括 Owner 本人；其他 Principal 的目标按 404 隐藏。事务原子执行当前认证、本人归属、CAS、Passkey revoke、该 Passkey 的全部来源 Session revoke、security Event 与幂等快照。同 key / 同请求重放首次结果；同一目标的同 key / 不同版本请求拒绝，不重复写审计。

Cookie DELETE 继续要求同源与 CSRF；为兼容已发行 Web 客户端，未提供 key 时保留原 CAS 行为，提供 key 时使用同一幂等路径。撤销当前 Session 来源时，成功响应清除 Cookie；原 Session 此后无权重放，必要时由另一有效认证读取结果。Bearer 保持有效时可恢复已提交但响应丢失的操作。撤销不改变 API Credentials、Grants、其他 Passkey 或不相关 Sessions。

Passkey 登记 options / register 保持 Agent-launch Cookie Session + WebAuthn；Bearer 管理摘要与撤销不允许模拟登记或免用户验证。Owner 管理他人 Passkey 的既有独立路由与权限不变。

## 验证与兼容

不新增 schema、migration、角色、Secret 存储或通用批量 API。OpenAPI 同步两个本人 Passkey 操作与 Invitation redeem 的认证 / Header 合同，Skills 同步本人读取与精确撤销说明。

验证覆盖 Cookie 的未登录、Owner、Recovery、新身份、CSRF、跨源、过期、固定范围越界与来源撤销竞态；普通邀请的身份复用、整单原子性、原 key 重放与 Secret 不落持久状态。Passkey 覆盖本人清单、认证材料隐藏、他人 404、旧版本冲突、key 必填 / 冲突 / 重放、提交后读回失败恢复、单次审计、来源 Sessions 失效以及 Cookie 旧兼容。原有 Invitation 与 WebAuthn 集成验收继续通过。
