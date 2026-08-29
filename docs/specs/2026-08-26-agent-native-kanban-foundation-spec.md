# Agent-native Kanban Foundation SPEC

- 文档状态：Frozen
- 合同修订：19
- Roadmap：R0
- Linear：[cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f)
- 最近更新：2026-08-29
- 冻结日期：2026-08-28
- 最近修订：2026-08-29（D-250）
- 替代文档：无

## 1. 目的

本文定义 cfKanban v0 已冻结的基础产品与技术合同。它不是实施计划，也不授权编写业务代码。

目标是在保持极简的前提下，为多个 Coding Agents 提供可靠的工作协调语义。冻结范围内的公共语义如需变化，必须通过显式新决策和可追踪修订，不能静默改写。

## 2. 已确认的产品约束

- Agent 是主要使用者，但 Agent-first 不等于 Agent-only；v0 同时提供极简第一方 Web UI，作为人类直接查看、轻量参与和 Owner 简单维护的必要表面。
- 系统基于 Cloudflare，并优先在免费层内运行。
- canonical 源码采用 monorepo 组织；v0 的云端部署拓扑仍固定为一个 Worker 与一个 D1。预构建 Web assets 随同一 Service deployment bundle 通过该 Worker 的 Workers Static Assets 发布，不创建独立 Pages project 或 KV namespace。
- Project、Issue、Issue 状态、评论和标签属于核心能力。
- 应借鉴 Linear 的清晰领域语义，但不照搬其完整组织层级和人类 UI。
- 一个部署者控制的部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project。
- 每个部署实例只有一个 Deployment Owner；只有 Owner 能创建 Workspace/Project、邀请参与者和管理 Project Grants。
- 实例不设置第二管理员，也不支持 Owner transfer；Credential 轮换或恢复不能改变 Owner Principal。
- 首次部署为 Owner 签发只展示一次的 bootstrap Credential；全部 Owner Credential 丢失时，仅能由掌握 Cloudflare deployment 的操作者通过部署外受控 Skill 脚本为同一 Principal 重新签发。
- Credential 只认证一个 Principal；v0 业务权限按 Project 显式授予，同一 Principal 可以访问分布在多个 Workspace 的多个 Project。
- 非 Owner 参与者在每个 Project 上只有 `reader` 或 `writer` 两种 role；Project 内容的软删除与恢复都属于 `writer`。
- `writer` 不能删除或恢复 Workspace/Project 容器；只有 Owner 能软删除和恢复这些容器。
- Project 与代码仓库不强制一一对应。
- Issue 可以有一个可空 assignee，指向 Principal；它只表示负责人，不形成独占执行权或授权来源。
- v0 不采用 Lease、续租、fencing 或抢占机制；任何 Project `writer` 都可以协作写入，普通并发更新由 version/CAS 防止静默覆盖。
- blocked 与 status 正交，并通过统一 `is_blocked` 投影呈现；依赖或人工原因的变化都不自动改变 status。
- 参与者通过 Owner 创建的短期一次性 Bearer Invite URL bootstrap；普通 Project Invite 固定有效 7 天，Principal Recovery Invite 固定有效 1 小时。Agent 复用该实例的本地 Principal，或创建 Principal/Credential，再兑换邀请绑定的 Project Grants。
- 人类首次通过 Agent Browser Launch 进入后可以登记 Passkey；Passkey 是 v0 唯一免 Agent 的直接 Web 登录方式，不是 API Credential 或 Project Grant。网页永远不接受长期 Credential 粘贴或上传。
- Owner 可以逐个 Project 开启 Public Join 并同时公开多个 Project；访客每次选择一个 Project 与 `reader | writer`，只执行一条 Project Grant 的原子 self-join。v0 不提供 Team Join 或多 Project 公开授权。
- Public Join 不建立逐 Principal 重入阻止。Project 仍公开时，被撤销 Grant 的 Principal 可以再次加入；Owner 通过关闭 Project 的 Public Join 停止新的自助加入。
- 开启 Public Join 前，Owner 必须为该 Project 显式设置 Issue、Comment 与 Principal 三项 active quota。三者按 Project 隔离，只在该 Project 的 Public Join enabled 期间生效，不影响其他 Project；Owner 可以把限制调到低于当前 usage，既有数据保持不变，仅阻止继续增加相应计数。Issue/Comment 软删除与 Grant revoke 释放额度；restore/regrant 重新占用并在额度不足时原子失败。
- 实例必须具有 Owner 可见的请求频率策略，至少覆盖单 Principal、实例总请求与未认证/Public Join 路径。请求门控用于近似抗滥用，不能替代 D1 中的精确业务 quota。
- 首次部署必须自带零参数限流档位：单 Principal 动态 API 120/60 秒、实例全部动态 API 300/60 秒、未认证敏感操作 30/60 秒。Owner Web 只读显示，修改通过 `cfkanban-deploy` 发布 Worker 配置，不触发 D1 migration。
- 参与者 Credential 轮换/全失恢复使用 Owner 创建、按稳定 principal ID 绑定既有 Principal，并固定为 `rotation | full_recovery` 的 Recovery Invite；它与普通 Project Invite 严格分离，参与者不能自行签发额外 Credential。
- v0 固定五个 workflow status key/category/order/terminal 语义；Project 只可覆盖显示名称且仅 Owner 可修改。Owner 或 Project `writer` 可带 expected version 在固定状态间任意显式转换和 reopen，Agent 不依赖显示名称推理。
- assignee 只能是唯一 Owner，或当前对目标 Project 具有有效 `writer` Grant 的 Principal；资格失效后保留引用并投影为待重新分配。
- 当前只讨论和写文档，不进行实现。

## 3. 系统层级与候选隔离边界

已确认的产品层级：

- 一个 Cloudflare 部署实例可以包含多个 Workspace。
- 一个 Workspace 可以包含多个 Project。
- 这个层级不等同于首发公共多租户 SaaS；注册、成员计费和面向互不信任组织的租户生命周期仍不属于 v0。

已确认的身份边界：

- Workspace 是显式持久化的命名空间，而不是部署级隐式单例。
- Principal 是部署实例内的稳定身份，可以同时获得多个 Project 的访问权，这些 Project 可以分布在多个 Workspace。
- Credential 只负责认证 Principal，不直接保存 Workspace、Project 或 role scope。
- Workspace 是资源归属和查询上下文，不是 v0 日常业务授权层级。
- Project 是 v0 唯一的日常业务授权边界；Workspace 权限不向 Project 自动继承。
- 新建 Project 默认不会向已有 Principal 开放，必须显式创建 Project Grant。
- 一个部署实例恰好有一个 active Deployment Owner Principal。Owner 是控制面身份，不通过 Project Grant 获得管理权。
- `owner_principal_id` 在实例内稳定且不可通过应用 API 变更；不设置备用 Owner，也不支持所有权转移。
- Owner 无需 Project Grant，隐式拥有全部 Project 的数据面读写能力；这不构成第三种 Project role。
- 只有 Owner 能创建 Workspace/Project、邀请参与者，并创建、变更或撤销 Project Grant。
- 只有 Owner 能软删除和恢复 Workspace/Project 容器；Project `writer` 的权限只覆盖容器内的业务内容。
- 参与者不能邀请其他 Principal，也不能管理任何 grant。

已确认的进一步边界：

- Project Grant 不带 expiry；每个 `(principal_id, project_id)` 只有一条当前记录，角色、撤销和重新授予通过 version/CAS 更新并保留 Audit/Event 历史。
- Project Invite 创建请求必须为每个 Project Grant 显式提交 `reader | writer`，服务端拒绝缺失或无效 role，且不从自然语言猜测。Agent Skills SPEC 另行规定可覆盖的产品建议：上层未指定 role 时推荐 `writer`，明确只读时使用 `reader`；该建议不改变 API 显式字段和服务端授权合同。
- Workspace 列表由当前 Principal 有权访问的 Projects 反向推导；没有 Project Grant 时，不因知道 workspace key 而获得可见性。
- Owner 的控制面和全量数据面权限都不依赖 Project Grant。所有参与者业务请求仍有明确 Workspace/Project 上下文，并根据有效 Project Grant 校验目标资源。
- Board 是按状态、标签、assignee 等条件查询出来的视图，不单独持久化。

Owner bootstrap、轮换和恢复不创建新身份：明文 Credential 只在签发时展示一次，D1 只保存安全散列；正常轮换先签发替代 Credential 再撤销旧凭据。部署外恢复不复活旧 Credential，也不改变 `owner_principal_id`。

Owner Credential 生命周期不能通过第一方 Web Session 管理。Web 只读展示 Owner Credential 非秘密摘要，且通用 Credential revoke 必须拒绝 Owner Principal 的 Credential。正常轮换由 `cfkanban-admin` 在替代 secret 已安全写入本地受限文件后，以当前 Owner Bearer Credential 调用原子 rotation；服务端在同一业务单元中建立替代 Credential 并撤销当前旧凭据，不产生“最后一个 Owner Credential 被先撤销”的窗口。全部 Owner Credential 丢失仍只允许部署外恢复。

服务端 Principal 同时保存不可变 `principal_id` 与可变、非唯一的 `display_name`。前者是授权、assignee、Grant、Event/Audit 和跨用户引用的唯一稳定身份；后者只用于展示，允许重名且不能参与认证、授权、去重、恢复或本地 Credential 选择。任何跨用户的 Principal/assignee 摘要都必须同时返回 `principal_id` 与当前 `display_name`，不能只返回名称。v0 不保存 `human | agent` Principal kind；Codex、Claude Code 等 Agent 宿主不是 Principal 类型。

## 4. 领域模型

### 4.1 v0 必需实体

| 实体 | 职责 | 关键字段或约束 |
| --- | --- | --- |
| Workspace | 部署实例内的显式命名空间与候选隔离边界 | immutable ID、稳定 key、display name、deleted_at、deleted_by_principal_id、version |
| Project | Workspace 内的 Issue 命名空间与权限边界 | immutable ID、workspace ID、稳定 key、name、可选有界 context、可选 Issue/Comment/Principal active limits、deleted_at、deleted_by_principal_id、version |
| Workflow Status | Issue 所处工作阶段 | 固定五个 key/category/position/terminal；Project-scoped display name override |
| Issue | 可追踪工作单元 | immutable ID、实例级全局 issue number 与 `CFK-<number>` identifier、project ID、title、body、status、priority (`none | low | medium | high | urgent`)、可空 assignee principal ID、deleted_at、deleted_by_principal_id、version |
| Label | 正交分类 | project scope、name 唯一、color 可选 |
| Issue Relation | 工作之间的语义关系 | parent、blocks、related、duplicate |
| Comment | 协作者可读内容或结构化完成记录 | kind (`standard | completion`)、author、body/structured payload、可空 reply_to_comment_id、deleted_at/tombstone、created_at；全部 append-only |
| Principal | 部署实例内的稳定调用主体 | immutable ID、非唯一 display name、version；v0 不提供 disable/delete 生命周期 |
| Credential | Principal 的可验证认证材料 | token prefix、hash、principal ID、issued_at、可滞后 last_used_at、revoked_at、revoked_by；无 expiry |
| Project Grant | 非 Owner Principal 对 Project 的独立授权 | immutable ID、principal ID、project ID、role (`reader | writer`)、revoked_at、revoked_by、version、唯一 `(principal_id, project_id)` |
| Invitation | Owner 发起的参与者 bootstrap 或恢复能力 | kind (`project_grant | principal_recovery`)、code hash、Project Grants 或 bound principal、Recovery mode (`rotation | full_recovery`，仅恢复邀请)、固定策略计算的 expires_at、revoked_at、redeemed_at、redeemed_by、created_by_owner |
| Public Join Policy | Owner 对单个 Project 开放自助加入的当前策略 | project ID 唯一、公开 opaque ID、有界 public summary、enabled/disabled metadata、version；访客每次明确选择 `reader | writer` |
| Instance Origin Settings | 实例向 Agent 发布首选 API 入口的非授权路由元数据 | singleton、一个规范化 HTTPS `preferred_api_origin`、单调 `origin_version`、updated_at/by；不保存 Cloudflare Token 或 aliases 清单 |
| Browser Launch | 把已认证 Principal 的现有权限短时带入浏览器 | opaque code hash、source credential、明确 target、固定 expires_at、redeemed_at/revoked_at、created_at |
| Web Authenticator | 同一 Principal 的 Passkey 公钥认证方法 | WebAuthn credential ID、公钥、登记 hostname 对应的 RP ID、counter/transport metadata、created/last-used/revoked；私钥不进入服务端，服务端记录不代表当前设备仍持有或可使用私钥 |
| Web Session | 浏览器同源会话，不是新身份或新授权 | token hash、principal、source kind/id（Credential launch 或 Web Authenticator）、scope、expires_at、revoked_at、last_seen_at；权限逐请求读取当前事实 |
| Event | 不可变领域事实 | 部署级单调 sequence、type、actor、subject、workspace/project scope、payload、created_at |
| Idempotency Record | 写请求重放保护 | principal、key、request fingerprint、stored response、expiry |

### 4.1.1 v0 应用级资源上限

这些是 cfKanban 自己的稳定边界，不跟随 Cloudflare 平台最大值放大：

- JSON 请求体最大 128 KiB；超出返回 `PAYLOAD_TOO_LARGE`，不进入业务处理。
- Issue title 去除首尾空白后为 1～256 个 Unicode code points；Markdown body 最大 64 KiB UTF-8。
- 普通 Comment body 最大 32 KiB UTF-8；completion comment 的完整结构化 payload 最大 32 KiB，其中 `summary` 仍必填。
- display name 最大 128 个 Unicode code points；Label name 最大 64 个，单个 Issue 最多绑定 20 个 active Labels。
- 普通列表默认 `limit=20`、最大 `limit=100`。Agent context 响应最大 64 KiB JSON；超出时按字段优先级截断并返回 `truncated=true` 与后续 cursor。

完整构建日志、二进制、补丁、大型报告和附件不允许内联规避这些限制，应在 `artifacts` 中保存外部引用；未来 R2 附件属于独立增强。

### 4.2 暂缓实体

- Attachment：后续由 R2 保存对象，D1 只保存引用。
- Subscription/Webhook：需要 Queues 和外部投递合同后再加入。
- Saved View/Board：先由查询参数表达。
- Initiative/Cycle/Roadmap：不进入 v0。
- Vector document/embedding：属于可重建索引，不进入核心 schema。
- Execution Lease/Lock：v0 不需要；只有未来出现必须排他的外部执行场景并获得新的产品证据时，才作为独立增强重新设计。
- User account/organization/team membership：多 Workspace 只是同一部署实例中的应用层逻辑命名空间，所有 Workspace 共享 Worker、D1、域名、部署生命周期和配额；它不是面向 hostile tenants 的基础设施隔离，不要求首发完整成员系统或 maintainer。

### 4.3 Workspace、Project 与 Issue 标识

- 所有实体有不可变内部 ID。
- Workspace 在部署实例内有唯一稳定 key；key 从创建起不可修改，改名只修改 display name。
- Project 在 Workspace 内有唯一稳定短 key，例如 `APP`；不同 Workspace 可以复用同一 key。Project key 只用于 Project scope，不参与 Issue identifier。
- 每个部署实例共享一条 Issue number 序列。创建 Issue 时分配下一个正整数并生成 canonical `CFK-<number>` identifier，例如 `CFK-123`；序号单调递增、允许空洞且永不复用，因此 identifier 在部署实例内唯一。
- 不同部署实例可以各自存在 `CFK-123`；跨实例寻址必须同时携带 `instance_id`。实例内部可以仅凭 identifier 定位候选 Issue，但仍必须按其所属 Project 做授权过滤，无权时按不存在返回。
- Project key 从创建起不可修改；需要改名时只改 display name。
- v0 不允许 Project 或 Issue 直接移动到另一个 Workspace；Issue Relation 可以跨越同一 Workspace 内的 Project，但不能跨 Workspace。
- Project 内容的“删除”不立即物理删除历史；统一写入 `deleted_at`、`deleted_by_principal_id`、version 和 Event/Audit，必要时由不可变 tombstone 表达，不设置单独 delete role。
- `writer` 可以软删除和恢复 Issue、普通 Comment、Label、Relation 等 Project 内容，但不能软删除或恢复 Workspace/Project 容器。结构化 completion comment 是完成证据，不允许编辑或删除。
- Workspace/Project 容器只能由 Owner 软删除和恢复。容器软删除只标记自身，不批量改写子行；子资源和 Project Grants 保留但在父容器删除期间不可用。
- 恢复容器后，未被单独删除的子资源重新可见，未撤销的 Project Grants 自动恢复；单独软删除的子资源和已撤销 Grants 不会复活。容器暂停不改写 Public Join Policy；Project/Workspace 恢复时，此前仍 enabled 的 Policy 以同一 public ID、summary、limits 和 counters 自动恢复，已被 Owner 单独关闭的 Policy 不会复活。
- 默认查询、assignment 和普通写入排除 effective-deleted 资源；父容器删除也视为子资源 effective-deleted。Workspace key、Project key 和实例级 Issue number 在删除后不复用。
- v0 在对应的单资源读取/列表能力上提供显式 `deleted=only` 恢复视图，不另建带隐藏时间窗的“最近删除”概念。它只返回资源自身带 `deleted_at` 的 tombstone，不能因为父容器暂停就展开或复制全部子资源；结果按 `deleted_at` 倒序并沿用普通 cursor/limit。
- 恢复视图只向有权恢复该资源的调用者开放：Project 内容要求目标 Project `writer` 或 Owner，Workspace/Project 容器要求 Owner；Relation 仍执行两端 Project 的授权过滤。列表只返回恢复所需的有界摘要，包括资源类型、稳定 ID/identifier/key、显示名称或标题、`deleted_at`、`deleted_by`、version、父级状态以及 `restorable`/结构化不可恢复原因。已知标识时也可以直接读取单个 tombstone。
- v0 不提供公开 hard-delete API。长期物理保留和受控 purge 策略延后到有真实容量需求时决定。
- v0 产品与 Skills 不提供完整 D1 导出、导入、本地恢复演练或整库灾难恢复能力。Cloudflare 自身的 Time Travel、控制台导出或其他平台运维功能属于部署者直接管理的外部能力，不进入 cfKanban 用户故事、API 或 Skill 合同。

### 4.4 Project 与代码仓库

- Project 是工作协调命名空间，不是 Repo 的镜像或权限代理。
- 系统不强制 Repo 与 Project 一一对应；同一 Repo 可以关联多个 Project，一个 Project 也可以涉及多个 Repo。
- Repo URL、provider、branch 或 worktree 信息只是外部上下文，不能自动扩大 Principal 的 cfKanban 授权；Issue assignment 也不能转换为代码仓权限。
- 用户说“用 Project 跟踪这个 Repo”不授权服务端自动保存本地路径或 Git remote。只有用户明确要求时，才用结构化 external reference 保存 canonical Repo URL；它仍不授予任何 cfKanban 或代码仓权限。
- 日常 Repo/Project 关联优先由 Skill 的非秘密本地 scope 配置表达，并允许同一 Repo 配置多个 Project；是否建立独立 Repository 实体后置。

### 4.4.1 Issue Relation

v0 支持四类稳定关系语义：

- `blocks`：有方向，A blocks B；`blocked_by` 是反向读取投影，不保存第二条镜像关系。
- `parent`：有方向，A parent of B；`child` 是反向读取投影，适合 Agent 拆分任务。
- `related`：无方向，内部按两个 Issue immutable ID 的规范顺序保存，避免重复边。
- `duplicate`：有方向，A duplicates B，B 是保留的 canonical Issue；关系本身不自动取消 A。

禁止 Issue 指向自身，禁止同一语义的重复 active relation。创建、软删除和恢复关系都写 Event，但不自动改变任一 Issue 的 status、assignee、Project Grant 或外部系统权限。

四类关系都可以跨越同一 Workspace 内的 Project，但不能跨 Workspace。跨 Project 创建、软删除或恢复关系时，调用者必须同时是 Deployment Owner，或同时对两端 Project 具有有效 `writer` Grant；只有一端 `writer` 或另一端仅 `reader` 都不足以写入。读取关系时，调用者必须同时可读两端 Project；否则该关系及无权端点不进入响应和计数，避免泄露其存在。关系记录保留 workspace ID 和两个不可变 Issue ID，Project/Issue 暂停或软删除期间按 effective-deleted 规则不可用，恢复后关系随端点重新可见。

### 4.5 状态模型

v0 已确认使用以下固定状态合同：

| key | category | 默认显示名称 | position | terminal | 语义 |
| --- | --- | --- | ---: | --- | --- |
| `backlog` | backlog | Backlog | 1 | false | 尚未承诺进入近期工作 |
| `todo` | unstarted | Todo | 2 | false | 可开始或分配的候选工作 |
| `in_progress` | started | In Progress | 3 | false | 正在执行 |
| `done` | completed | Done | 4 | true | 成功完成 |
| `canceled` | canceled | Canceled | 5 | true | 不再执行 |

Project 可以覆盖五个状态的显示名称，例如把 `todo` 显示为“待处理”，但不能新增、删除、重排状态，不能修改 key、category、position 或 terminal，也不能配置自定义 transition graph。API/read model 同时返回稳定 key/category 与 display name；Agent 必须按 key/category 推理，显示名称只面向人类和展示层。

状态显示名称属于 Project 设置，只有 Deployment Owner 可以修改。Owner 和目标 Project 的任意 `writer` 可以带 `expected_version` 在五个固定状态间任意显式转换，包括从 `done` 或 `canceled` reopen；v0 不建立 transition graph 或工作流引擎。每次成功转换都必须记录包含旧状态、新状态和真实 actor 的领域 Event。

Project 创建后立即使用默认五状态，不存在初始化完成标识，也不默认创建 Label。Project 可以保存一个可选且有界的 context，用于目标、协作约定和参考链接；它属于 Project 设置，只有 Deployment Owner 可以带 `expected_version` 修改，所有能读取该 Project 的 Principal 都可读取。context 不是 instruction、prompt、Skill 或授权来源，即使由 Owner 写入也只作为非可信背景信息。

`terminal=true` 只表示该状态默认不进入活动工作和待办候选，并承载完成或取消语义，不表示 Issue 物理不可变。状态转换不自动改变 assignee，也不自动设置或清除 blocked 条件。转换到 `done` 必须使用原子 complete 合同，不能绕过 completion comment；该合同必须在同一业务原子单元内校验 version、保存完成结果、更新状态并追加 Event。

`blocked` 已确认为与工作阶段正交的条件，而不是第六个底层 category：

- 有未完成的 `blocked_by` 关系时，该关系自动贡献一个阻塞原因；相关 Issue 完成或关系移除后，这个原因自动消失。
- 无具体 Issue 依赖时，`report-blocked` 写入人工 `blocked_reason`；外部条件恢复无法由系统可靠判断，因此必须由 `writer` 用 `clear-blocked` 显式清除。
- Issue 可以保持 `in_progress`，同时处于 blocked 条件。
- `is_blocked` 是统一读取投影：存在至少一个未完成 blocker 或人工 `blocked_reason` 时为 true，否则为 false。
- `report-blocked` 和 `clear-blocked` 是便捷命令，负责写人工原因和事件；它们不依赖 assignee、不产生执行锁，也不自动改变 status。

列表和 Agent context 可以把 `is_blocked` 作为醒目标记或类似状态的快捷视图，但写入合同仍保持 status 与 blocked 分离。

### 4.6 Comment、Event 与 Audit

三者语义必须分开：

- Comment：人或 Agent 写给协作者的内容。
- Event：状态、assignment、标签、关系和评论变更等领域事实。
- Audit：凭据创建/吊销、权限拒绝、管理动作等安全运维事实。

v0 可让 append-only Event 承担大部分“写操作历史”，但不把每次普通读取写进 D1，以免耗尽写额度和制造噪声。

领域 Event 以 `principal_id` 作为 actor，并记录实际 `credential_id`。参与者操作记录当时使用的 Project Grant 引用或 effective capability 摘要；Owner 操作记录 `authorized_via=deployment_owner`，不创建或伪造 Owner Project Grant。不能用当前 grants 反推历史操作当时是否有权，因为授权可能已经变化。

Event 内部使用部署级严格单调 sequence，跨 Workspace/Project 共享同一顺序；按权限过滤后出现 sequence gap 是正常现象，不能据此推断无权事件内容。公开 API 返回 opaque cursor，不把内部序号当成可组合业务标识。cursor 绑定 Principal、规范化过滤条件和请求时实际可读的 Project ID 集合；同一 Principal 的 Credential 轮换不改变 cursor 身份。

如果调用者改变 Project filter，或 Grant/容器变化导致实际可读 Project 集合不同，旧 cursor 返回 `CURSOR_SCOPE_MISMATCH`，不静默续读。服务提供重新获取当前 scope 的有界 Issue snapshot 和 snapshot cursor；也允许先取 cursor 后取快照、再按 Event ID 幂等应用 cursor 之后的 Event。何时执行恢复与是否持久化 cursor 由上层调用方决定；v0 不支持跨 Principal 复用 cursor。

普通 Comment 创建后不允许原地编辑。写错时追加一条带 `reply_to_comment_id` 的普通 Comment 说明纠正；服务端不建立 Comment revision 子系统。目标 Project `writer` 可以按既有数据面权限软删除或恢复普通 Comment，读取以 tombstone 表达删除但不无痕覆盖历史。

`kind=completion` 的结构化 Comment 进一步禁止软删除或恢复操作。其公开 payload 是一个经过 schema 校验的 JSON object：`summary` 必填，`verification`、`artifacts`、`follow_ups` 为可空列表。D1 可以把它保存为规范 JSON 或拆列，但这只是实施细节，不能改变公开字段语义。reopen 不删除旧 completion comment，再次完成会追加新记录，因此同一 Issue 可以保留多轮完成历史。写错时可以追加普通纠正 Comment；完成结论失效时应 reopen 后重新 complete。

## 5. 身份、鉴权与授权

### 5.1 安全原则

- `Authorization: Bearer ...` 是 Agent API 的基础传递方式。
- 长期 Credential token 不进入任何 URL、Issue 正文、Skill 文档、日志或 Git。短期一次性 Invitation code 可以作为 Invite URL 的组成部分，但整个 URL 在兑换前都必须按 Bearer secret 处理。
- 客户端本地以 immutable `instance_id` 定位实例记录，但 Credential 只能发送到该记录当前已信任的 API origin；远端自报相同 `instance_id` 不能自行扩大信任。已信任 origin 返回不同 ID 时停止；陌生 origin、Invite 或第三方单方面声称已有 ID 时，必须由当前 trusted origin 交叉确认，无法确认则先取得用户显式 rebind 授权，不能在此前发送认证材料。
- 每个实例由 Owner 通过只接受 Owner Bearer Credential 的原子能力发布一个规范化 HTTPS `preferred_api_origin`，每次成功修改递增 `origin_version`。它是应用层推荐入口，不创建 Cloudflare DNS/domain，不证明第三方域名所有权，也不把域名配置变成发布 manifest。
- Worker 在所有可达 origin 动态生成公开、非秘密、`Cache-Control: no-store` 的 `/.well-known/cfkanban-instance.json`，至少返回 discovery schema、稳定 `instance_id`、本次请求的规范化 `observed_origin`、`preferred_api_origin` 与 `origin_version`。不得返回 Credential、Principal、Project、Cloudflare account/resource ID、历史 origin 或管理 Token；不得跟随 redirect 伪造 observed origin。
- Agent 只有从当前 trusted origin 直接取得更高 `origin_version` 的 preferred-origin 指示，并在不发送 Credential、且不跟随跨 origin redirect 的探测中确认目标返回相同 `instance_id`、准确 `observed_origin` 与一致 preferred origin/version 后，才可以无提示地原子更新本地 trusted origin 和 receipt。探测失败、不一致或版本回退时不改本地状态，继续使用仍可用的旧 origin 并返回结构化提示。
- 认证 API 不使用跨 origin HTTP redirect 迁移客户端，避免不同 HTTP 栈转发 `Authorization`。Web Session 始终 origin-specific。虽然 WebAuthn 标准允许部分相关域名共享 RP ID，cfKanban v0 主动采用精确 hostname 边界：RP ID 等于当前请求 hostname，expected origin 等于当次规范化完整 HTTPS origin，不启用跨 hostname credential 共享。切换 hostname 后由 Agent Browser Launch 在新地址建立 Session，并重新登记该地址的 Passkey。
- D1 只保存 token 的安全散列和用于定位的非秘密 prefix；明文仅签发时展示一次。
- v0 Credential 不设置自动失效日期；只有显式 revoke 或正常 rotation/full recovery 中撤销旧 Credential 才使其失效。未来强制定期轮换只能作为明确启用的部署 profile，不能默默改变 v0 核心合同。
- Credential 不做设备或 Agent 宿主绑定。用户可以自行把同一 Bearer Credential 复制到多个受信执行环境；服务端无需也无法把这些副本区分为独立身份。所有副本共享同一 Principal、fingerprint、`last_used_at`、审计主体和 revoke/rotation 后果。
- `last_used_at` 只用于 Owner 运维判断，可以按最多每日一次的低频条件更新并允许滞后；它不能参与鉴权、自动撤销或自动轮换，避免把普通读取放大为每请求 D1 写入。
- Principal 由验证后的 Credential 推导，客户端不能用 Header 覆盖。
- Credential 的职责止于认证 Principal；非 Owner 的业务权限和角色从独立 Project Grant 读取，Owner 的部署级能力由唯一 Owner 身份推导。
- v0 不提供 Principal disable/enable/delete。全局停止某 Principal 的认证使用 Credential revoke；停止某个 Project 的访问使用 Grant revoke；身份、assignment 与历史引用保持稳定，恢复认证使用 Principal Recovery Invite。
- 同一 Principal 的所有有效 Credential 共享同一套 effective permissions；需要不同权限的 Codex、Claude Code 或其他运行主体必须使用不同 Principal，而不只是同一 Principal 的不同 Token。
- 任一 Credential 泄露都会暴露该 Principal 当前全部有效 grants，因此 Principal 粒度也是实际 blast-radius 边界。
- `X-Agent-Session-ID` 可作为可选运行标签，但不参与权限、封禁或可靠审计。
- root/bootstrap 凭据不发给日常 Agent。
- 应用 API 不提供创建第二 Owner 或变更 `owner_principal_id` 的能力；部署外恢复也只能为同一个 Owner Principal 补发认证材料。
- Owner Credential 全失恢复不提供应用内 HTTP 端点；受控 Skill 脚本必须证明操作者掌握 Cloudflare deployment，并追加不含秘密值的 `owner.credential_recovered` 安全 Audit。

### 5.2 Project Grant 与最小角色

| 角色 | 权限 |
| --- | --- |
| reader | 读取被授权 Project、Issue、评论和事件 |
| writer | reader + assign/unassign、创建与修改 Project 内容、评论、完成，以及 Project 内容的软删除和恢复 |

非 Owner 只使用这两个固定 role，不首发 maintainer、delete、任意 scope 或 policy expression。Project Grant 把一个 role 赋给 Principal 和一个明确 Project；同一 Principal 可以拥有任意多个 Project Grants，但每个 `(principal_id, project_id)` 只有一条当前记录。Grant 不设置失效日期；角色、撤销和重新授予使用 version/CAS 更新同一行并留下 Audit/Event，历史事件记录 grant ID、grant version 和当时的 effective capability 摘要。

Grant 有效性只要求 Project/Workspace 未暂停且 Grant 未撤销。只有 Owner 可以创建、变更角色、撤销或重新授予；参与者不能续期或自助改变 Grant，因为 v0 根本不存在 Grant expiry/renewal 概念。

鉴权流程必须先由 Credential 认证 Principal。若 Principal 是唯一 Owner，则无需查询 Project Grant，直接获得全部控制面和 Project 数据面能力，并以 `authorized_via=deployment_owner` 审计。其他 Principal 再用请求中的 Project 和 D1 中的有效 Project Grant 计算允许动作。Workspace 只通过 Project 归属参与寻址和隔离，不产生继承权限；参与者 API 只返回 Principal 已获 Project Grant 的资源。

v0 不支持 Workspace grant、向下继承、显式 deny 或多条规则叠加。需要访问同一 Workspace 的十个 Project，就创建十条 Project Grants；新建第十一个 Project 时不会自动获得权限。

只有 Owner 可以创建或撤销 Invitation，并创建、变更和撤销 Project Grant。首次参与者 bootstrap 和后续 Credential 轮换/全失恢复分别按 5.4、5.5 执行。`writer` 不能邀请其他参与者、签发额外 Credential、改变 grants，也不能创建、软删除或恢复 Workspace/Project 容器。

### 5.3 两种撤销语义

| 操作 | 语义 |
| --- | --- |
| Revoke Credential | 只使这份认证材料失效；同 Principal 的其他 Credential 和 Project Grants 不变 |
| Revoke Project Grant | 该 Principal 的所有 Credential 都失去目标 Project 的对应能力；其他 Project Grants 不受影响 |

Credential revoke/轮换不改变 Issue assignee、Project Grants、幂等记录和历史事件中的 Principal。Project Grant 撤销或角色降为 `reader` 不会自动改写历史 assignment 或 Issue status；读取时返回 `assignee_available=false`、`needs_reassignment=true`，等待 Owner 或目标 Project `writer` 显式重新分配或取消分配。

### 5.4 Project Invite URL bootstrap

Owner 创建 Invitation 后，服务端返回一段可直接复制的简短话术；主体是一条 Invite URL，例如：

`请仔细阅读 https://kanban.example.com/invite?code=<opaque> 的说明，以便加入指定 Project。`

Project Invite 是短期、一次性的 Bearer capability，而不是长期共享 Project token：

- 服务端只保存 code 的安全散列；记录由 Owner 预先确定的一个或多个 Project role、Invitation 过期时间、撤销和兑换状态，`kind=project_grant` 且不绑定既有 Principal。只有 Invitation 自身带 expiry，兑换后的 Project Grant 不带失效日期。
- Project Invite 的 `expires_at` 固定为服务端 `created_at + 7 days`；创建 API 不接受自定义时长，也不能延长现有邀请。到期后由 Owner 创建新邀请。
- 持有尚未过期且未兑换 URL 的人即可兑换；v0 不声称通过邮箱、用户名或自报 Agent ID 验证预期接收者。
- Invite URL 的 GET 只返回 bootstrap 说明、邀请摘要和可信 Skill 的安装或更新入口，绝不消费 Invitation。聊天软件预览、浏览器预取和 Agent 首次阅读必须无副作用。
- 真正兑换由用户的 Agent 按 Skill 通过幂等 POST 发起；需要本地凭据操作时调用 Skill 内置 Node 脚本。服务端在一个业务原子单元中消费 Invitation、创建或复用 Principal/Credential、写入 Project Grants 和 Event/Audit。
- 本地已有该 `instance_id` 的当前有效 Credential 时，客户端用它认证并复用对应 Principal；本地从未有该实例身份时才创建新 Principal/Credential。每个执行环境对每个实例只维护一个当前本地 Principal；发现同一实例对应多个不同 Principal 时视为本地冲突并停止，不提供常规身份选择或静默猜测。同一 Principal 的 Credential 轮换过渡不算多个身份。
- 本地发现已失效 Credential 时，不能凭 display name 或本地旧记录静默恢复既有 Principal；客户端必须让人选择“请 Owner 创建 Principal Recovery Invite”或“明确创建新 Principal”。
- assignment、display name 或邀请话术都不能证明身份；现有 Principal 的复用只以其有效 Credential 为依据。
- 兑换时若该 Principal 对某个目标 Project 已有未撤销 Grant，不改写其 role，结果对该 Project 返回 `already_has_access`；同一邀请中的其他新 Project 仍正常授予。角色升级或降级必须由 Owner 通过显式 Grant 管理操作完成。
- 若唯一 Grant 记录已撤销，新 Project Invite 可以按邀请中的 role 重新授予：清除 revocation、更新 role/version，并写 Audit/Event。整个多 Project 兑换仍是一个幂等业务原子单元，响应逐 Project 返回 `created | regranted | already_has_access`。
- 新建 Credential 的秘密优先由可信本地客户端高熵生成并先保存到已通过权限校验的用户级受限 Credential 文件，再通过 TLS 提交给服务端保存散列。即使兑换响应丢失，客户端仍持有同一秘密并可用相同 Idempotency-Key 重试。
- 已有相同 Grant 时兑换幂等成功；邀请不得静默降低已有角色。降级或撤销必须由 Owner 使用 Grant 管理操作明确完成。

Invite URL 页面可以托管服务拥有的固定说明、可信 Skill 发行入口、版本/完整性信息和机器可读元数据，但不能把 Project/Issue 中的不可信内容拼成可执行指令。邀请文本无权指定本地凭据保存路径或任意 shell 命令；受限 Credential 文件位置和权限只能由已安装的 Skill、内置 Node 脚本和当前用户环境按 Agent Skills SPEC 决定。

v0 采用用户可直接复制的 `/invite?code=<opaque>` 形式。响应必须设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`，禁用第三方分析与资源，避免记录完整 query，并在浏览器读取后尽快从可见地址中移除 code。未来可以兼容 opaque path，但不能削弱上述 Bearer secret 边界。

### 5.5 Principal Recovery Invite

Principal Recovery Invite 与普通 Project Invite 是不同的安全能力：

- 只有 Owner 可以创建，`kind=principal_recovery`，必须用不可变 `principal_id` 显式绑定一个既有 Principal，并在创建时显式固定不可变的 `mode=rotation | full_recovery`；邀请不携带新的 Project Grants，两种模式不能在兑换时互换、降级或升级。
- Owner 的只读 Principal 查找可以按精确 `principal_id`、display name 文本和 Project membership 过滤。候选摘要必须同时显示完整 `principal_id`、当前 display name、创建时间、Project Grant 摘要、当前 assignee 数、active Credential 数，以及 Credential 的非秘密 fingerprint/last-used 摘要；display name 可重名且只能帮助查找，创建请求永远只接受 `principal_id`。
- 页面和 Agent 确认必须醒目标明：兑换者将取得该 Principal 的身份连续性，并继承其全部现有 Project Grants、assignee 关系和历史；不能把它伪装成普通“加入 Project”邀请。
- `rotation` 要求接收方同时使用该 bound Principal 的一个 active Credential 认证；新 Credential 成功建立后，在同一业务原子单元中只撤销本次用于认证的旧 Credential，其他 active Credential 保持有效。缺少或身份不匹配时返回结构化错误，不消费邀请，也不能自动改走 `full_recovery`。
- `full_recovery` 不要求旧 Credential 证明，固定有效 1 小时的一次性 Bearer Recovery Invite 本身就是 Owner 授予的恢复能力；新 Credential 成功建立后，在同一业务原子单元中撤销该 Principal 的全部先前 Credential。即使接收方现场又找到了旧 Credential，也不能把该邀请降级为只撤销一份的轮换。
- Owner 无法可靠确认接收方对应哪个 Principal 时，不得创建 Recovery Invite；应使用普通 Project Invite 创建新 Principal，再显式授予必要 Grants。
- 参与者不能通过普通业务 API 自行签发额外 Credential；轮换和恢复都必须由 Owner 创建 Recovery Invite。
- 创建、兑换、轮换、全失恢复、旧 Credential 撤销和失败重试必须写独立 Event/Audit，并记录固定 mode 与撤销数量，但不记录 code 或 Credential secret。

Recovery Invite 使用与 Project Invite 相同的一次性、短期、hash-only、GET 无副作用和幂等 POST 约束，但 `expires_at` 固定为服务端 `created_at + 1 hour`。创建 API 不接受自定义或延长时效；到期后由 Owner 重新确认恢复对象和 mode 并创建新邀请。响应丢失时，客户端使用已安全保存的新 secret 与相同 Idempotency-Key 重试；不得生成第二份 Credential。

两类 Invitation 都只在服务端当前时间严格早于 `expires_at` 时可兑换；`now >= expires_at` 返回 `INVITATION_EXPIRED`，不消费邀请，也不执行部分写入。

共享 Master Token + `X-Agent-ID` 不作为默认安全模式。Cloudflare Access 可以作为未来部署外层增强，但不替代应用内 Principal、Invitation 和 Project Grant。

### 5.5.1 Public Join

Public Join 与一次性 Invitation 是两种不同能力。Owner 可以对多个 Project 分别开启或关闭 Public Join；公开发现只列出已开启 Project 的显示名称、有界 public summary、公开 opaque ID 和 `reader | writer` 选择，不泄露 Workspace/Project key、内部 context、Issue、成员或其他未公开事实。v0 不提供 Team Join、群组成员模型或一个动作授予多个 Project。

一次 Public Join 请求只针对一个公开 Project 与一个显式 role。未认证的新参与者由可信 Agent 本地生成并保存 Principal/Credential 所需 secret，再执行原子 self-join；已有 Credential 或 Passkey Session 的 Principal 复用当前身份。服务端在一个业务原子单元内校验 Policy/Project 当前有效、认证或新身份材料、幂等键和现有 Grant，然后最多建立或更新一条 `(principal_id, project_id)` Grant 并写 Event/Audit。Public Join URL/话术不是 Bearer secret，Grant 不带 expiry。

无 Grant 时按所选 role 建立；已有同等或更高权限时幂等返回当前权限；已有 `reader` 选择 `writer` 时允许提升；已有 `writer` 选择 `reader` 不自动降权。Owner 开启 Public Join 必须明确接受访客可选择 `writer`，即未知互联网参与者可以修改、评论、移动、完成和软删除 Project 内容并制造 D1 写入；服务端不能静默改为 `reader`。

Owner 关闭 Public Join 只阻止新的 self-join，不自动撤销既有 Grants。Public Join 不建立逐 Principal blacklist/denylist：Project 仍公开时，被撤销 Grant 的 Principal 可以再次 self-join；相同 Principal 复用唯一 Grant 行，不创建重复 Principal、Credential 或 Grant。Owner 若要停止全部新加入，必须关闭该 Project 的 Public Join。

Owner 开启 Public Join 前必须为该 Project 显式提交正整数 `issue_limit`、`comment_limit` 与 `principal_limit`；服务端不从缺失字段生成默认值。每个 Project 独立保存和计算，三者不形成实例共享池，一个 Project 的开关、usage 或 limits 不得改变其他 Project 的计数或可用容量。它们只在该 Project 的 Public Join `enabled` 期间约束该 Project 的全部 actor，而不只约束公开参与者：Issue 统计 `deleted_at IS NULL` 的有效 Issue；Comment 统计有效 Issue 下未软删除的 standard/completion comments；Principal 统计当前未撤销的非 Owner Project Grants，不区分 Invitation、Owner 直接授权或 Public Join 来源。

Issue/Comment 软删除与 Grant revoke 必须释放对应 active quota。软删除一个 Issue 还会使其下未软删除 Comments 暂时不占 Comment quota；恢复该 Issue 时必须同时校验并重新占用一个 Issue slot 和其全部有效 Comments 所需的 Comment slots。Comment restore、Grant regrant 或再次 self-join 同样重新占用额度；不足时整个领域操作原子失败。completion comment 本身不可删除；在其 Issue 有效期间始终占用 Comment quota。active quota 不等于物理删除，也不声称释放 tombstone 的 D1 存储。

Owner 关闭 Public Join 时，本 Project 的三项 quota 立即停止强制，但既有 Issue、Comment、Grants 和 limits 都不被删除或撤销；其他 Project 完全不受影响。重新开启时必须由 Owner 显式提交三项限制，Web 可以把旧值作为可修改的表单预填，但服务端不能静默沿用。启用时服务端基于权威资源状态计算当前 usage，再原子保存 limits 与启用 Policy。

Project 或其 Workspace 软删除只让仍 enabled 的 Public Join 暂时不可发现、不可兑换，不等同于 Owner 关闭 Policy，也不删除 `project_usage` counter。恢复 Project/Workspace 后，该 Policy 自动恢复公开和 quota 强制。恢复命令的预览必须列出会重新公开的 Project；如果 Owner 不希望恢复公开，应在容器可用后显式关闭对应 Policy，而不是让容器生命周期暗中改写它。

Owner 可以用 expected version 调高或调低限制，新值允许低于当前 active usage。保存更低限制不自动删除 Issue/Comment、撤销 Grant 或回滚其他业务状态；对应维度进入 over-limit 后，服务端只拒绝会增加该 active count 的创建、恢复、regrant 或 self-join，读取、编辑、软删除、Grant revoke 和不改变 Principal 数量的 role change 继续允许。usage 降到 limit 以内或 limit 调高后，增长操作自然恢复。Web/Skill 可以建议 50 Issues、500 Comments、50 Principals 作为可覆盖的起点，但 Owner 必须显式提交，建议值不是 API 默认。精确 quota check 与计数变化必须和相应领域写入位于同一个 D1 原子单元；Public Join 满额不能留下孤立 Principal、Credential 或 Grant。Label、Relation、正文大小与分页继续使用服务端固定安全上限，不扩展成 Owner 通用配额面板。

### 5.6 Browser Launch 与 Web Session

v0 的第一方 Web UI 不建立密码账号，也不允许把 `.cfkanban/` 中的长期 Credential 复制进浏览器。已认证 Agent 可以为一个明确的 Project、Issue 或 Owner 管理 target 创建短期、一次性的 Browser Launch capability；它只携带建立浏览器会话所需的 opaque code，不携带长期 Credential。

Launch 页面 GET 只读且不消费 capability，避免链接预览或安全扫描造成副作用；必须由同源页面显式 POST 兑换。成功后服务设置 `HttpOnly + Secure + SameSite` cookie、立即使 code 失效，并跳转到不含 code 的 target URL。Web Session 认证回同一个 Principal，不产生新 Principal、Grant 或 role；每次请求仍按 D1 当前 Principal、Credential/Session、Grant 和容器状态授权。

Browser Launch 固定在创建后 5 分钟内可兑换且只能成功一次。Web Session 固定有效 8 小时，不滑动续期且无 refresh token；它绑定 `principal_id + source_kind + source_id`。Agent Launch Session 的 source 是发起 launch 的 Credential，Passkey Session 的 source 是完成认证的 Web Authenticator；对应 source revoke、Session 显式 revoke 或固定 expiry 到达都使其立即失效。Project Grant 与容器状态始终逐请求读取当前事实。

Session 还绑定 launch target scope：Project target 只访问该 Project；Issue target 只访问该 Issue 所属 Project，并以该 Issue 为初始页面；只有 Owner `admin` target 具有实例级管理与数据面 scope。Owner admin Session 默认进入 Overview，不自动读取全部 Issue，但可以在显式选择 Workspace/Project 后进入任意 Project 看板。普通 Project/Issue Session 的页面导航不能扩大 scope，切换范围时由 Agent 创建新的 Browser Launch。完整 launch URL、code、cookie、长期 Credential 及其 hash 不进入日志、Audit payload、analytics、错误或浏览器可读存储。cookie-auth 写入必须有 CSRF 防护，业务 Markdown 与外部链接仍按不可信输入处理。

首次 Agent-launch Session 建立后，当前 Principal 可以显式登记一个或多个 Passkey。首次与补充登记都要求 Session 的来源是 Agent Browser Launch；D1 只保存 WebAuthn credential ID、公钥和验证 metadata，浏览器/OS authenticator 保存私钥。当前 Principal 可以列举并撤销自己的 Passkey，Owner 可以撤销参与者的 Passkey；登记、成功认证和撤销写安全 Audit。Passkey 撤销立即使以该 authenticator 为 source 的未过期 Sessions 失效，但不撤销 API Credential 或 Project Grants。

Passkey 登录只签发相同固定 8 小时、无 refresh 的 Web Session。参与者 Passkey Session 先进入当前有权 Project 选择页，之后每个请求按实时 Grant 校验；Owner Passkey Session 先进入 Overview，并可显式进入任意 Project。两者都不自动执行无 Project filter 的 Issue 聚合查询。Passkey 不是 Bearer API Credential、Grant 或 role；丢失、不兼容或 hostname 变化时继续用 Agent Browser Launch 恢复，不能按 display name 绑定或恢复身份。

未认证网页只能探测浏览器是否提供 WebAuthn、平台认证器或 conditional mediation 等客户端能力，不能静默枚举或证明当前设备已有本站 Passkey。认证取消、超时、无匹配 credential、认证器不可用或策略拒绝不得被服务端或 UI 归结为“没有 Passkey”。服务端列举的只是当前 Principal 已登记且未撤销的认证器记录，不是当前设备 credential inventory；精确可用性只由用户主动发起并成功完成认证证明。

## 6. Assignment 与并发

### 6.1 三个独立概念

- assignee：当前主要责任归属，是可空的 `Principal` 引用。
- status：Issue 的工作阶段。
- actor：实际执行本次写操作并被审计的 Principal。

assignee 不等于 actor，也不参与授权判断。Issue 分配给 A 后，具有目标 Project `writer` 权限的 B 仍可修改正文、添加评论、更新状态、complete、report-blocked 或重新分配负责人；所有操作记录真实 actor。

assignment 本身不授予 Project 访问权，也不代表代码仓、云环境或其他外部系统的执行授权。新的 assignee 必须满足以下任一条件：

- 是唯一 Deployment Owner；或
- 是当前对目标 Project 具有有效 `writer` Grant 的 Principal。

`reader`、无目标 Project Grant 或 Grant 已撤销的身份都不能成为新 assignee。服务端必须在 assignment 条件更新的同一一致性边界内检查资格，避免授权刚被撤销却仍成功分配。

assignee 后续失去资格时不自动清空引用、不改变 status，也不删除历史 Event。`assignee_available` 是按当前 Principal/Grant 推导的读取字段；`needs_reassignment` 在存在 assignee 且其当前不可用时为 true。候选读取可以显式过滤该投影，供 Owner 或其他 `writer` 处理。

v0 不保存 `lease_id`、`expires_at` 或 `fencing_token`，也没有 renew、release、超时接管或“只有当前持有者才能完成”的规则。`assign-to-me` 若作为便利命令提供，只把 assignee 设置为当前 Principal，不产生锁。

### 6.2 乐观锁

普通 Issue 更新携带 `expected_version`。服务端用单条条件 SQL 更新，并根据影响行数判断成功：

`UPDATE issues SET ..., version = version + 1 WHERE id = ? AND version = ?`

版本不匹配返回 `VERSION_CONFLICT`，同时提供当前 version 和可重试指引。多表原子写入使用 D1 transaction/batch。

### 6.3 幂等

所有非天然幂等的创建与命令 POST 都必须携带 `Idempotency-Key`，至少覆盖 Invitation redeem、Issue 创建、Comment 创建、assign-to-me 和 complete/report-blocked/clear-blocked 等业务命令；缺失时返回 `IDEMPOTENCY_KEY_REQUIRED`，不执行写入：

- 同一 Principal、endpoint、完整资源 scope、key 和相同请求内容返回原响应。
- 相同 key 配不同请求内容返回 `IDEMPOTENCY_CONFLICT`。
- 幂等记录从首次成功提交起保留 24 小时；Agent 按 Skill 执行时不应在窗口外把同一 key 当成安全重试依据。
- 幂等身份使用 Principal 而不是 Credential，因此 Token 轮换后仍可安全重试；request fingerprint 必须包含完整 Workspace/Project 目标。
- 服务端必须先验证当前 Credential 和当前 effective authorization（Owner 控制面分支或有效 Project Grant），再决定是否重放历史响应，不能让已撤销授权凭旧幂等记录旁路鉴权。
- 尚无 Principal 的首次 Invitation redeem 是明确例外：幂等作用域使用 Invitation ID、endpoint 和 key，request fingerprint 必须包含客户端生成 Credential 的稳定 fingerprint 与完整兑换材料。服务端先验证 Invite code，再允许匹配的已消费 Invitation 重放首次结果；不同请求内容仍返回 `IDEMPOTENCY_CONFLICT`。

这用于避免重复身份、Credential、Project Grants、评论、完成、assignment 命令和事件。

### 6.4 并发与重试验例

下列验例用于验证上述合同，不依赖具体 D1 DDL：

| 场景 | 必须得到的结果 |
| --- | --- |
| 两个 Agent 基于同一 Issue version 同时 assign-to-me | 条件更新至多一个成功；失败方得到 `VERSION_CONFLICT`，刷新后由人或 Agent 重新判断，不自动抢占 |
| 非 assignee 的 writer 读取旧 version 后 complete | assignee 不构成权限限制；若 version 未变化则允许完成，若已变化则返回 `VERSION_CONFLICT`，不能覆盖新状态 |
| complete 已提交但响应丢失 | 当前授权仍有效时，以相同 Principal、scope、request 和 `Idempotency-Key` 重试返回首次响应，不追加第二条 completion comment 或 Event |
| 新 Principal 兑换 Invitation 已提交但响应丢失 | 客户端保留同一 Credential secret 并用相同 key/fingerprint 重试；服务端在验证 Invite code 后返回首次结果，不创建第二个 Principal、Credential 或重复 Grant |

## 7. Agent-facing 能力与组合示例

下列只是能力组合示例，不是 cfKanban 对上层 Agent 的必需工作流：

`discover → list → optional assign/self-assign → fetch context → progress → complete or block`

### 7.1 Discover

Discover 能力返回实例元数据、当前 Principal 可访问的 Workspace/Project、allowed actions 和可选增强能力；上层调用方可以按需使用，不应把不同部署的增强能力视为固定一致。

### 7.2 Candidate selection 与 Assignment

候选列表、一般 assignment 与 assign-to-me 是三个独立能力。assignment 是协作元数据，不是取得执行权；未被分配或已分配给其他人的 Issue 都不因此变成只读。

v0 不提供原子 `assign-next`。上层调用方可以自行组合“读取确定性候选”与“显式 assign/assign-to-me”，但 cfKanban Skill 不将组合固化为规范工作流。assignment 遇到 `VERSION_CONFLICT` 时返回当前 version 和刷新指引，不会静默改为另一个 Issue。

候选选择应使用公开、确定的策略：

1. status category 为 unstarted；
2. 根据请求明确选择只看未分配、已分配给当前 Principal，或 `needs_reassignment=true` 的 Issue；
3. 默认没有 `is_blocked=true`；调用者可显式请求包含 blocked Issue；
4. 满足 Project、label 和 capability filters；
5. 按 priority (`urgent > high > medium > low > none`)、created_at 升序、immutable ID 升序稳定排序。

priority 默认为 `none`，任何目标 Project `writer` 都可以带 `expected_version` 修改。v0 不保存手工 rank，也不支持拖拽重排；一般 Issue 列表默认按 `updated_at` 降序、immutable ID 降序，候选列表使用上述 priority + FIFO 顺序。API 返回稳定 priority key，显示文案由 Skill/UI 本地化。

`GET /api/v1/issues/candidates` 只返回候选，不能暗示已经分配或取得独占权。v0 不提供原子 `assign-next`；未来若有真实调用成本证据而新增，它也只能设置 assignee，不能产生 lease 或独占权。

### 7.3 Context Pack

Agent context 不是 Issue 所有历史的直接拼接。建议包含：

- identifier、title、body；
- status、priority、labels、version；
- 未完成 blocker 和父任务摘要；
- assignee 摘要、`assignee_available` 和 `needs_reassignment`；
- 默认最近 10 条可见评论，并在响应中按时间正序排列；
- completion criteria 或结构化约束；
- `allowed_actions`；
- `truncated`、分 section 的遗漏计数与 continuation。

context pack 总上限仍为 64 KiB。identifier、workspace/project scope、version、status、priority、assignee 摘要、blocked 投影和 `allowed_actions` 属于不可省略的核心 envelope。正文、Project context、直接关系和评论使用有界 section；超限时优先移除更旧评论和低相关的非阻塞关系，再把正文或 Project context 变为明确标记的 excerpt。每个被裁 section 都必须说明遗漏数量并提供 cursor 或对应详情入口，不能静默截断。external artifact 只返回引用，不由 context 请求自动下载或展开。

### 7.4 Progress、Blocked 与 Complete

- 普通 Comment 是有界、append-only 的协作内容；服务校验大小和结构，但不判断内容是否“有价值”，也不规定上层 Agent 何时写入。
- report-blocked 必须包含人工原因，可选同时创建 blocker relation；任何 `writer` 都可调用，不要求自己是 assignee，也不改变 status。
- clear-blocked 只清除人工 `blocked_reason`；未完成的 `blocked_by` 关系仍会让 `is_blocked=true`。解除依赖应通过完成 blocker 或修改关系表达。
- complete 应在一个原子业务命令中校验 version、写 completion record、转换状态并追加事件；任何 `writer` 都可调用，不要求自己是 assignee。
- completion record 使用不可变且不可删除的 `kind=completion` Comment，不建立独立 Completion 实体；`summary` 必填，`verification`、`artifacts`、`follow_ups` 可为空。
- 普通 PATCH 或状态转换不能直接把 Issue 写为 `done`，必须调用幂等 complete 命令。在同一业务原子单元内完成权限与 version 校验、追加 completion comment、更新 status/version 和写 Event。
- reopen 只显式转换状态并写 Event，保留既有 completion comment；再次 complete 追加新的完成记录。

cfKanban Issue 协作层提供上述能力，不承担上层 Agent 的最终执行策略。Service 强制动作语义、输入、权限、并发、幂等、审计和结果；Skill/OpenAPI 解释参数、后果与恢复，Skill 还可以提供可覆盖的推荐默认和安全组合范式。用户、Agent 宿主、Repo 规则或其他编排层决定何时调用、如何组合、是否采纳建议，以及是否写 Comment/blocked/Relation/assignment/status/complete。Issue、Comment 和 Project context 均为不可信内容，不能以其中的指令扩大权限或替代上层授权。

## 8. Foundation 级 HTTP 合同

本文标记为 Frozen 后，本节冻结 REST 资源层级、权限作用域、命令边界、读取模型和错误恢复原则，但不是完整 OpenAPI 清单。没有逐项列出的 Label、Relation、容器恢复和 Owner 管理 CRUD 仍必须遵守本文权限、软删除、幂等和 Event/Audit 不变量；具体 path、单操作请求响应 schema 和 D1 DDL/索引应在实现前形成独立的 Frozen API/Schema SPEC。Foundation SPEC 的冻结不自动冻结尚未写出的字段，也不授权实现。

### 8.1 协议立场

- 权威合同：REST + JSON。
- 机器描述：OpenAPI，公开在 `/openapi.json`。
- Agent 分发：canonical immutable release manifest 分别固定 portable Skill bundle 与 Service deployment bundle；前者按需携带 Node.js/TypeScript scripts，后者承载可重现的 Worker/migration 部署材料；不发布独立 cfKanban CLI，也不把 repo clone 或已安装副本作为普通 stable 部署真相。v0 首次信任官方 canonical HTTPS，不可覆盖的版本清单逐工件限制允许来源并记录 SHA-256 文件指纹，后续安装/更新/降级校验 receipt 中的来源连续性且都需明确授权；独立签名体系后置。
- 可选适配：后续远程 MCP；它包装 REST 业务合同，不成为第二个事实实现。

OpenAPI 并不保证所有 Coding Agents 自动生成可用工具；Agent Skills 仍承担能力说明、可靠调用与宿主兼容层，而不是日常工作流教学。MCP 也不必依赖本地 stdio，当前标准存在远程 Streamable HTTP，因此不把“永不支持 MCP”写成架构约束。

### 8.2 元数据与读取

基础读取入口：

- `GET /healthz`
- `GET /.well-known/cfkanban-instance.json`（公开动态实例发现；非发行 manifest，不接受 Credential）
- `GET /invite?code={opaque}`（bootstrap 文档入口，只读且不兑换）
- `GET /api/v1/meta`
- `GET /api/v1/me`
- `GET /api/v1/issues`（部署级授权过滤聚合；支持一个或多个 Project scope）
- `GET /api/v1/issues/candidates`（确定性候选列表；只读，不分配）
- `GET /api/v1/workspaces`
- `GET /api/v1/workspaces/{workspace_key}`
- `GET /api/v1/workspaces/{workspace_key}/projects`
- `GET /api/v1/workspaces/{workspace_key}/projects/{project_key}`
- `GET /api/v1/workspaces/{workspace_key}/projects/{project_key}/issues`
- `GET /api/v1/issues/{identifier}`
- `GET /api/v1/issues/{identifier}/context`
- `GET /api/v1/events?after={cursor}&limit={n}`（部署级授权过滤；支持一个或多个 Project scope）

列表使用 opaque cursor，不使用不断漂移的 offset。所有列表有服务端上限。

部署级 `GET /api/v1/issues` 只聚合当前 Principal 可读 Projects 中的 Issue，支持按一个或多个 Project、Workspace、status、assignee、label 和关键词过滤。每个结果必须包含明确的 `workspace_key`、`project_key`、实例内唯一 Issue identifier 和 immutable ID，使 Agent 不因全局编号而丢失资源归属。它不提供跨范围批量写入、assign-next 或隐式默认 Project。

Project 过滤在 HTTP 合同上可省略，此时表示全部已授权 Projects，并仍受 limit/cursor 约束。v0 使用可重复的 `project={workspace_key}/{project_key}` query 参数表达一个或多个明确 Project，最多 20 个；值按 URL 规则编码，服务端去重并按内部 Project ID 规范化，因此参数顺序不改变 cursor scope。可重复的 `workspace={workspace_key}` 用于明确的 Workspace 级发现；同一过滤维度内是 OR，不同维度之间是 AND。cfKanban Skills 的推荐解析顺序是“本次显式 Project targets → Repo scope targets → 无过滤并提示扩大”，并始终呈现 resolved scope、失效 target 和范围扩大警告；允许一个 Repo 配置多个活跃 Project。上层调用方可以覆盖该建议，Skill 不拒绝合法的全授权范围查询。

部署级 Event 读取沿用相同 Project scope 规则，只返回调用者当前可读 Projects 的领域事件。响应按内部 sequence 升序，返回 `next_cursor`、`has_more` 和 resolved scope；cursor 只能用于完全相同的规范化过滤与可读 Project 集合。安全 Audit 不混入参与者领域 Event feed，Owner 通过独立管理入口读取。

`GET /api/v1/meta` 和 `GET /api/v1/workspaces` 按当前 effective authorization 返回结果：Owner 可以发现并读写全部 Workspace/Project；参与者只看到有效 Project Grants 覆盖的 Projects 及必要 Workspace 摘要，不能看到其他 Project。

Workspace/Project 容器、列表和 Issue 创建继续使用 workspace/project-qualified path；单 Issue 读取与命令可以使用实例内唯一 `CFK-<number>` identifier，并由服务端解析所属 Project 后执行当前授权校验。Credential 不能提供默认 Workspace，因为同一 Principal 可以访问多个 Workspace；列表和创建仍需明确 scope。

### 8.3 写入与命令

基础写入与命令入口：

- `POST /api/v1/admin/invitations`（仅 Owner）
- `DELETE /api/v1/admin/invitations/{invitation_id}`（仅撤销未兑换 Invitation）
- `POST /api/v1/invitations/redeem`（接受现有 Credential 或新 Credential bootstrap 材料）
- `PATCH /api/v1/me`（带 `expected_version`，只修改当前 Principal 的 display name）
- `POST /api/v1/workspaces/{workspace_key}/projects/{project_key}/issues`
- `PATCH /api/v1/issues/{identifier}`
- `POST /api/v1/issues/{identifier}/comments`
- `POST /api/v1/issues/{identifier}/commands/assign-to-me`
- `POST /api/v1/issues/{identifier}/commands/report-blocked`
- `POST /api/v1/issues/{identifier}/commands/clear-blocked`
- `POST /api/v1/issues/{identifier}/commands/complete`
- 创建一次性 Browser Launch、兑换 Web Session 和退出当前 Session 的原子能力；具体 path/schema 由 API/Schema SPEC 冻结

v0 不提供 `assign-next` 端点。v0 必须提供同一实例托管的极简第一方 Web UI；它和 Agent Skills 都使用同一管理/业务 API 与权限合同，不形成第二套领域实现。Codex、Claude Code、小龙虾、Workbuddy 等都是同一种用户 Agent，部署、协调和 Coding 只是任务模式。portable Skills 可以直接调用 HTTP，也可以为凭据、重试、Browser Launch 或部署等确定性操作调用 bundle 内 Node scripts；不发布独立 cfKanban CLI，也不复制服务端领域规则。远程 MCP adapter 后置。

动作端点只用于真正的跨实体业务命令。普通字段编辑仍使用资源更新，避免把 API 全部变成不可组合的 RPC。

任何持有 active Credential 的 Principal 都可以通过 `GET /api/v1/me` 读取自己的 `principal_id`、`display_name`、version 和当前 Credential 的非秘密 fingerprint，并通过带 `expected_version` 的 `PATCH /api/v1/me` 原子修改自己的非空 display name。成功修改写 Audit/Event，但不改变 principal ID、Credential、Grants、assignment 或历史引用；v0 不允许 Owner 代改其他 Principal 的名称。version 冲突返回当前 version；本地非秘密名称 metadata 只是缓存，始终以服务端 `/me` 为准。

v0 不提供公开 batch/bulk 写入端点。每次 API 调用只表达一个领域操作，并在服务端内部原子完成该操作需要的授权/version 校验、业务行、关联行、Event/Audit 和 Idempotency Record。例如一次 Issue 创建只能创建一个 Issue，但可以原子写入该 Issue 对既有 Labels 的关联；Relation 创建是之后的独立领域操作。一个 Project Invite 携带多个明确 Project Grant specifications 仍是既有 Invitation 领域操作，不形成通用批量授权端点。上层调用方可以自行组合多个调用，每个逻辑操作使用独立且可重试的 `Idempotency-Key`。某项失败不会自动补偿或删除其他已经成功的操作；服务提供逐项 readback 和结构化恢复信息，但不规定上层的拆分、顺序、停止或续做策略。

### 8.4 Read model

JSON 可以提供三类稳定视图：

- summary：列表所需的标识、标题、状态、优先级、labels、assignee 摘要、`assignee_available`、`needs_reassignment`、version。
- detail：正文、关系、评论统计和最近事件。
- agent_context：为执行准备的有界上下文和 allowed actions。

聚合列表响应额外返回 resolved scope 摘要，至少区分 `explicit_projects` 与 `all_authorized_projects`，使 Skill/Agent 能识别本次结果是否可能包含较多无关项目；该摘要不能泄露无权 Project 的数量或名称。

首版不支持 `format=yaml` 或 `format=markdown`。Skill 可让 Agent 在本地渲染 Markdown。

### 8.5 错误

统一错误体至少包含：

- `code`
- `category`
- `source`
- `message`
- `request_id`
- `retryable`
- 可选 `retry_after_seconds`
- `recovery`
- `details`

`category` 是稳定机器分类，至少区分 `authentication | authorization | not_found | validation | conflict | business_quota | rate_limit | platform_quota | platform_failure`。Worker 生成的普通业务错误使用 `source=service`；Worker 捕获并安全映射的 D1 平台错误使用 `source=cloudflare_platform`。`retryable=true` 只表示等待服务端建议时间后可以原样重放同一请求；`VERSION_CONFLICT`、`CURSOR_SCOPE_MISMATCH` 和业务校验失败都必须为 false，因为客户端需要先刷新状态或改变请求。`recovery` 使用稳定机器提示，例如 `reauthenticate`、`refresh_resource`、`refresh_cursor`、`free_capacity_or_request_owner`、`retry_after`、`wait_for_platform_reset`、`request_owner` 或 `none`；`message` 只供人类理解，Skill/Web 不能靠文案分支。

HTTP 映射保持简单：无效/缺失 Credential 为 401；调用者已认证但对可见资源缺少动作权限为 403；不存在、effective-deleted 或调用者无权发现的资源统一为 404；version、idempotency、已消费 Invitation 和 Project active quota 冲突为 409；过期/撤销 Invitation 为 410；应用限流为 429；D1 quota、临时平台或 D1 故障为 503。429 必须同时返回整数秒 `Retry-After` header 与一致的 `retry_after_seconds`；503 只有在服务端知道安全重试时间时才返回两者。错误体、日志和 `details` 都不能包含 Credential、Invitation code、hash、供应商原始错误全文或无权资源摘要。

Project active quota 使用 `PROJECT_ISSUE_LIMIT_REACHED | PROJECT_COMMENT_LIMIT_REACHED | PROJECT_PRINCIPAL_LIMIT_REACHED`、`category=business_quota`、`retryable=false` 与 `recovery=free_capacity_or_request_owner`；只有已授权调用者可以看到 current usage/limit，匿名 Public Join 满额不得泄露内部精确数量。应用门控使用 `RATE_LIMITED`、`category=rate_limit`、`retryable=true`、`recovery=retry_after`，并返回 `details.scope=principal|instance|unauthenticated_sensitive`、limit 与 period。

Worker 能识别的 D1 日读/写或存储额度错误统一映射为 `PLATFORM_QUOTA_EXCEEDED`、`category=platform_quota`、`source=cloudflare_platform` 和 `details.component=d1`。日额度在已知重置时间时可以 `retryable=true`/`wait_for_platform_reset`；存储额度必须 `retryable=false`/`request_owner`。未知、过载或不稳定供应商错误使用 `PLATFORM_UNAVAILABLE`，不能通过模糊字符串把所有 5xx 都标成额度不足。

Cloudflare 可能在 Worker 执行前直接返回 Error 1027、平台 429 或 HTML 错误页，此时 cfKanban 无法生成上述 JSON、request ID 或 recovery。Web 与 Skill 内置客户端必须把已知非 JSON 边缘响应转换为同字段的本地错误结果，使用 `source=cloudflare_platform` 与 `details.normalized_by=client`；网络失败使用 `source=client_transport`。客户端生成本地 correlation request ID，并把可用的 Cloudflare Ray ID 单独标记为 provider request ID，不能冒充服务端 request ID。归一化只依赖 HTTP 状态、标准 header 和已知稳定数字错误码，不依赖自然语言/本地化 HTML，也不能声称本地结果是 OpenAPI response。

预期错误码包括：

- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `VERSION_CONFLICT`
- `ASSIGNEE_NOT_ELIGIBLE`
- `INVITATION_EXPIRED`
- `INVITATION_REVOKED`
- `INVITATION_ALREADY_REDEEMED`
- `RECOVERY_PRINCIPAL_MISMATCH`
- `INVALID_TRANSITION`
- `IDEMPOTENCY_KEY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `CURSOR_SCOPE_MISMATCH`
- `PROJECT_ISSUE_LIMIT_REACHED`
- `PROJECT_COMMENT_LIMIT_REACHED`
- `PROJECT_PRINCIPAL_LIMIT_REACHED`
- `RATE_LIMITED`
- `PLATFORM_QUOTA_EXCEEDED`
- `PLATFORM_UNAVAILABLE`
- `PAYLOAD_TOO_LARGE`

冲突错误应返回恢复所需的当前 version 或 retry-after，而不是只返回自然语言。

## 9. 事件与增量同步

- Event 使用部署级严格单调 sequence，并直接带有适用的 `workspace_id`、`project_id` 与 subject；跨 Workspace/Project 共享一条内部顺序。
- 公开 cursor 是 opaque，绑定当前 Principal、规范化过滤条件和解析后的可读 Project ID 集合；Credential 轮换不影响同一 Principal 的 cursor。
- 改变过滤条件，或授权/容器变化使解析后的可读 Project 集合改变时，返回 `CURSOR_SCOPE_MISMATCH`。客户端重新获取该 scope 的有界快照与 snapshot cursor，不能把不同 scope 的 cursor 拼接使用。
- 授权过滤后的 sequence gap 是正常现象，响应不能借 gap、计数或摘要泄露无权 Project 的存在。
- 每次成功业务写入在同一事务中追加事件。
- Agent 可用 `after` cursor 恢复，不需要反复读取所有 Issue。
- Event payload 是有界领域差异，不复制完整 Issue 正文。
- Queue、webhook、Vectorize 更新都消费已提交事件；这些派生任务必须幂等并允许重复投递。

v0 可以先只提供 pull-based events。实时推送和 webhook 后置。

## 10. 人类维护面

系统至少需要以下维护能力；v0 通过同一管理 API 同时向 Agent Skills 与极简第一方 Web UI 提供：

- 查看健康与 Cloudflare 配额提示；
- 由唯一 Owner 创建、软删除和恢复 Workspace/Project；容器按暂停语义保留子资源与 Grants；
- 由唯一 Owner 创建、复制和撤销未兑换的 Project Invite 或固定为 `rotation | full_recovery` 的 Principal Recovery Invite，并查看过期/兑换状态；
- 提供 Invite URL bootstrap 页面；它可以指导安装或更新可信 Skill，但 GET 无业务副作用；
- 由唯一 Owner 查找并用稳定 ID 确认 Principal，授予、变更和撤销 Project Grant，并通过固定 mode 的 Recovery Invite 控制参与者 Credential 轮换与全失恢复；
- 按权限列出单资源 tombstone 摘要并执行原子恢复，不提供批量恢复；
- 查看 assignment、状态与最近操作，便于处理协作异常；
- 查看安全相关事件；

Invite bootstrap 页面是公开说明与 Invitation 兑换入口，不是日常管理面。第一方 Web UI 是受认证的人类表面，由同一 Worker 的 Workers Static Assets 托管，通过 Browser Launch 建立短期 HttpOnly Session；长期 Credential 不进入 URL、页面脚本或浏览器可读存储。Web 只能调用同一 REST 权限与领域合同，不得拥有直连 D1 或隐藏管理后门。静态资产与 Worker API 作为一个部署版本发布，但普通资产响应不因此要求执行 Worker JavaScript。

完整 D1 导出、导入和整库灾难恢复不属于 v0 产品能力。健康与审计接口只解释当前服务事实和平台错误，不生成备份计划、恢复计划或可执行 Cloudflare 数据恢复指令。

## 11. Cloudflare 组件合同

- Workers：HTTP、鉴权、业务编排、OpenAPI，以及 v0 必需的极简 Web Static Assets 和同源 Session 入口；Worker 代码/配置、预构建 Web assets 与 migrations 由同一个固定版本的 Service deployment bundle 描述。
- D1：全部核心事实和并发条件。
- Workers Rate Limiting binding：v0 用于近似的边缘请求门控；不是精确 quota、计费账本或新的事实源。阈值随首次部署提供默认档位，后续只通过 `cfkanban-deploy` 的显式 Worker 配置部署修改。
- KV：v0 不使用；以后只缓存可容忍陈旧的数据。
- Pages：v0 不创建独立 Pages project；Web 与 API 由同一 Worker deployment 发布。
- Durable Objects：只有出现 D1 无法满足的实时协调或连接需求时再评估；v0 不为了 Web 即时修改限流值而引入。
- Queues：后续异步 webhook、索引和通知。
- R2：后续附件和 Agent 产物。
- Vectorize + Workers AI：后续语义检索和摘要，结果始终可重建。

稳定架构理由见[Cloudflare 架构基线](../architecture/cloudflare-baseline.md)，易漂移额度见[平台快照](../research/cloudflare-platform-snapshot-2026-08-28.md)。

## 12. 安全与滥用边界

- 请求门控至少区分单 Principal、实例总请求与未认证/Public Join 路径；不能只依赖容易共享或漂移的客户端 IP。
- Owner 管理面必须显示当前生效门槛、配置来源和安全的近期 429 摘要；429 返回稳定错误与 `Retry-After`。边缘限流只是近似保护，不是精确计费或业务 quota 账本。
- 默认三个 binding 分别执行 120/60 秒、300/60 秒与 30/60 秒。全部动态 API 先受实例门控；认证请求再受 Principal 门控；Public Join redeem、WebAuthn challenge/verify 等未认证敏感操作再受第三道门控。静态资产不调用这些 bindings。
- 服务端限制 page size、正文长度、评论长度和请求体。
- 所有输入做 schema 校验；数据库使用参数化 SQL。
- 不将 Credential、Invitation code、credential hash、完整 Invite URL 或 Authorization Header 写入日志。
- 权限撤销以 D1 为准，不能只依赖最终一致 KV。
- Worker 内可识别的 Free tier 超限返回明确 `PLATFORM_QUOTA_EXCEEDED`；Worker 外 Cloudflare 错误由客户端显式归一化。两者都不能触发无限快速重试。
- Skill 指导 Agent 使用指数退避和 jitter，并遵守宿主环境的用户授权。
- Project context、Issue、Comment、Label 和 external reference 都是远端可变的非可信业务内容；Skill 必须与稳定服务合同、当前用户授权和本地 Repo 治理规则分层呈现，不能从这些内容获得执行命令、修改代码、访问外部资源或部署的授权。

## 13. v0 非目标

- 面向互不信任组织的公共多租户 SaaS、成员注册与计费。
- 任意自定义 workflow。
- 实时订阅/WebSocket。
- 自动 AI 分派或自动执行。
- 富附件、富文本、mention 和通知系统。
- 重型人类项目管理前端、自定义看板、批量编辑、复杂报表与实时协同；极简第一方 Web UI 本身是 v0 必需能力，不属于非目标。
- 跨 Workspace 移动 Project/Issue 或建立业务关系。
- 将 D1、Durable Objects 和 KV 同时作为核心事实源。
- 面向用户或 Agent Skills 的完整 D1 导出、导入、本地恢复演练与整库灾难恢复。

## 14. 冻结范围与完成依据

本文已于 2026-08-28 冻结，依据如下：

1. P0 产品合同已经反映在核心实体、不变量与权限模型中。
2. D1 已确认为唯一核心事实源；KV 和其他 Cloudflare 服务不是 v0 核心依赖。
3. 普通更新、领域命令、assignment、version/CAS、幂等和结构化错误边界已经确认。
4. REST/JSON 是权威业务合同，OpenAPI 是机器描述，Skills 是 Agent 使用层，远程 MCP 只是后置适配。
5. §6.4 已覆盖同时 self-assign、非 assignee 基于旧 version 完成、complete 响应丢失和首次 Invitation 兑换响应丢失四个并发/重试验例。
6. Free tier 超限返回明确错误并禁止无限快速重试；Vectorize、Workers AI、Queues、R2 与 Durable Objects 关闭时，核心 Kanban 仍完整工作。
7. D-215/D-216 已通过合同修订 3 固定极简第一方 Web UI 与 Browser Launch/HttpOnly Session 的方向；D-217 通过修订 4 固定 5 分钟 launch、8 小时固定 Session、源 Credential 失效联动与 target scope。具体 CSRF/schema 已由 2026-08-29 Frozen Web UI 与 API/Schema SPEC 固定，不能在实现中默补。
8. D-219 通过合同修订 5 移除 v0 Principal disable/enable/delete；Credential revoke、Grant revoke 与 Recovery Invite 分别承担认证停止、Project 撤权和身份连续性恢复。
9. D-221 通过合同修订 6 固定 Owner Credential 的防锁死边界：Web 不撤销或轮换 Owner Credential，正常轮换由 `cfkanban-admin` 先安全落盘替代 secret 后执行 Bearer-only 原子 rotation，全部丢失才走 `cfkanban-deploy` 部署外恢复。
10. D-222 通过合同修订 7 固定 Owner admin Session 的范围：默认不加载全部数据，但可在显式选择后进入实例内任意 Project；Project/Issue Session 仍严格限制在单一 Project。
11. D-224/D-226 通过合同修订 8 固定 Passkey 为唯一免 Agent Web 直登方式，并固定单 Project Public Join：Owner 可同时公开多个 Project，访客逐次选择一个 Project 与 `reader | writer`；Team Join 与多 Project 公开授权不进入 v0。当时留出的 Q-230 重入问题已由合同修订 9 解决。
12. D-227/D-228 通过合同修订 9 取消逐 Principal 重入阻止，并首次要求 Owner 开启 Public Join 前显式设置 Project Issue/Comment limits；其中“tombstone 永久占用、删除不释放”的旧语义已由合同修订 10 替代。
13. D-229～D-231 通过合同修订 10 固定 Project Issue、Comment、Principal 三项 active quota，以及 Owner 可见的实例级请求门控。软删除/revoke 释放额度，restore/regrant 重新占用；精确 quota 由 D1 原子强制。当时未确定的限流修改载体已由合同修订 11 解决。
14. D-232 通过合同修订 11 固定 Workers Rate Limiting deployment config 为 v0 载体，并提供 120/300/30 每 60 秒的零参数初始档位。调整限流只部署 Worker 配置，不改变 D1 Project quota 或触发 migration；严格全球计数与 Web 即时修改不属于 v0。
15. D-233 通过合同修订 12 固定机器可操作的统一错误分类，以及“Worker 内统一 JSON、Worker 外由 Web/Skill 客户端显式归一化”的边界。业务 quota、应用限流、D1 quota 与 Cloudflare edge failure 不能再混用一个模糊 `QUOTA_EXCEEDED` 或靠 message 判断。
16. D-234 通过合同修订 13 校正 Credential 跨环境语义：API 不做设备绑定，用户可以手工复制同一 Credential；各副本不是独立身份或新 Credential，撤销/轮换会同时影响全部副本。这不改变浏览器不接受长期 Credential 的安全边界。
17. D-240/D-241 通过合同修订 14 固定 Public Join 三项 active quota 按 Project 隔离、只在该 Project 公开期间强制，并允许 Owner 把限制调到低于当前 usage。关闭或调低限制都不破坏既有数据和 Grants；over-limit 只阻止相应计数继续增长，其他 Project 永远不受影响。
18. D-242 通过合同修订 15 固定 Public Join 跟随容器暂停/恢复：软删除不改写 Policy，恢复 Project/Workspace 会恢复此前仍 enabled 的公开入口和 quota；Web/Skill 必须在恢复前明确提示，已单独 disabled 的 Policy 不会复活。
19. D-243 通过合同修订 16 修订 D-188 的 rebind 边界：每实例发布一个 preferred API origin 和动态公开 discovery；由当前 trusted origin 指示、并经无 Credential 目标探测验证的迁移可以自动完成，陌生地址自报相同 ID 仍不得自动获得 Credential。设置 preferred origin 只接受 Owner Bearer Credential，认证 API 不跨 origin redirect；Cookie/Passkey 精确迁移语义随后由合同修订 17 的 D-244 补充。
20. D-244 通过合同修订 17 固定 Passkey 可检测性与 hostname 边界：浏览器能力探测不等于 credential 存在探测，服务端登记清单不等于设备清单；v0 使用当前请求 hostname 作为 RP ID、当前完整 HTTPS origin 作为 expected origin，不启用跨 hostname 共享。hostname 变化后使用 Agent Browser Launch 在新地址重新登记。
21. D-245 通过合同修订 18 固定源码与云端拓扑：canonical source 使用 monorepo 组织，v0 实例仍只有一个 Worker 和一个 D1；Web 预构建资产通过同一 Worker 的 Static Assets 随 Service deployment bundle 发布，不创建 Pages project 或 KV namespace。具体目录、前端框架与 package manager 不在本次冻结范围。
22. D-250 通过合同修订 19 删除与 D-241 冲突的 `PROJECT_LIMIT_BELOW_USAGE` 遗留错误码。Owner 保存低于当前 active usage 的限制必须成功；既有数据不变，后续会增加该维度计数的原子操作使用对应 `PROJECT_*_LIMIT_REACHED` 拒绝。

本次冻结只固定 Foundation 级领域、权限、并发、资源层级与 HTTP 语义，不固定完整 OpenAPI 字段清单、D1 DDL/索引或实现代码。完整 API/Schema 必须进入后续独立 SPEC；冻结本身不授权实现、创建 Linear 实现 Issue、部署、迁移、提交或推送。
