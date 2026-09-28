# Owner 设备网页管理与本地身份切换

- 状态：Frozen
- 日期：2026-09-28
- 执行任务：[CFK-447](https://cfkanban.dev/app/issues/CFK-447)
- 授权：用户要求 Owner 设备能力尽可能在 Web 与 Skill 对齐，并明确选择“切换为 Owner，保留旧身份的安全恢复入口”和“Owner 登录后明确确认即可”。本轮实现和隔离验证，不隐含新发行、线上凭据操作或部署。

## 覆盖范围

本增量在以下范围替代 2026-09-27 多设备合同及 Foundation、Bootstrap、Web、API 中的旧限制：Owner `admin` Web Session 可以批准新设备及撤销指定另一设备；明确授权的 Owner 设备接入可以替换同一实例的另一 current Principal，并保留一个私有恢复槽。Owner 普通轮换、preferred origin 修改、全失恢复、唯一 Owner、普通成员邀请和分级管理员权限保持原合同。

Agent-first 表示优先服务 Agent，同时尽可能使 Web 与 Skill 提供一致的业务能力。界面差异应来自实际运行环境或凭据存储约束，不能仅因入口不同而永久排除一侧。浏览器不能读取或保存 Agent 的长期 secret；网页批准与 Agent 本地落盘是同一接入流程的不同步骤。

## 网页批准与撤销

1. 新设备继续由 Skill 生成私有 pending secret 和非秘密 pairing request。网页只接受该请求，不生成、导出、上传或保存长期 API secret。
2. Owner 管理页提供设备列表、检查配对请求、明确确认批准及明确确认撤销。列表复用现有 Owner Credential 分页，不只处理首屏。
3. 批准前展示实例、Owner、设备名、fingerprint 和有效期，准确匹配当前可信 origin/instance/Owner；拒绝未知字段、秘密 token、畸形或过期请求。配对数据只保留于页面内存，不写浏览器持久存储。
4. 用户明确选择普通 Owner 登录后确认，不要求额外 Passkey、近期认证或操作再验证。服务端只允许有效 Owner Bearer，或 Owner 且 `target_kind=admin` 的 Cookie Session；Cookie 写入使用现有同源与 CSRF 校验。局部管理员、普通参与者和 Owner 窄范围 Session 无此能力。
5. 沿用现有 add-device/revoke 路径、请求字段、Principal CAS、幂等及原子审计，必须在 D1 提交边界重查认证来源、当前权限和资源。审计保存非秘密 actor Session 与 authentication source IDs，绝不保存请求 digest/token。
6. 添加设备要求至少一份 active Owner API Credential，且继续遵守 100 份上限。active 仅表示服务端未撤销，不证明本地 secret 仍可用。只要持有有效 Owner admin Session 且仍有 active 记录，即使本地 secret 文件已经丢失，也可以按用户选择的网页确认方式批准新设备；这不执行专用全失恢复的全部旧凭据撤销。零 active 时禁止网页新增；无法通过有效 Owner 会话接入时，仍走部署外全失恢复。
7. 撤销拒绝当前 Bearer Credential、当前 Agent Launch Session 的来源 Credential；所有入口原子禁止撤销最后一份 active Owner API Credential。独立 Passkey Session 不假定存在来源 API Credential。撤销只影响目标及其派生 Launch/Session，保留其他凭据与独立 Passkeys。
8. Owner Credential 摘要仅对可操作目标提供 `revoke_owner_device`，普通 `revoke` 和通用 DELETE 仍不允许撤销 Owner Credential。已有 Owner rotation 仍为 Bearer-only。
9. 网页批准成功只表示服务端批准；显示“回到新设备完成验证”。新设备仍需核验 discovery、`/meta`、`/me` 的准确 Principal/Credential/fingerprint 后才能切换。
10. 写响应不确定时页面保留冻结 body 与幂等键，锁定目标并允许原请求重试；不能重建 key 或误报成功。明确 CAS 拒绝后重读并重新确认才发起新尝试。离开未确认操作页面须提示，禁止把旧确认用于已变化请求。

schema 保持 12、API 保持 0.1.0，无新增数据库 migration；OpenAPI 与错误/权限描述同步实现。

## 已有本地身份接入 Owner

“已有凭据”限定为同一执行环境、同一实例的 current 槽位；其他实例或独立浏览器 Session 不占用此槽位。

默认 `owner-device prepare` 仍拒绝已有 current。用户明确要替换时，专用命令使用 `replaceCurrent:true` 及经本地核验的 `expectedCurrentPrincipalId` / `expectedCurrentCredentialId` 固定被替换身份；不把原 Principal 升级或合并为 Owner。

- 准备与等待批准期间旧 current 保持有效。新的 Owner secret 独立生成到 pending，不复制旧 secret，不提前撤销或删除旧身份。
- 在 trusted origin 核验新 Owner、准确 Credential ID/fingerprint 与实例后，先完整保留旧身份到私有 previous 槽，再将新的 Owner 提升为 current。既有 previous 与本操作不符时拒绝覆盖。
- 每实例始终只有一个 current 和最多一个供显式恢复使用的 previous。previous 不参与 API 请求自动选取、权限并集或身份猜测；不新增通用多 profile 选择器。
- 新增 `owner-device restore-previous`，输入准确实例和期望 current 的两项 ID。先验证 previous 的远端实例、Principal、精确 Credential/fingerprint 和有效性，再交换 current 与 previous，使接入的 Owner 凭据也得到保留。重复操作按同一元数据事务续做，不能再次交换或生成 secret。
- previous 已撤销、origin/身份冲突、权限不安全或 current 漂移时停止，保留现状。恢复只改变本地当前身份，不撤销远端 Credential，不修改旧 Principal 的 Grants、assignment、历史或浏览器 Session。
- current、pending、previous 的 secret 都只放在用户 home 私有 `.cfkanban/` 内，校验 ownership/ACL/symlink；恢复记录和输出只含非秘密标识与状态，secret 不进 journal、日志、临时目录或 Agent 上下文。
- 多文件切换使用有界可恢复状态机及共享凭据写锁；事务准确绑定操作和两侧身份，只允许预期旧/新文件状态。每次恢复先验证目标身份，覆盖双文件写入中断、pending 清理中断及响应丢失。常规 prepare/promote/clear 不得绕过未完成切换，错误不能清空 current 或覆盖其他 pending。

旧版 Skill 不能执行新切换/恢复入口。若发现未完成切换，须使用支持本合同的 Skill 恢复；更新后的双语指南说明已有身份冲突、明确替换、恢复与旧版限制。

## 验证

- Web/API：Owner admin 的两种 Session 来源、CSRF、非 Owner/局部管理员/窄 Session 拒绝、来源撤销与过期、请求校验、CAS/幂等、并发撤销最后一份、零 active 时拒绝新增、审计与事务回滚。
- Web 交互：非秘密配对预览、确认绑定准确输入、成功后的新设备验证提示、未知响应同请求重试、分页、撤销保护、英文/简中与无障碍。
- 本地：管理员转 Owner、缺少明确替换的拒绝、旧凭据保留及恢复、远端验证失败、previous/pending 冲突、ACL/symlink、防泄露、写入中断及幂等恢复、并发常规凭据命令阻止。
- 运行 typecheck、相关单测/集成、contracts:check、d1:check 和构建；线上真实身份与凭据不用于自动化写入测试。代码验证不等于发行或真实跨设备验收。
