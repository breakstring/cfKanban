# cfKanban 产品简报

- 文档状态：Draft
- Roadmap：R0
- Linear：[cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f)
- 最近讨论：2026-08-29

## 一句话定位

cfKanban 是面向 Coding Agents 的轻量工作协调账本：用稳定、低上下文、可恢复的 API，让多个 Agent 能够发现、分配、推进、交接和审计工作。

“没有重型 UI”是克制范围的结果，不等于 Agent-only。用户的 Agent 仍是主要调用载体：cfKanban 用 Skill/API 提供稳定能力和结构化恢复信息，但不接管 Agent 的目标理解、动作组合与汇报策略。同时，v0 提供同一部署实例内的极简第一方 Web UI，让人类直接查看 Kanban、完成低频 Issue 参与和 Owner 维护；Web 复用同一 REST 权限与领域合同，不形成第二套产品。

## 目标用户

### 用户直接使用的 Agent

例如 Codex App/CLI、Claude Code、小龙虾、Workbuddy 或其他能够加载 Skill 并调用 HTTP/脚本的 Agent。它们可以在不同任务中负责部署、Owner 管理、协调或 Coding，但产品不把这些工作模式建模为不同 Agent 类型。

### Deployment Owner

每个部署实例只有一个 Owner，不设置第二管理员，也不支持 Owner transfer。Owner 无需 Project Grant，隐式拥有全部 Project 的数据面读写能力；它仍是部署级身份而不是第三种 Project role。只有 Owner 能创建、软删除和恢复 Workspace/Project，创建短期一次性 Project Invite 或 Principal Recovery Invite，并创建、变更或撤销 Project Grant。参与者不能自行签发额外 Credential。审计属于管理能力；完整 D1 导出与整库恢复不属于 cfKanban 产品能力。Owner 不是日常拖拽看板的主要用户。

### 集成作者

为某个 Agent 编写 Skill、内置 Node scripts 或可选 MCP 适配器的人。他们需要稳定的 REST/OpenAPI 合同和结构化错误，而不是依赖网页 DOM。

## 核心能力与代表性用户任务

以下描述产品需要支持的能力，不规定上层 Agent 必须采用的调用顺序或工作流：

1. 人类把一个可信 bootstrap URL 交给 Agent；Agent 安装或更新 Skills、完成环境探测、部署服务并安全落地 Owner Credential。
2. Agent 发现实例能力、可访问的 Workspace、Project 和允许的动作。
3. 用过滤条件获取少量候选工作，而不是下载整个看板。
4. 查看或设置 Issue 负责人；Agent 可以把未分配工作分配给自己，但这不锁定 Issue。
5. 获取一份有界的 Agent context pack。
6. 报告进度或阻塞，并在需要时重新分配负责人。
7. 在并发冲突、网络超时和运行中断后安全重试或恢复。
8. 完成 Issue，并提交结构化结果、验证和后续事项。
9. 从事件 cursor 增量获知变化，而不是反复全量轮询。
10. 林让自己的 Agent 使用 Owner Credential 调整 Project Grants、发起参与者 Credential 轮换/恢复、处理候选维护操作，并读回 Project 内容、安全与管理历史。
11. 未认证访客直接打开实例时先理解产品并复制可信 Agent 部署话术；既有参与者首次通过 Agent Launch 登记 Passkey 后，可以直接登录 Web。
12. 林的 Agent 生成简短 Invite URL 话术；参与者把它交给自己的 Agent，后者读取页面、安装或更新可信 Skill，并自动复用或创建本地身份后兑换 Project 权限。
13. 人类让 Agent 在 IAB 或普通浏览器中打开明确 Project/Issue；Agent 创建一次性 Browser Launch URL，浏览器兑换短期 Session 后直接展示对应 Kanban。
14. `reader` 直接查看看板与详情，`writer` 进行常用原子 Issue 操作，Owner 通过简洁管理页维护 Workspace/Project、Invite、Grant、Principal/Credential、健康与审计。
15. Owner 可以同时公开多个 Project；访客从首页每次选择一个 Project 和 `reader | writer` 后原子加入，不引入 Team 或多 Project 公开授权。
16. Owner 在外部为 Worker 添加新域名后，通过 Agent 发布一个 preferred API origin；已有 Agent 从当前 trusted origin 获得版本化迁移指示、无凭据验证目标后自动更新本地入口，而陌生地址不能靠自报同一 instance ID 获得信任。

## 产品原则

### 可靠优先于聪明

服务端负责验证状态转换、版本和权限。OpenAPI description 或 Skill 中的自然语言只帮助 Agent 调用，不能代替强制约束。

### 提供能力，不接管 Agent 编排

cfKanban 定义 Issue、Comment、Relation、blocked、assignment、status 和 complete 等动作的稳定合同，但不替上层 Agent 判断何时调用、怎样组合或哪些自然语言代表最终授权。用户、Agent 宿主、Repo 规则或其他编排层决定工作策略；Skill 既说明能力、参数、后果和恢复方式，也提供明确标注、可以被更具体规则覆盖的产品建议。

### Agent Guidance 也是产品能力

上层 Agent 不应只拿到一组裸 API。高频默认、低噪声建议、本地文件约定和安全用法必须进入相关 Skill 的可发现指导：例如用户级状态放在 `.cfkanban/`、Invite 未说明 role 时推荐 `writer`、已知上下文中查询 Issue 强烈推荐 Project filters。服务端强制合同、Skill 推荐指导和上层最终决策必须清楚区分，不能把建议伪装成不可覆盖的权限规则，也不能因为最终决策在上层就删除建议。

### Context-friendly 不等于缩短字段名

保留清晰 JSON 字段，通过分页、过滤、字段视图、最近评论窗口和事件 cursor 控制上下文。首版不同时维护 JSON、YAML、Markdown 三套响应协议。

### 负责人不等于独占权或执行授权

assignee 只表示当前主要负责人。它不阻止其他 Project `writer` 修改、评论、完成或报告阻塞，也不授权负责人修改任意仓库、访问生产环境、发送外部消息、部署或执行其他高副作用操作。

Issue 标题、正文、评论和附件都属于不可信输入，不能覆盖当前用户授权、宿主 Agent 规则或目标仓库的 `AGENTS.md`。

### 身份来自凭据

Agent 名称可以帮助人类理解，但身份和审计主体必须从独立 Credential 推导。调用者自报的 `X-Agent-ID` 或 session 名称不能作为安全身份。

Credential 只回答“调用者是谁”：它认证一个稳定 Principal，不直接编码 Workspace、Project 或角色。授权单独回答“这个身份可以访问什么”。v0 按 Project 显式授权；同一 Principal 可以拥有多个 Project Grants，这些 Project 可以分布在不同 Workspace。轮换 Credential 不应重建这些授权。

Credential 不绑定设备或 Agent 宿主。用户可以自行把同一 Credential 复制到多个受信执行环境；服务端把所有副本视为同一 Credential，撤销或轮换会同时影响全部副本。cfKanban 不为此建立设备实体或额外邀请流程，Skills 也不自动跨环境搬运 secret。

### Project 不等于代码仓库

Project 是工作协调命名空间，不是 Repo 的镜像。系统不强制一 Repo 一 Project：同一 Repo 的工作可以分布在多个 Project，一个 Project 也可以协调多个 Repo。Repo 只作为 Issue、Project 或外部链接中的上下文，不成为身份或授权边界。

### 核心始终可独立运行

Vectorize、Workers AI、Queues、R2、Durable Objects、Cloudflare Access 和远程 MCP 都是可选能力。关闭或超限时，Project、Issue、评论、状态、assignment 和历史仍然可用。

v0 只提供 D1 结构化过滤与基础标题搜索。后期检索增强优先使用 Cloudflare Vectorize 的可重建派生索引；它不能参与权限、唯一约束、CAS 或刚写即读的核心判断。

### 少组件就是能力

MVP 优先 Workers + D1。只有真实需求和验证证据证明收益时，才增加其他 Cloudflare 服务。

## MVP 产品范围

### 核心对象

- 一个部署者控制的部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project。
- 每个部署实例只有一个 Deployment Owner；已确认的专属控制面操作是创建 Workspace/Project、邀请参与者和管理 Project Grants。
- Workspace 是 Project 的上级资源命名空间，但不是 Principal、Credential 或日常业务授权边界。
- Project 具有稳定 key，用于 API scope 和 Repo 推荐范围；它不参与 Issue 引用号。每个部署实例的 Issue 统一使用全局、只增不复用的 `CFK-<正整数>` 标识。
- Issue 包含标题、Markdown 正文、状态、优先级、可空 assignee、版本和时间信息。
- priority 固定为 `none / low / medium / high / urgent` 且默认 `none`；v0 不保存手工 rank，候选按 priority 后 FIFO 稳定排序。
- 每个 Project 使用固定五状态 workflow；Project 可以覆盖显示名称但只有 Owner 能修改。Owner 或 Project `writer` 可带 expected version 在固定状态间任意显式转换和 reopen；status key、category、顺序和 terminal 语义保持稳定。
- Label、Comment，以及 `blocks / parent / related / duplicate` 四类稳定 Issue 关系语义；反向关系由读取投影派生，同一 Workspace 内允许跨 Project，禁止跨 Workspace。
- blocked 不作为额外 workflow status；未完成依赖或人工原因形成统一 `is_blocked` 投影，设置或解除阻塞不自动改变 status。
- Principal、Credential、Project Grant、Event 和 Idempotency Record。
- 一次性 Browser Launch capability 与短期 Web Session；它们只把既有 Principal 权限安全带入浏览器，不建立新身份或新角色。
- 一次性 Invitation：由 Owner 创建；普通类型绑定一个或多个初始 Project Grants，并固定有效 7 天；恢复类型显式绑定既有 Principal，并固定有效 1 小时。两者都支持过期、撤销、原子兑换和审计，v0 不允许自定义或延长时效。

### 核心行为

- Workspace/Project 的创建、读取和必要元数据维护，以及 Issue 的最小 CRUD；容器只能由 Owner 软删除和恢复。
- Issue 列表、过滤、cursor 分页和上下文视图。
- 按当前 Principal 授权过滤的部署级跨 Workspace/Project Issue 聚合读取；Project filter 可省略，但 Agent Skill 在已知上下文时强烈推荐限定一个或多个 Project。
- 部署级增量 Event feed 使用与 Project 过滤一致的授权 scope；cursor 绑定 Principal、过滤条件和实际可读 Project 集合，scope 变化时要求重新获取快照。
- assign、unassign、assign-to-me、complete、report-blocked、clear-blocked；v0 不首发原子 assign-next。
- complete 原子追加结构化 completion comment 并转为 `done`；记录不可修改或删除，reopen 后再次完成会追加新记录。
- 普通更新的乐观锁和命令写入的幂等。
- 非幂等创建/命令强制 Idempotency-Key 并保留 24 小时；结构化错误提供稳定 recovery hint，供 Agent 刷新资源、cursor、认证或请求 Owner 处理。
- 评论与不可变领域事件。
- 普通 Comment 追加后不可原地编辑，可由 writer 软删除/恢复；纠错追加引用旧 Comment 的新记录。completion comment 不可编辑或删除。
- 每个 Agent 独立、可吊销的 Credential，以及 Principal 到多个 Project 的显式 Project Grants。
- Credential 不自动过期，只通过显式撤销、轮换或 full recovery 中的撤销失效；低频 `last_used_at` 仅供 Owner 运维判断。v0 不提供 Principal disable/enable/delete。
- 面向 Agent 的 Invite URL bootstrap：已有该实例 Credential 时复用 Principal，没有时创建 Principal/Credential 并安全保存到本地。
- 非 Owner 的 Project role 只有 `reader` 和 `writer`；只有 Owner 能创建或撤销 Project Grant。
- Project Grant 不设置失效日期；每个 Principal/Project 只有一条当前记录，只有 Owner 能显式变更角色、撤销或重新授予。
- `writer` 可以创建、修改、软删除和恢复 Project 内容，但不能删除或恢复 Workspace/Project 容器。
- OpenAPI、健康检查、能力发现。
- 有界资源合同：请求最大 128 KiB，Issue body 最大 64 KiB，Comment/completion 最大 32 KiB；列表默认 20、最大 100，Agent context 最大 64 KiB 并支持截断续读。
- 同一 Worker 托管的极简第一方 Web UI：Project Kanban、Issue 详情/常用写操作和 Owner 简单维护；全部调用同一 REST API 并执行同一权限、CAS、幂等与审计合同。
- 所有已认证 Principal 都可以通过 `cfkanban` Skill 或 Web“我的资料”查看稳定 principal ID/current display name，并只修改自己的非空 display name；v0 不建立头像、邮箱、简介等完整用户档案。
- Web 公共界面文案至少支持 English 与简体中文，并允许用户切换；稳定 key、默认 workflow 显示名和业务内容不随 UI 语言自动翻译，Skill/API 也不继承该设置。
- Agent 通过固定 5 分钟、一次性的 Browser Launch URL 打开明确 Web target；浏览器兑换固定 8 小时、无滑动续期/refresh、绑定源 Credential 与 target scope 的 HttpOnly Session，不读取本地 Credential，也不要求人类粘贴长期 secret。
- 首次 Agent Launch 后可登记多个 Web-only Passkey；Passkey 登录只签发固定 8 小时 Session，不能调用 Bearer API。浏览器 capability detection 不证明 credential 存在；v0 按精确 hostname/完整 HTTPS origin 隔离，丢失或换 hostname 时仍用 Agent Launch 恢复并登记。
- 单 Project Public Join：Owner 可同时公开多个 Project，访客逐次选择一个 Project 与 `reader | writer`；每次只建立或提升一条 Grant，不提供 Team Join 或公开批量授权。
- Public Join 保持简单重入，不建立逐 Principal blacklist；开启前 Owner 必须显式设置该 Project 独立的 Issue、Comment、非 Owner Principal 三项 active quota。三项限制只在本 Project 的 Public Join 开启期间生效，不形成实例共享池，也不影响其他 Project；关闭不撤销既有 Grants，重新开启须显式重交限制。限制可以低于当前 usage，既有数据不自动改变，只阻止继续增加对应计数的操作。容器软删除只暂停公开，恢复 Project/Workspace 时此前仍 enabled 的 Policy 在明确警告后自动恢复。soft delete/Grant revoke 释放，restore/regrant 重新占用；active quota 不等于物理清除 tombstone。
- 实例请求门控必须对 Owner 可见，首次部署自动提供单 Principal 120/60 秒、实例动态 API 300/60 秒、未认证敏感操作 30/60 秒的默认档位。修改由 deploy Skill 发布 Worker 配置而非 D1 migration；它只做近似抗滥用，不能替代 D1 精确业务 quota。
- Web 与 Agent 共享稳定机器错误分类和恢复动作；Project quota、应用 rate limit、D1 platform quota 与 platform failure 分别表达。Cloudflare 在 Worker 外生成的 1027/429/HTML 由客户端显式归一化并保留来源，不伪装成服务端 JSON。
- 实例公开一个动态、非秘密、`no-store` 的 well-known discovery document，并保存唯一 `preferred_api_origin` 与递增版本。Owner 只能使用 Bearer Credential 修改推荐入口；服务不创建域名、不在认证 API 上跨域 redirect，也不自动迁移 Web Session/Passkey。Agent 只在当前 trusted origin 发布更高版本且无 Credential 目标探测完全一致时自动 rebind。
- portable Skill bundle 按需携带共享 Node.js/TypeScript scripts；宿主安装、发现和刷新差异属于 bundle 的兼容逻辑，不形成独立 Host Adapter 角色或 cfKanban CLI。远程 MCP adapter 后置。

## 明确非目标

- 替代 Linear/Jira 的完整人类项目管理体验。
- 自定义 Board/列/工作流、手工 rank、批量编辑、复杂富文本、仪表盘、实时协同光标。
- Organization、Team、Initiative、Cycle、Roadmap 多级建模。
- 邮箱注册、社交登录、完整账号目录、组织成员与通用 RBAC/邀请平台；Owner 发起的 Project 级邀请仍属于核心。
- 自定义报表、复杂通知、订阅、mention 和自动化市场。
- 面向互不信任组织的公共多租户 SaaS、注册、成员计费和租户生命周期平台。
- 首版语义搜索、自动摘要、自动分派或 AI 决策。
- 完整 D1 导出、导入、本地恢复演练和整库灾难恢复；Cloudflare 平台控制面能力不包装为 cfKanban Skill。
- 把看板凭据当作代码仓、云环境或生产系统授权。

## 人、Agent、Skill 与界面的关系

人类或其他上游系统提出目标，用户的 Agent 是常见调用主体。Skill 是能力说明与可靠调用层；少量内置 Node scripts 只负责需要重复、确定性执行的工作；服务端是权限和领域合同的最终强制层。目标解释、调用时机、动作组合与自主程度属于上层 Agent/宿主/Repo 规则，不是 cfKanban 产品策略。部署、协调、Owner 管理和 Coding 都只是同一个 Agent 的任务模式。

Skill 可携带调用约定、references 和经过验证的 helper，但不能复制第二套领域规则。v0 使用服务端同实例 Web UI 作为人类直接表面，不再把本地只读查看器作为首发要求；Skill 本身也不能替代远程凭据吊销、审计和恢复入口。

邀请页面是轻量 bootstrap 文档入口，不是日常管理 UI。Owner 对外只需复制类似“请阅读此 Invite URL 以加入 Project”的短消息；页面可提供可信 Skill 的安装/更新入口、操作说明和机器可读邀请元数据。页面 GET 不得产生兑换副作用。

已确认的分工：

- Agent Skills：公开日常 Issue、Owner 管理、context pack 渲染、Browser Launch 与错误恢复等能力；确定性操作由 bundle 内 Node scripts 承担，不发布独立 cfKanban CLI，也不替上层 Agent 制定日常工作流。
- Web UI：通过 Agent 创建的一次性 Browser Launch URL 建立短期浏览器 Session；按当前 Principal 权限提供 Project 看板、Issue 轻量参与和 Owner 简单维护，不直接访问 D1。
- Agent Skills bootstrap：从 canonical URL 的 stable pointer 发现 immutable release manifest，由 manifest 分别固定 portable Skill bundle 与 Service deployment bundle、宿主安装规则和兼容关系；任何本地写入前先展示来源、版本、digest、scope 和回滚边界。已安装副本/缓存不是版本真相，repo clone 只用于明确的源码试验。
- 发行信任：首次安装信任官方 canonical HTTPS；不可覆盖的版本清单逐工件固定允许来源与 SHA-256 文件指纹，本地 receipt 用于后续来源连续性校验。marketplace/plugin 不能改写官方来源，安装、更新和降级不得自动执行。v0 明确不解决官方发布系统整体失陷，独立数字签名按公共分发或自动更新需求后置。
- 首次部署默认无需 Cloudflare 资源参数表：在单一 Cloudflare account/profile 和 strict-zero 前提下，Agent 自动生成完整候选计划与安全/确定性参数；缺少 Owner display name 时只询问这一项身份信息，只有会改变账户、费用、域名、数据地域/合规或 release 来源的偏差才再询问，用户通过一次计划授权接受最终值。
- Worker Invite bootstrap：只提供邀请说明和 Invitation 兑换入口；它与受认证的日常 Web/Owner 管理面职责分开。
- REST API：两者共同依赖的唯一业务合同。

## 成功标准

产品达到 v0 可用，不以页面数量衡量，而以以下行为衡量：

- assignment 不形成写锁；负责人之外的 `writer` 仍能正常协作。
- 超时重试不会产生重复评论、重复完成或重复事件。
- 两个 Agent 基于同一 version 并发更新时，不会发生静默覆盖；冲突方能读取新版本后重新判断。
- Agent 在丢失本地上下文后能通过 Issue、assignee 和 event cursor 恢复。
- 常见工作循环无需下载完整项目数据。
- 吊销一个 Agent 凭据不影响其他 Agent。
- 新建 Project 不会自动向已有 Principal 开放；撤销一个 Project Grant 不影响该 Principal 的其他 Project。
- 非 Owner 无法邀请其他参与者或改变任何 Project Grant。
- Invite URL 被预览或重复读取不会消费邀请；只有显式兑换 POST 才能创建或复用身份并写入 Grants。
- 同一实例已有有效本地 Credential 时，接受新邀请不会创建重复 Principal；首次兑换响应丢失也不会丢失本地 Credential secret 或重复授权。
- reader 或无权 Principal 不能成为 assignee；负责人资格失效后不会静默清空责任历史或改变 status，并可通过 `needs_reassignment` 被重新发现。
- 普通 Project Invite 无法在缺少有效旧 Credential 时接管既有 Principal；Recovery Invite 身份不匹配时不消费邀请，也不创建 Credential。
- Recovery Invite 创建时固定不可互换的 `rotation | full_recovery` mode：前者要求旧 Credential 证明并只撤销该凭据，后者以一小时 Bearer Invite 授权并撤销全部先前 Credential。
- 有恢复权限的 Agent 可以按稳定标识或 `deleted=only` tombstone 视图定位误删资源；恢复始终是单资源原子操作，不存在批量恢复或隐藏时间窗的“最近删除”端点。
- Cloudflare 免费可选服务超限时，核心看板仍能明确失败或继续降级运行。

## 当前实施入口

[Foundation SPEC](../specs/2026-08-26-agent-native-kanban-foundation-spec.md) 当前为合同修订 19，[Agent Skills & Bootstrap SPEC](../specs/2026-08-28-agent-skills-bootstrap-spec.md) 为修订 24；[API & D1 Schema SPEC](../specs/2026-08-28-api-schema-spec.md)、[Web UI SPEC](../specs/2026-08-29-web-ui-spec.md) 与根目录 `DESIGN.md` 已于 2026-08-29 冻结。实现范围、依赖、验收和停止条件进入 [v0 Implementation Plan](../plans/2026-08-29-v0-implementation-plan.md)，动态状态进入 Linear `v0 可部署闭环` Milestone。monorepo、同 Worker Static Assets、无 Pages/KV、Passkey、preferred origin、Public Join、Project quota、Browser Launch/Session、Credential 恢复、限流和错误归一化合同继续有效；实现、部署和远端 migration 仍按各自授权推进。
