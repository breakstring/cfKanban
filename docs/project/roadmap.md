# cfKanban Roadmap

- 文档状态：Draft
- 方向真相：本文件
- 执行真相：[Linear cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f)
- 最近讨论：2026-08-29

## 当前基线

- 产品定位为面向 Coding Agents 的轻量工作协调账本。
- 已明确用户的 Agent 是主要调用载体，但不是唯一界面；人类也可以在极简第一方 Web 中直接查看、轻量参与和维护。部署、Owner 管理、协调和 Coding 只是 Agent 的任务模式，不是不同 Agent 类型。
- 当前已有 Frozen 产品/技术合同、可执行 OpenAPI/D1 验证原型和实施计划，但仍没有业务代码。
- Linear 项目已于 2026-08-29 在线读回，状态为 Planned；已建立 `v0 可部署闭环` Milestone 和 11 个 Backlog Work Packages，均未分配、未排期、未开始。
- 已确认一个部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project。
- 已确认 Credential 只认证 Principal；v0 业务权限按 Project 显式授予，不从 Workspace 继承。
- 已确认每个部署实例只有一个 Owner；只有 Owner 能创建 Workspace/Project 和管理 Project Grants，参与者只有 reader/writer。
- 已确认 Owner 无需 Project Grant，隐式拥有全部 Project 数据面读写能力，并单独审计。
- 已确认不设置第二管理员、不支持 Owner transfer；Credential 轮换或恢复只能继续绑定同一 Owner Principal。
- 已确认首次部署使用一次性 Owner bootstrap Credential；全部丢失时仅允许部署控制者通过部署外受控 Skill 脚本为同一 Principal 重新签发。
- 已确认 `writer` 可以软删除和恢复 Project 内容，Workspace/Project 容器只能由 Owner 软删除和恢复。
- 已确认容器软删除采用暂停语义：保留子资源和 Grants、暂停访问，恢复后仍有效的 Grants 自动恢复。
- 已确认 Issue assignee 只表示负责人，不形成独占执行权；v0 不采用 lease，普通并发写用 version/CAS 防止静默覆盖。
- 已确认 blocked 与 status 正交，通过依赖或人工原因形成统一 `is_blocked` 投影，不自动改变工作阶段。
- 已确认参与者由 Owner 创建的短期一次性 Invite URL bootstrap；Agent 复用本地身份或创建 Principal/Credential 后原子兑换 Project Grants。
- 已确认普通 Project Invite 固定有效 7 天，Principal Recovery Invite 固定有效 1 小时；v0 不支持自定义或延长，过期后由 Owner 重新创建。
- 已确认 v0 固定五个 workflow status key/category/order/terminal 语义，Project 只可覆盖显示名称。
- 已确认 assignee 只能是 Owner 或目标 Project 的有效 writer；资格失效后保留引用并投影为待重新分配。
- 已确认普通 Project Invite 与 Principal Recovery Invite 严格分离；参与者 Credential 轮换/全失恢复由 Owner 发起，Recovery Invite 创建时按稳定 principal ID 固定不可互换的 `rotation | full_recovery` mode，参与者不能自行签发额外 Credential。
- 已确认 v0 产品、API 与 Skills 不提供完整 D1 导出、导入、本地恢复演练或整库灾难恢复；Cloudflare 原生控制面运维属于部署者直接管理的外部能力。
- 已确认首发固定三个工作场景 Skill：无后缀 `cfkanban` 是默认日常入口，`cfkanban-admin` 是 Owner 应用管理入口，`cfkanban-deploy` 是 Cloudflare 控制面入口；它们不是三种 Agent 角色。
- 已确认 immutable release manifest 是具体版本真相源，分别固定 Skill bundle 与 Service deployment bundle；stable pointer 只用于发现，已安装 Skill/缓存只是验证副本，repo clone 不作为普通 stable 部署来源。
- 已确认 v0 发行信任采用“官方 canonical HTTPS + 不可覆盖版本清单 + SHA-256 文件指纹 + 来源连续性”；marketplace/plugin 不覆盖官方来源，安装、更新和降级均需明确授权。该方案不防官方发布系统整体失陷，独立签名体系按公共分发或自动更新需求后置。
- 已确认首次部署默认零参数生成 strict-zero 计划：Agent 自动解析 stable 版本、提议无冲突资源名并生成安全/确定性参数；缺少 Owner display name 时只询问这一项身份信息，只有 account 歧义或 custom domain、付费、数据地域/合规、非 stable/源码试验等结果性偏差才再询问，用户最终一次授权完整 plan。
- 已确认 status 显示名称仅 Owner 可修改；Owner 或 Project writer 可带 expected version 在固定状态间任意显式转换和 reopen，terminal 不表示不可逆。
- 已确认完成结果使用结构化、不可变且不可删除的 completion comment；complete 原子追加记录并转为 done，reopen 后再次完成会追加新记录。
- 已确认 Issue Relation 支持 blocks、parent、related、duplicate 四类语义，允许同一 Workspace 内跨 Project、禁止跨 Workspace；跨 Project 写入要求同时拥有两端 writer。
- 已确认 v0 不首发 assign-next，也不发布独立 cfKanban CLI。v0 必须提供同一 Worker 托管的极简第一方 Web UI，服务 Owner 简单维护和参与者直接 Kanban 查看/轻量参与。
- 已确认 canonical source 使用 monorepo 组织 Web、Worker/API、contracts、migrations、三个 Skills 与文档；v0 云端仍只有一个 Worker + 一个 D1。预构建 Web assets 随 Service deployment bundle 通过同一 Worker 的 Workers Static Assets 发布，不创建 Pages project 或 KV namespace；Web 已选择 Vue 3 + TypeScript + Vite，具体目录、package manager 与配套依赖留给实现阶段。
- 已确认浏览器不读取或接收本地长期 Credential；用户的 Agent 创建短期一次性 Browser Launch URL，浏览器兑换 HttpOnly Session 后按同一 Principal/Project 权限访问。
- 已确认首次 Agent Launch 后可登记 Passkey，作为 v0 唯一免 Agent Web 直登方式；浏览器能力探测不等于 credential 存在，v0 按精确 hostname 隔离 Passkey。Owner 可以同时公开多个 Project，访客逐次选择一个 Project 与 `reader | writer` 原子加入，Team Join 不进入 v0。
- 已确认 Public Join 不建立逐 Principal 重入 blacklist；开启前 Owner 必须显式设置该 Project 独立的 Issue、Comment、非 Owner Principal 三项 active quota。三项限制只在本 Project 公开期间生效，不与其他 Project 共享；关闭后停止强制但保留既有 Grants。限制允许低于当前 usage，既有资源不自动改变，只阻止继续增长。容器软删除只暂停公开，恢复 Project/Workspace 时此前仍 enabled 的 Policy 在明确警告后自动恢复。soft delete/Grant revoke 释放，restore/regrant 重新占用；active quota 不声称清除 D1 tombstone。
- 已确认实例请求门控使用原生 Workers Rate Limiting 部署配置：首次部署自动提供单 Principal 120/60 秒、实例动态 API 300/60 秒、未认证敏感操作 30/60 秒；Owner Web 只读展示，修改由 deploy Skill 发布配置且不运行 D1 migration，不引入 Durable Object。
- 已确认 Web/Agent 使用统一机器错误分类；Worker 内返回统一 JSON，D1 quota 安全映射，Cloudflare edge 1027/429/HTML 则由客户端显式归一化并保留来源。
- 已确认实例只发布一个 Owner 推荐的 preferred API origin，并动态提供公开、非秘密、`no-store` 的 well-known discovery。已有 Agent 只在当前 trusted origin 发布更高版本且无 Credential 目标探测一致时自动 rebind；陌生或已失联 origin 仍需用户显式确认。域名绑定继续由 Cloudflare/第三方控制面负责；Web Session 按 origin 隔离，v0 Passkey 按精确 hostname 隔离。
- 已确认 v0 提供部署级授权过滤的跨 Workspace/Project Issue 聚合读取；Project filter 可省略，但 Skill 在已知上下文时强烈推荐限定一个或多个明确 Project。
- 已确认 Project Grant 不设置失效日期；每个 Principal/Project 只有一条当前记录，由 Owner 显式变更角色、撤销或重新授予；普通邀请不改写已有有效 Grant。
- 已确认 Event 使用部署级单调 sequence，opaque cursor 绑定 Principal、过滤与可读 Project 集合；scope 变化要求重新获取快照。
- 已确认 priority 固定五档且默认 none，v0 不保存手工 rank；候选按 priority 后 FIFO 稳定排序。
- 已确认非幂等创建/命令强制 Idempotency-Key 并保留 24 小时；结构化错误提供 retryable 与 recovery hint。
- 已确认普通 Comment 不可原地编辑，可软删除/恢复；纠错追加引用旧 Comment 的新记录，completion comment 不可删除。
- 已确认保留显式 assign-to-me 命令，由服务端推导当前 Principal，且不产生 lease。
- 已确认 Credential 不自动过期，只通过显式撤销、轮换或 full recovery 中的撤销失效；last_used_at 仅作低频运维提示。v0 不提供 Principal disable/enable/delete。
- 已确认 Credential 不做设备绑定；用户可以手工把同一 Credential 复制到多个受信执行环境，所有副本共享身份、审计、撤销和轮换后果；Skill 不自动搬运，v0 不增加设备 Invite/API。
- 已确认小而明确的应用级资源上限：请求 128 KiB、Issue body 64 KiB、Comment/completion 32 KiB、列表默认 20/最大 100、context 64 KiB。
- 已确认源码/发行工程采用锁文件约束的根级验证/构建入口，以及包含顺序、checksum、分类、重入边界和预期 schema artifacts 的 D1 migration manifest；deploy Skill 以 ledger + 实际 schema 双重 readback，不把文件名或退出码当成应用完成。
- 已确认 v0 不提供持有 Cloudflare Token 的 GitHub Actions 部署路径，继续由用户的 Agent 通过 `cfkanban-deploy` 完成唯一主部署流程。无 Cloudflare 凭据的 CI 验证 workflow 可以作为正常工程设施；远端部署 workflow 后置到下一阶段重新冻结授权与恢复体验。
- Foundation、Agent Skills & Bootstrap、API/Schema、Web UI 与 `DESIGN.md` 均已冻结为 v0 实现基线；Foundation 当前为修订 19，Agent Skills & Bootstrap 为修订 20。冻结不表示实现已经开始或完成。
- 已确认 SB-01：canonical 官网 bootstrap document 把 stable pointer 解析到 immutable release manifest，由 manifest 分别固定 Skill bundle 与 Service deployment bundle；manifest 逐工件限制来源并记录 SHA-256 文件指纹，本地更新校验来源连续性。marketplace/plugin 只作便捷入口，宿主差异由安装规则和 Skill 内置 scripts 吸收，不建 Host Adapter 角色。
- 已确认 SB-02 环境准备和 SB-03 首次部署：strict-zero 默认每实例一个 Worker + 一个 D1、先使用 `workers.dev`，同名资源只有本地/远端 marker 一致时才恢复。更新拆成 SB-03A 本地 Skill update 与 SB-03B 云端 Instance upgrade；前者采用 immutable bundle/原子切换，后者采用固定目标、兼容矩阵、逐条 migration journal 和可验证 restore point，且 deploy Skill 不执行 D1 restore。SB-04～SB-24 已按三层边界复核：Service/安全脚本强制 MUST，Skills 提供可覆盖 SHOULD，上层最终 DECIDES。cfKanban 保持原子合同，同时通过相关 `SKILL.md` 告知本地状态位置、Invite 未指定 role 时推荐 writer、已知上下文中强烈推荐 Project filters、幂等/readback 组合范式、Recovery Invite 固定 mode 与 `deleted=only` tombstone 入口。D-213 已取消原 SB-24 的完整导出/整库恢复产品能力；Storyboard 已完成一轮。
- [API & D1 Schema SPEC](../specs/2026-08-28-api-schema-spec.md) 与 [Web UI SPEC](../specs/2026-08-29-web-ui-spec.md) 已于 2026-08-29 冻结；91 个 OpenAPI operations、25 张 D1 表、28 个索引、关键原子操作和 Web 安全骨架已通过本地验证。
- 已形成 [v0 Implementation Plan](../plans/2026-08-29-v0-implementation-plan.md)，按 WP-01～WP-11 从工程骨架推进到 release candidate；推荐 MVP 持久技术主干仍是 Workers + D1，其他 Cloudflare 数据服务不成为核心依赖。

## 方向

### R0 产品边界与基础合同

状态：Frozen

目标：

- 冻结 Agent-native 的定义、产品范围和非目标。
- 冻结唯一 Owner、Principal、Credential、Project Grant 与软删除合同。
- 冻结剩余事件语义和 API 边界。
- 冻结 REST/OpenAPI/Skill/MCP 的分层关系。
- 用 Agent-first Storyboard 走通人类意图、Agent 执行和关键授权边界。
- 形成可实现、可验证的 Foundation SPEC 与 Agent Skills & Bootstrap SPEC。

R0 及全部 v0 实现前合同已完成冻结。实施 PLAN 和 Linear Work Packages 已建立；业务代码仍需用户明确开始实施。

### R1 核心工作账本

状态：Planned

目标：

- Workers API、D1 schema、Browser Launch/Web Session 安全基础。
- Workspace、Project、Issue、固定 workflow、priority、label、comment、dependency。
- 独立 Agent Credential、Principal、Project Grant、一次性 Invitation 与最小角色。
- OpenAPI、健康检查、结构化错误和基础管理命令。

边界：包含极简第一方 Web UI 所需的会话与读取/原子写能力；不含向量、AI、附件、通知、实时推送和重型 UI。

### R2 多 Agent 可靠协作

状态：Planned

目标：

- assign/unassign/assign-to-me。
- expected version、CAS、idempotency。
- 基于明确排序的候选工作读取；v0 使用显式 assign/assign-to-me，不提供原子 assign-next。
- completion/report-blocked/clear-blocked 命令。
- append-only Event 与 cursor 增量恢复。

R1/R2 是否拆成两个交付阶段，要在 Foundation SPEC 冻结后根据最小垂直切片重新评估；当前编号只表达方向，不表达必须串行。

### R3 Agent 集成、极简 Web UI 与分发

状态：Planned

目标：

- portable Skill bundle、共享 Node.js/TypeScript modules/scripts 与可复用 API schema。
- 锁文件约束的根级验证/构建入口，以及不持有 Cloudflare 凭据、不产生远端写入的 CI verification workflow。
- Codex、Claude Code、小龙虾、Workbuddy 等用户 Agent 的宿主兼容规则，处理安装、发现、刷新和权限差异，但不形成独立 adapter 角色。
- canonical URL bootstrap 文档、immutable release 与可信 Skill 安装/更新指引。
- preferred origin 的 Owner 发布、动态实例发现、Cloudflare-native domain reconcile 与可信旧 origin 驱动的安全本地 rebind。
- macOS、Windows、Linux 的 capability detection、Wrangler 登录/部署和 credential storage 验证。
- context pack 渲染和错误恢复 playbook。
- 同一 Worker Static Assets 承载的固定五列 Project Board、Issue 详情/常用原子写入和 Owner 简单维护页。
- Agent 创建一次性 Browser Launch URL，在 Codex IAB 或普通浏览器中打开明确 Project/Issue；不依赖宿主专有接口。
- 在真实 Agent 上验证 discover → list → assign → complete 工作循环。
- 根据实际需求决定是否提供远程 MCP 适配。

### R4 运维、安全与恢复

状态：Planned

目标：

- Credential 轮换/吊销。
- 普通 Project Invite 与高风险 Principal Recovery Invite 的运维、告警和审计。
- assignment、状态与审计异常检查。
- 健康、审计、配额提示和平台错误解释；不提供完整 D1 导出、导入或整库恢复能力。
- Web Session 过期、来源 Credential 撤销、Grant 变化和 CSRF 的安全验证。
- 免费层超限与降级行为验证。
- 在 Agent-first 部署路径经过真实使用验证后，评估可选的 GitHub Actions 远端部署 profile；另行设计最小权限 Token/GitHub Secrets、人工审批、串行 concurrency、migration 中断和恢复，且必须复用同一 deployment bundle、plan、journal、marker 与 readback。

安全和恢复合同必须在 R1/R2 设计中提前考虑；R4 表示产品化收口，不表示此前可以忽略。

### R5 可选 Cloudflare 增强

状态：Deferred

候选能力：

- 以 Vectorize 可重建派生索引为主要方向的后期检索增强，以及可选的相似 Issue、摘要和标签建议。
- Queues + webhook/通知/异步索引。
- R2 附件和 Agent 产物。
- Durable Objects 实时协调或连接。
- Cloudflare Access 组织部署 profile。

这些能力必须可关闭、可重建、可降级，且不能成为核心状态或权限真相。

### R6 托管化与生态

状态：Deferred

可能包括面向互不信任组织的公共多租户 SaaS、成员与计费、公共集成市场、跨 Workspace 搜索。当前没有足够产品证据，不进入 v0/v1 承诺。

## 推荐顺序

1. 用户明确开始实现后，从 [KENN-318 / WP-01](https://linear.app/kennzhang/issue/KENN-318) 建立工程骨架和根级验证，不先铺设空业务 handler。
2. 按 Implementation Plan 的依赖图推进 Worker/D1、领域能力、Web 安全与 Skills；每个 WP 以验收证据更新 Linear。
3. Web、Skills 和最终 release candidate 复用同一 Frozen API/migration/release 合同，不建立第二套事实源或部署路径。
4. 只有真实 Agent、IAB/浏览器、OS、并发与 Free profile 证据出现后，才决定 R5 的可选 Cloudflare 增强投入。

## 明确暂缓

- 为了看起来完整而照搬 Linear 全部概念。
- 把 Roadmap 逐条复制成 Linear backlog。
- 在 v0 或没有对应版本的已冻结设计前引入 KV、DO、Queues、R2、Vectorize 和 AI。
- 在没有明确开始对应 WP、也没有重读 Frozen 合同前做 UI、服务或部署实现。
- 在下一阶段合同冻结前引入持有 Cloudflare Token、由 push 或 workflow_dispatch 执行远端写入的 GitHub Actions 部署 workflow。
