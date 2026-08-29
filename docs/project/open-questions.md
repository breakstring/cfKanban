# cfKanban 待讨论问题

- 文档状态：Draft
- 目的：只记录会实质改变产品或公共合同的选择
- 最近更新：2026-08-29

## 已确认并移出 P0

- Q-001 已于 2026-08-27 确认：一个部署者控制的部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project。
- Q-007 已于 2026-08-27 确认：Credential 只认证一个部署级 Principal；同一 Principal 可以通过授权访问多个 Workspace 和多个 Project。Workspace 是资源命名空间，不是身份边界。
- Q-008 已于 2026-08-27 确认：v0 业务权限按 Project 显式授予，不设置向下继承的 Workspace grant；同一 Principal 可以拥有分布在多个 Workspace 的多个 Project Grants。
- Q-009 已于 2026-08-27 确认：每个部署实例只有一个 Deployment Owner；只有 Owner 能创建 Workspace 与 Project、邀请参与者和管理 Project Grants。非 Owner 只有 `reader | writer`，Project 内容的删除属于 `writer` 并采用软删除。
- Q-011 已于 2026-08-27 确认：`writer` 只能软删除 Project 内容，不能删除 Workspace/Project 容器；只有 Owner 能软删除和恢复 Workspace/Project 容器。Project 内容的恢复权限与具体失效语义转入 Q-013。
- Q-013 已于 2026-08-27 确认：`writer` 可以恢复其有权软删除的 Issue、Comment、Label、Relation 等 Project 内容。容器软删除的具体失效语义转入 Q-014。
- Q-014 已于 2026-08-27 确认：软删除 Workspace/Project 采用暂停语义；只标记容器，保留子资源与 Grants 但暂停访问；恢复后未撤销的 Grants 自动恢复。原 lease 处理条款已由 Q-002 取消。
- Q-012 已于 2026-08-27 确认：Owner 无需 Project Grant，隐式拥有全部 Project 的数据面读写能力；Owner 仍是部署级身份而不是第三种 Project role，操作单独审计。
- Q-010 已于 2026-08-27 确认：实例不设置第二管理员、不支持 Owner transfer；首次部署使用一次性 bootstrap Credential，Owner 可安全轮换 Credential；全部丢失时，仅允许掌握 Cloudflare deployment 的操作者通过部署外受控 Skill 脚本为同一 Owner Principal 重新签发。
- Q-002 已于 2026-08-27 确认：v0 不采用 lease、续租、fencing 或独占执行权。Issue 使用单一可空 assignee 表示当前负责人；assignment 不改变授权，任何 Project `writer` 仍可修改、评论、完成或报告阻塞，并用 version/CAS 防止静默覆盖。
- Q-006 随 Q-002 关闭：v0 没有 Lease 实体，因此无需决定 lease 的持久化形态；若未来出现必须排他的外部执行场景，应作为独立增强重新立项。
- Q-003 已于 2026-08-27 确认：blocked 不作为 workflow status，而是与 status 正交的条件，并通过统一 `is_blocked` 投影呈现。未完成 `blocked_by` 关系自动贡献阻塞；人工 `blocked_reason` 通过 `report-blocked` 设置、通过 `clear-blocked` 显式清除；这些变化都不自动修改 status。
- Q-004 已于 2026-08-27 确认：Owner 创建短期、一次性的 Bearer Invite URL，并复制简短话术通过线下渠道发送。接收方 Agent 读取邀请页面并使用可信 Skill：本地已有该部署实例的有效 Credential 时复用其 Principal，否则通过内置 Node 脚本创建 Principal/Credential 并安全保存在本地；随后原子兑换邀请所绑定的一个或多个 `reader | writer` Project Grants。邀请页面可以提供 Skill 安装/更新和操作说明，但 GET 不得消费邀请。
- Q-005 已于 2026-08-27 确认：v0 固定 `backlog / todo / in_progress / done / canceled` 五个 status key，以及对应 category、顺序和 terminal 语义。Project 只能覆盖显示名称；不能增加、删除或重排状态，也不能自定义 transition graph。Agent 必须依据稳定 key/category，而不是显示名称推理。
- Q-107 已于 2026-08-27 确认并由 Q-225 修订：只有唯一 Owner，或当前对目标 Project 具有有效 `writer` Grant 的 Principal 可以成为 assignee；`reader` 和无权 Principal 不可分配，assignment 不创建或扩大 Grant。Grant 撤销或角色降为 reader 后，保留原 assignee 引用和 Issue status，读取投影返回 `assignee_available=false`、`needs_reassignment=true`，由 Owner 或 `writer` 显式重新分配或取消分配。
- Q-108 已于 2026-08-27 确认并由 D-205 补充：Invitation 分为普通 Project Invite 与 Principal Recovery Invite。普通邀请只授予指定 Project Grants；本地没有对应有效 Credential 时只能创建新 Principal，不能凭名称恢复既有身份。Recovery Invite 仅由 Owner 按稳定 principal ID 创建，并在创建时固定不可互换的 `rotation | full_recovery` mode。前者要求旧 Credential 证明且只撤销该凭据，后者以一小时 Bearer Invite 授权并撤销全部先前 Credential；页面必须警告身份连续性、全部现有 Grants/assignee/历史和确切撤销范围。Owner 无法确认身份映射时必须创建新 Principal 并重新授权；参与者不能自行签发额外 Credential。
- Q-109 已于 2026-08-28 确认：status 显示名称属于 Project 设置，只有 Owner 能修改；Owner 或目标 Project 的任意 `writer` 可带 expected version 在五个固定状态间任意显式转换，包括从 terminal 状态 reopen。每次转换记录旧状态、新状态和 actor；状态变化不自动改变 assignee 或 blocked 条件，转入 `done` 不能绕过 Q-101 最终确定的原子完成合同。
- Q-101 已于 2026-08-28 确认：完成结果保存为结构化、不可变且不可删除的 `kind=completion` Comment，不建立独立 Completion 实体。`summary` 必填，`verification`、`artifacts`、`follow_ups` 可为空；complete 在一个原子单元中校验 version、追加记录、转为 `done` 并写 Event。reopen 保留旧记录，再次完成追加新记录，普通状态更新不能绕过 complete 直接转入 `done`。
- Q-102 已于 2026-08-28 确认：v0 支持 `blocks / parent / related / duplicate`，并允许同一 Workspace 内跨 Project 建立全部四类关系，但禁止跨 Workspace。跨 Project 创建、软删除或恢复要求调用者同时对两端 Project 有 `writer`；读取只返回调用者同时可读两端的关系，不泄露无权 Project 或 Issue 的存在。
- Q-103 已依据 2026-08-28 的常规规则授权确认：v0 不首发原子 assign-next；候选列表、一般 assign 与 assign-to-me 是独立能力。上层调用方可以自行组合，cfKanban 不规定选择或重试策略。
- Q-104 的“v0 不要求部署端人类维护网页”已于 2026-08-29 被 D-215 替代：v0 必须提供同实例极简第一方 Web UI，服务 Owner 简单维护和参与者直接查看/轻量参与；本地只读查看器不再是首发要求。
- Q-105 的独立 CLI 方案已于 2026-08-28 被替代：v0 仍以 REST/OpenAPI 为权威合同，但不发布独立 cfKanban CLI；Agent Skills 直接调用 API，重复且需要确定性的逻辑进入 Skill 内置 Node.js/TypeScript scripts，远程 MCP 后置。
- Q-106 已于 2026-08-28 确认并按 D-190/D-195 修订：v0 提供部署级、按当前 Principal 授权过滤的跨 Workspace/Project Issue 聚合读取；只读聚合不提供跨范围批量写入或 assign-next。Project filter 在 API 上可省略；Skill 在已知工作上下文时强烈推荐一个或多个 `workspace + project` scope，并呈现 resolved scope 与范围警告，但不规定上层何时省略过滤。
- Project Grant expiry 的前一方案已于 2026-08-28 被替代：Project Grant 不设置失效日期；每个 `(principal_id, project_id)` 只有一条当前记录，通过 Owner 显式变更角色、撤销或重新授予。普通 Project Invite 不改写已有有效 Grant；已撤销 Grant 可按新邀请重新授予。Invitation 自身仍保持短期、一次性和可撤销。
- Event cursor 已依据 2026-08-28 的常规技术规则授权确认：内部使用部署级单调 sequence；公开 opaque cursor 绑定 Principal、过滤条件和实际可读 Project 集合。Credential 轮换不影响同 Principal cursor；scope 或授权集合变化返回 `CURSOR_SCOPE_MISMATCH` 和重新快照指引。是否持久化或执行恢复由上层调用方决定。
- Issue priority/rank 已依据 2026-08-28 的常规 Kanban 规则授权确认：priority 固定为 `none / low / medium / high / urgent` 且默认 `none`；v0 不保存手工 rank。候选按 priority、created_at 升序和 immutable ID 升序稳定排序，避免拖拽排序的写放大。
- Idempotency/error 已依据 2026-08-28 的常规技术规则授权确认：非天然幂等的创建和命令 POST 强制 `Idempotency-Key`，记录保留 24 小时，且鉴权先于响应重放。结构化错误提供稳定 `code`、`retryable` 和 `recovery`；无权发现的资源按 404 隐藏存在性，version/cursor 冲突要求刷新而非盲重试。
- 普通 Comment 已依据 2026-08-28 的常规 Kanban 规则授权确认：追加后不可原地编辑，可由 writer 软删除/恢复；纠错通过带 `reply_to_comment_id` 的新 Comment 表达。completion comment 不可编辑、软删除或恢复。
- assign-to-me 已依据 2026-08-28 的常规 Agent API 规则授权确认：v0 保留显式命令，由服务端从当前 Credential 推导 Principal，避免客户端复制自身 ID；它只设置 assignee，不产生 lease 或独占权。
- Credential expiry 已于 2026-08-28 确认并由 Q-225 修订：v0 Credential 不设置自动失效日期，只能显式撤销、轮换或 full recovery 中的撤销失效；Invitation 是唯一自动过期的 bootstrap 能力。`last_used_at` 可低频、滞后更新，仅供运维提示，不参与鉴权或自动撤销。
- Invitation 时效已于 2026-08-28 确认：普通 Project Invite 固定有效 7 天，Principal Recovery Invite 固定有效 1 小时；v0 不支持自定义或延长，过期后由 Owner 重新创建。
- 资源上限已依据 2026-08-28 的常规 API 规则授权确认：JSON 请求最大 128 KiB，Issue body 最大 64 KiB，普通 Comment 和 completion payload 最大 32 KiB；列表默认 20、最大 100，Agent context 最大 64 KiB 并通过 `truncated`/cursor 续读。大日志与附件使用外部 artifact 引用。
- Q-201 已于 2026-08-28 随 SB-01 确认并由 Q-221/D-209 完善：canonical 项目站点提供只读 bootstrap document，把 stable pointer 解析为 immutable release manifest；manifest 分别固定可校验的 Skill bundle 与 Service deployment bundle。marketplace/plugin 可以作为便捷入口但不是唯一真相源，不执行远程 pipe-to-shell。
- Q-221 已于 2026-08-28 确认：bootstrap 的 stable pointer 只用于发现；解析后的 immutable release manifest 是具体版本真相源，并分别固定 Skill bundle 与 Service deployment bundle 的 source/version/digest 和兼容关系。已安装 Skill 与用户级缓存只是可验证副本，repo clone 只用于明确的非 canonical 源码试验；普通 stable 部署不从当前工作树或业务 Repo 隐式取材。
- Q-222 已于 2026-08-28 确认并由 D-236 补充：首次部署默认零参数生成 strict-zero 计划。单一 Cloudflare account/profile 明确时，Agent 自动解析 stable bundle、提议无冲突资源名并生成非人类决策参数；缺少 Owner display name 时只询问这一项身份信息，用户只对完整 plan 做一次授权。只有 account 歧义，或 custom domain、付费能力、数据地域/合规、非 stable/源码试验等结果性偏差才再询问；未知资源不能接管，默认另提名称。
- Q-223 已于 2026-08-28 确认：v0 首次安装信任官方 canonical HTTPS；immutable manifest 逐工件限制允许来源并记录 SHA-256 文件指纹，本地 receipt 保存发布来源与摘要，更新或降级必须验证来源连续性。marketplace/plugin 不能覆盖 canonical 来源，安装、更新和降级均需展示精确目标并取得授权。该机制不防官方发布系统整体失陷；独立数字签名、密钥轮换和撤销等到公共分发、自动更新或托管分离出现时再评估。
- Q-224 已于 2026-08-29 确认并由 Q-225/Q-227 修订：Browser Launch 固定 5 分钟、一次性；Web Session 固定 8 小时、不滑动续期且无 refresh，绑定 Principal、源 Credential 与 target scope。源 Credential revoke、Session revoke 或 expiry 立即失效，Grant/容器逐请求校验；Project/Issue launch 只访问对应 Project，Owner admin launch 进入实例级管理与数据面，但默认不自动查询全部 Issue。过期后由 Agent 重新创建 launch，不接受网页 Credential。
- Q-225 已于 2026-08-29 确认：v0 移除 Principal disable/enable/delete。Credential revoke 停止认证，Project Grant revoke 停止具体 Project 权限，Principal Recovery Invite 恢复同一身份；Principal、assignment 与历史稳定保留，不引入重新启用旧 Credential 的安全歧义。
- Q-226 已于 2026-08-29 确认：Web 只撤销参与者 Credential，不提供 Owner Credential revoke/rotation。Owner 正常轮换由 `cfkanban-admin` 先把替代 secret 安全写入本地，再执行 Bearer-only 原子 rotation；全部 Owner Credential 丢失仍只走 `cfkanban-deploy` 的部署外恢复，避免 Web 撤销当前或最后一个 Owner Credential。
- Q-227 已于 2026-08-29 确认：Owner `admin` Session 默认进入 Overview 且不自动查询全部 Issue，但可在显式选择后进入实例内任意 Workspace/Project 数据面；普通 Project/Issue Session 继续限制单 Project。未认证实例首页提供产品介绍与指向 canonical bootstrap document 的可复制 Agent 部署话术，不接受长期 Credential。
- Agent 主体与执行载体已于 2026-08-28 确认：只建模“林的 Agent”“陈的 Agent”这类用户直接使用的 Agent；部署、Owner 管理、Coding 和协调只是任务模式。v0 不发布独立 cfKanban CLI，确定性逻辑使用 Skill bundle 内少量 Node.js/TypeScript scripts；Host Adapter 不作为独立角色。
- SB-02 的 Node 环境所有权已于 2026-08-28 确认：Skill 可以探测和引导，但 Node 的 version manager、安装方法、路径和全局默认版本由用户决定；已有兼容版本优先复用，stable Skill release 只声明经验证的 semver range。
- Q-206 已于 2026-08-28 确认：用户选定 Node 安装方式后，Agent 先展示精确计划；获得授权后可以执行并在新 shell/session 中读回验证。授权不隐含新增 package source/version manager、提权、修改 PATH/shell profile、改变全局默认 Node 或卸载旧版本；这些变化必须另行确认。
- Q-203 已于 2026-08-28 确认并由 D-234 校正：v0 同时支持 Windows 原生和 WSL2，但将其视为互不混用的独立执行环境。Agent 只解析当前环境内的工具与本地状态，不跨边界自动发现、调用或搬运；这不禁止用户手工复制同一 Credential。
- Q-204 已于 2026-08-28 确认并由 D-234 补充：v0 不依赖 OS secure store；cfKanban Credential 默认保存到当前执行环境用户主目录下的 `.cfkanban/` 私有目录，依赖 ownership/ACL 与最小权限保护。它是权限受限的明文 secret，用户可在自行承担安全性的前提下复制到其他受信环境；但不能进入 Repo、同步/临时目录、日志、环境配置或 Agent 正常上下文。
- Q-205 已于 2026-08-28 确认：一次部署授权绑定当前 Agent 任务、规范化 plan digest 与 operation ID，覆盖计划内 Worker/D1、bindings、非破坏性 migration、服务部署、Owner bootstrap、验证和无漂移恢复，不逐步重复确认；新任务/会话或计划外付费、DNS/domain、删除/覆盖、破坏性 migration、未知资源接管、账户/权限变化和其他 plan delta 必须重新确认。
- Q-207 已于 2026-08-28 确认：strict-zero 默认每实例一个 Worker + 一个 D1，先使用 `workers.dev`；custom domain 和其他 Cloudflare 服务显式启用。同名资源只有本地 receipt/journal、Cloudflare account、资源类型与远端 `instance_id` marker 全部匹配才恢复，否则停止并建议新名称。
- 更新平面已于 2026-08-28 确认：本地 Skill update 与云端 Instance upgrade 是互不隐含的独立动作；只读检查可同时报告两边版本，执行一边不能静默触发另一边。Skill update 使用 canonical immutable bundle、原子切换和上一已知良好版本回退。
- Q-208 已于 2026-08-28 确认：云端 Instance upgrade 固定目标版本、兼容矩阵、逐条 migration journal 和可验证 D1 restore point。失败的单个 migration 回滚，但此前成功项保持已应用；Worker rollback 不回退 D1。D1 Time Travel restore 会覆盖数据库，必须重新取得破坏性授权且永不自动执行。
- Q-209 的 action preview、二次确认和自然语言消歧规则已被 D-198 修订：Workspace 创建仍是 Owner-only 原子能力，key 创建后不可变、display name 可修改，且不隐含 Project、Grant 或默认成员；上层 Agent 自行决定何时调用和怎样确认。
- Q-210 的 action preview 规则已被 D-198 修订：Project 创建仍是 Owner-only 原子能力，key 创建后不可变、display name 可改。Repo/Project 关联可以使用非秘密、多 Project 的本地 scope；服务不自动上传路径或 Git remote，canonical Repo URL 只是独立的非授权 external reference，v0 不建立 Repository 实体。
- Q-211 已于 2026-08-28 确认：Project 创建后凭默认五状态立即可用，不设初始化门槛且不默认创建 Labels。v0 只提供一个可选有界 context，由 Owner 修改、Project reader/writer 读取；它是与稳定合同、本地 Repo 规则和当前授权分层呈现的非可信背景，不提供 instruction/prompt 字段，也不能授权任何外部动作。
- Q-212 已于 2026-08-28 确认并按 D-195 修订：v0 不提供公开 batch/bulk 写入，每次 API 调用只表达一个原子领域操作，并有独立幂等、readback 与结构化恢复合同。复合目标的拆分、顺序、停止、续做和汇报属于上层编排；服务不自动回滚或删除其他已成功操作。
- Q-213 已由 D-198/D-203/D-204 分层修订：Project Invite 是 Owner-only 原子能力，API 必须逐项显式携带 `reader | writer`；`cfkanban-admin` 在上层未指定 role 时推荐 `writer`，明确只读时使用 `reader`，更具体规则可覆盖。preview/确认属于上层策略；完整 Bearer URL 只进入必要的可复制话术，不写日志/receipt，cfKanban 不负责外部发送。
- Q-214 已于 2026-08-28 确认并由 Q-225 修订：v0 Principal 不区分 human/agent kind；服务端保存 immutable principal ID、非唯一 display name 和 version，不设置 disabled 状态轴。ID 用于授权、assignee、审计和引用，名称仅展示且不能用于恢复。首次创建缺少名称时 Agent 只询问这一项，不静默读取 OS/Git/hostname/Agent account，也不按 Agent 宿主重复创建身份。
- Q-215 已于 2026-08-28 确认并由 D-208 更新命名：不新增 profile Skill；默认日常 Skill `cfkanban` 通过 `GET /api/v1/me` 查看身份，通过带 expected version 的 `PATCH /api/v1/me` 只修改自己的非空 display name。改名写 Audit/Event，不改变 ID、Credential、Grants、assignment 或历史；Owner 不能代改，本地非秘密 metadata 以服务端为准。
- Q-216 已于 2026-08-28 确认并由 D-234 补充：`.cfkanban/` 可以保存多个上游实例，但每个执行环境对每个 `instance_id` 只维护一个当前本地 Principal/Credential 槽位。同一实例出现多个不同 Principal 是冲突；同一 Credential 在多个环境的副本不是多个身份，并共享撤销/轮换后果。
- Q-217 已于 2026-08-28 确认：本地实例记录以 immutable `instance_id` 为稳定主键，trusted API origin 是可变安全 metadata。Credential 只发送给当前已信任 origin；陌生新 origin 只声称同一 ID 时，必须在认证前展示旧/新地址与影响并取得显式 rebind 授权。D-243 后续增加了可信旧 origin 发布更高版本指示、再经无 Credential 目标探测验证后的自动 rebind 例外。仅 Invite/展示域名变化而 API origin 未变时无需 rebind。
- Q-218 已于 2026-08-28 确认并按 D-195 修订：Invite/discover 不自动修改 Repo；Skill 另行提供显式创建/合并 `.cfkanban-scope.json` 的本地能力。它只保存 schema version 与 `instance_id + workspace_key + project_key` targets，不保存 Credential、API origin、路径、Git metadata、role 或权限快照；何时调用和是否提交 Git 由上层决定。
- SB-12 已依据用户此前对 Project filter 的强烈推荐并按 D-195 修订：API 允许一个、多个或省略 Project filters，并返回 resolved scope；Skill 在已知工作上下文中强烈推荐 filters，暴露失效 target 与范围扩大警告，但不替上层选择 Project 或规定何时查询全部授权范围。多个 Repo target 平级，不保存优先级/last-used。
- Q-219 的自然语言意图映射已被后续边界修订：候选读取、assign-to-me 与状态转换仍是独立能力，但 cfKanban 不规定“找工作”“开始”“接手”等话术应触发哪些调用；由上层 Agent 按用户意图、宿主审批和 Repo 规则协调。
- Issue 引用格式已于 2026-08-28 确认：每个部署实例共享一条永不复用的全局 Issue number 序列，统一生成 `CFK-<正整数>`；Project key 不再作为前缀。不同实例的相同编号由 `instance_id` 消歧。
- SB-14 已依据常规规则授权确认：64 KiB context pack 永远保留核心身份、scope、version、状态、负责人、阻塞和 allowed actions；正文、Project context、关系与评论有界返回，默认最近 10 条评论。所有裁剪都返回 section、遗漏计数和 continuation，不自动读取外部 artifact。
- Q-220/D-194 已于 2026-08-28 否决：cfKanban 不规定执行 Agent 可以自主写哪些协作事实。服务提供并强制 Comment、Relation、blocked、assignment、status、complete 等原子动作的权限与数据合同；调用时机、组合和内容判断属于上层 Agent。
- SB-16/SB-17 已依据该边界收敛：assignment 不捆绑 handoff Comment；complete/reopen 不以 assignee 为权限门槛，也不规定 Agent 何时调用。评论、assignment、complete 和 reopen 各自按独立服务合同执行和恢复。
- SB-04/SB-05/SB-07/SB-08 也已按同一边界回查：Workspace、Project、单项 Issue/Relation 与 Invite 的服务端只定义原子能力；Skill 仍应提供 key/role 推荐、原子组合和恢复范式。action preview、二次确认与最终复合目标拆分属于上层决策。
- SB-18～SB-21 已收敛：`updated_before` 是普通查询过滤；单项写入 wire request 携带一个明确 Project；cursor 是否持久化属于上层；撤权影响可由现有读取能力按需查询，不增加确认界面协议。

Foundation 领域合同的原 P0 问题已经确认。Project Grant、Invitation、Event cursor、查询排序、资源上限、错误与幂等合同也已收敛；完整 OpenAPI/DDL、Web UI 与视觉合同已经于 2026-08-29 冻结。

用户在 SB-01 复核中指出：原 Storyboard 虽然面向 Agent，操作主体仍然是人；随后进一步明确 cfKanban 不应成为上层 Agent 的最终工作流协调器，但必须为上层提供足够的默认建议和全局约定。Storyboard 因此用人/Agent 场景同时验收原子能力、Agent Guidance 和安全协议。独立的 [Agent Skills & Bootstrap SPEC](../specs/2026-08-28-agent-skills-bootstrap-spec.md) 负责能力暴露、可覆盖建议以及部署/凭据安全协议，不替上层决定日常 Issue 自主策略。

## P0：当前关键产品合同

### Q-202：Skill 套件边界

- **已确认**：首发固定 `cfkanban / cfkanban-admin / cfkanban-deploy` 三个按工作场景发现的 Skill。`cfkanban` 是默认日常 Issue/身份/scope 入口；`-admin` 是 Owner 应用管理入口；`-deploy` 是 Cloudflare 部署、升级、检查和 migration 安全入口。
- **命名边界**：三者不是 Agent 类型、Principal kind 或服务端 role。同一个用户的 Agent 可以按任务调用不同 Skill，真实权限始终由 Credential、Owner 身份和 Project Grants 决定。
- **实现约束**：共享合同和确定性逻辑进入 bundle references/modules/scripts，不因拆成三个入口而复制；后续如需合并或重命名属于公共 Agent 体验变更，必须重新决策。

### Q-228：人类后续直接登录方式

- **用户问题**：固定 8 小时 Session 到期后，每次都让 Agent 重新创建 Browser Launch 有摩擦；但把 `.cfkanban/` 的长期 Bearer Credential 粘贴进网页会扩大剪贴板、页面脚本、扩展和误填风险。
- **已确认**：用户于 2026-08-29 同意 SB-30。首次通过 Agent Launch 建立 Session 后，用户显式注册仅用于 Web 的 Passkey；以后 Passkey 认证只签发新的固定 8 小时 Session，不创建 API Credential、Grant 或 refresh token。网页始终不接受长期 Credential。
- **生命周期**：首次和补充登记都要求 Agent-launch Session；同一 Principal 可以有多个 Passkey，本人可以列举/撤销，Owner 可以撤销参与者 Passkey，全部写安全 Audit。撤销 Passkey 只使其来源 Sessions 失效，不撤销 API Credential 或 Grants。
- **恢复边界**：D-244 后 v0 明确按当前 hostname 建立 RP ID，不启用跨 hostname credential 共享；丢失、不兼容或 hostname 变化时继续以 Agent Browser Launch 恢复。不能按 display name 绑定或恢复身份。

### Q-229：公开自助加入

- **已确认**：用户于 2026-08-29 否决 Team Join，只保留 Public Join。Owner 可以逐个 Project 公开并同时展示多个 Project；访客每次选择一个 Project 与 `reader|writer`，只执行一条 Project Grant 的原子 self-join。普通 7 天一次性 Invitation 继续用于定向邀请。
- **权限边界**：公开 `writer` 由访客主动选择；Owner 开启 Public Join 时必须明确接受未知互联网参与者的写入、软删除和 D1 成本风险。已有同等或更高 Grant 幂等返回，`reader` 可提升为 `writer`，`writer` 选择 `reader` 不自动降权。
- **公开边界**：首页只列 Owner 开启的 Project 显示名称、有界公开摘要与 role 选择，不暴露内部 context、Issue、成员或其他资源；Public Join 不携带长期 Credential，也不创建多 Project bundle。

### Q-230：Public Join 撤权后重入（已确认）

- **结论**：用户于 2026-08-29 否决逐 Principal 重入阻止，避免引入 blacklist/denylist。Project 仍公开时，被撤销 Grant 的 Principal 可以再次 self-join；同一身份复用唯一 Grant 行。
- **Owner 操作**：如果不希望任何人继续公开加入，Owner 关闭该 Project 的 Public Join。关闭入口不撤销既有 Grants；单独撤销 Grant 也不改变公开 Policy。

### Q-231：Public Project 成本上限

- **已确认**：开启 Public Join 前，Owner 必须显式设置该 Project 独立的 Issue、Comment、Principal 三项 active quota。Web 可以预填建议值，例如 50/500/50，但 API 没有静默默认。三项限制不形成实例共享池，任一 Project 的开关、usage 与 limits 都不影响其他 Project。
- **Issue/Comment 语义**：只计算当前 active 工作集。Issue soft delete 释放一个 Issue slot，并使其当前有效 Comments 不再占用 Comment quota；单独 soft delete Comment 释放一个 Comment slot。restore Issue 时需要同时容纳该 Issue 与随之重新有效的 Comments，任何一项不足都整体失败。completion comment 不可删除，所属 Issue active 时持续占用。
- **Principal 语义**：统计 Project 当前 active 非 Owner Grants，不区分定向 Invitation、Owner 手工授予或 Public Join 来源。Grant revoke 释放 slot；regrant/self-join 重新占用；reader/writer 变化不改变数量。新 Principal/Credential/Grant 必须与 quota 检查原子提交，满额不能遗留孤立身份。
- **生效周期**：三项限制只在该 Project 的 Public Join enabled 期间强制。关闭后不再约束本 Project 的普通协作，也不撤销既有 Grants；重新开启时必须由 Owner 显式提交三项限制，不能静默沿用旧值。
- **调低限制**：Owner 可以把限制保存为低于当前 active usage。服务端不自动删除数据或撤销 Grant，只把对应维度视为 over-limit；此时读取、编辑、软删除、撤权、role change 等不增加计数的动作仍允许，创建、恢复、regrant 等增加计数的动作被阻止，直到 usage 降低或 limit 调高。
- **边界**：active quota 限制公开期间的当前可用规模，但 soft-deleted rows 仍保留在 D1，不能宣称释放物理存储。反复创建/删除的长期增长由频率门控减缓；物理 retention/purge 仍是后置决策。

### Q-232：实例级请求频率门控如何配置（已确认）

- **已确认要求**：Owner 必须能查看当前生效的全局限流策略，并能通过一个明确入口修改。至少包含单 Principal、实例总请求和未认证/Public Join 路径三个门槛；触发时返回 429、Retry-After 与安全的策略摘要。
- **平台事实**：Workers Rate Limiting binding 的 limit/period 位于 Wrangler 部署配置，period 只支持 10 或 60 秒；运行时可以按 Principal、route 或实例 key 调用。它按 Cloudflare location 计数、宽松且最终一致，适合抵御突发而不适合精确配额。
- **已确认载体**：使用原生 Rate Limiting bindings；Owner 管理面只读展示生效值、配置来源与近期 429 摘要，修改由 `cfkanban-deploy` 生成并执行明确的 Worker 配置部署。它不修改 Project 三项 D1 quota，也不执行 D1 migration。
- **首次部署默认档位**：单 Principal 动态 API 为 120 次/60 秒；实例全部动态 API 为 300 次/60 秒；未认证敏感操作为 30 次/60 秒。静态资产绕过应用限流；普通公开读取只受实例门控，Public Join redeem、WebAuthn challenge/verify 等未认证敏感操作同时受第三道门控。每个请求叠加适用门控，任一失败即返回 429 与 Retry-After。
- **边界**：三个数字是可通过重新部署覆盖的产品初始值，不是 Cloudflare 平台上限。原生计数按 location 近似维护，不能防止分布式低速滥用，也不能替代 D1 active quota；若未来要求 Web 即时修改或严格全球计数，再以新版本评估 Durable Object。

### Q-233：Web UI 多语言边界（已确认）

- **已确认**：用户于 2026-08-29 要求 v0 第一方 Web UI 至少支持 English 与简体中文，并允许人类随时切换。首次按浏览器语言选择，无法匹配或缺失翻译时回退 English。
- **不翻译的内容**：稳定 API/workflow key、默认五状态显示名和 Workspace/Project/Issue/Comment/Label/context 等业务内容保持原文。API/OpenAPI 与 Skill 输出不随 Web locale 变化。

### Q-234：实例新域名如何被已有 Agent 感知（已确认）

- **Cloudflare 事实**：Owner 可以在首次 `workers.dev` 部署后，从 Dashboard、Wrangler 或 API 为同一 Worker 添加多个 Custom Domains。账户级 Workers Domains API 可以按 service 枚举这些 Cloudflare-native 域名，但需要 Cloudflare 控制面权限；Worker 运行时没有文档化的域名清单 binding，一次请求只能观察本次使用的 origin。详见 [域名与实例发现能力快照](../research/cloudflare-worker-domain-discovery-snapshot-2026-08-29.md)。
- **第三方边界**：第三方反向代理或 CDN 别名不会进入 Cloudflare Workers Domains 清单，Worker 也不能主动枚举。新地址只返回同一 `instance_id` 仍不足以自证可信；它必须由当前 trusted origin 的更高版本迁移指示交叉证明，或由用户显式 rebind。
- **已确认方案**：发行 manifest 继续只管不可变发布工件；部署实例另提供公开、非秘密、动态且 `no-store` 的 `/.well-known/cfkanban-instance.json`。每实例只保存一个 Owner 发布的 `preferred_api_origin` 和递增 `origin_version`，其他 Cloudflare/第三方域名只作为外部 aliases/candidates。Cloudflare-native candidate 由 `cfkanban-deploy` 在显式只读 reconcile 时发现，第三方 candidate 由 Owner 明确提供；应用内发布由 `cfkanban-admin` 使用 Owner Bearer Credential 完成，不要求重新部署。
- **自动迁移边界**：参与者 Agent 只从本地当前 trusted origin 接受更高 `origin_version` 的迁移指示，并在不发送 Credential、不跟随 redirect 的情况下验证目标 discovery 的 `instance_id`、observed/preferred origin 与 version。全部一致时可以原子修改 `.cfkanban/`，无需再次询问；任一不一致、版本未增加/回退、旧地址已失联或入口来自陌生地址时保持原记录并要求用户显式 rebind。
- **Web/控制面边界**：服务不在认证 API 上跨 origin redirect，也不把 Cloudflare 管理 Token 放入 Worker。迁移期间应保留旧 origin；若先关闭旧地址，只能通过 Invite/离线说明与显式 rebind 告知。Web Session cookie 按 origin 隔离；cfKanban v0 的 Passkey 按精确 hostname 隔离，需要在新 hostname 通过 Agent Browser Launch 重新建立和登记，不随本地 API origin 自动迁移。详见 D-243、D-244 与 SB-33。

### Q-235：页面能否判断当前设备已经存有本站 Passkey（已确认）

- **浏览器能力**：页面可以探测 WebAuthn API、可执行用户验证的平台认证器和 conditional mediation，但这些结果都不证明本站 credential 存在。平台认证器探测为否也不能排除安全密钥、手机或 credential manager。
- **隐私边界**：页面不能静默枚举 Passkeys；只有用户主动发起并成功完成认证才能证明本次可用。取消、超时、无匹配 credential、认证器不可用或策略拒绝不得显示为“没有 Passkey”。
- **服务端事实**：已认证后的 Passkey 列表只是当前 Principal 的服务端登记记录，不是当前设备 inventory，也不能证明私钥仍在设备或可用。
- **v0 选择**：未认证页在 WebAuthn 可用时显示显式登录按钮，不支持时突出 Agent Browser Launch。v0 以当前 hostname 作为 RP ID、当次完整 HTTPS origin 作为 expected origin，不配置跨 hostname 共享；换 hostname 后在新地址重新登记。详见 D-244 与 SB-30。

## P2：有真实用量后再讨论

- 软删除数据的长期物理保留和受控 purge 策略；v0 不提供公开 hard-delete API。
- SB-23 已依据 D-206 收敛：有恢复权限的调用者可用已知稳定标识直接读取 tombstone，或通过显式 `deleted=only` 视图分页定位；不提供隐藏时间窗的“最近删除”端点，也不提供批量恢复。
- SB-24 原导出/整库恢复场景已由 D-213 取消：v0 产品、API 与 Skills 不提供完整 D1 export/import/restore；Cloudflare 原生控制面能力不包装为 cfKanban capability。
- 独立发行签名、签名密钥轮换与撤销；只有出现公共分发、自动更新或 canonical 站点与工件托管分离需求时再评估。
- Vectorize 已由 D-214 确认为后期可选检索增强方向；具体 embedding、同步延迟、成本 profile、关键词/语义混合排序和降级合同在进入对应版本时再冻结。
- Workers AI 做摘要、去重、标签建议还是分派。
- 是否需要 Queues/webhook/通知。
- 是否需要 R2 附件和 Agent 产物。
- 是否需要 Durable Objects 实时广播。
- 是否走向面向互不信任组织的公共多租户托管服务。

## 推荐下一轮讨论

D-252 已完成最后一项 Passkey 安全/可用性确认，API/Schema、Web UI 与 `DESIGN.md` 已冻结；当前没有阻塞 v0 开始实施的产品问题。下一步只在用户明确开始实现后按 [v0 Implementation Plan](../plans/2026-08-29-v0-implementation-plan.md) 从 WP-01 推进。后续真实实现证据若触发停止条件，再回到合同层讨论；部署、远端 migration、提交和推送仍各自遵循授权边界。
