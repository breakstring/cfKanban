# cfKanban 产品简报

- 文档状态：Draft
- Roadmap：R0
- Linear：[cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f)
- 最近讨论：2026-08-28

## 一句话定位

cfKanban 是面向 Coding Agents 的轻量工作协调账本：用稳定、低上下文、可恢复的 API，让多个 Agent 能够发现、分配、推进、交接和审计工作。

“没有重型 UI”是结果，不是产品定义。真正的 Agent-native 还意味着用户的 Agent 是常见调用载体：cfKanban 用 Skill/API 提供稳定能力和结构化恢复信息，但不接管 Agent 的目标理解、动作组合与汇报策略。可靠的身份、并发、幂等、上下文裁剪和错误恢复共同支撑这条体验。

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
11. 林的 Agent 生成简短 Invite URL 话术；参与者把它交给自己的 Agent，后者读取页面、安装或更新可信 Skill，并自动复用或创建本地身份后兑换 Project 权限。

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
- Credential 不自动过期，只通过显式撤销、轮换或 Principal disable 失效；低频 `last_used_at` 仅供 Owner 运维判断。
- 面向 Agent 的 Invite URL bootstrap：已有该实例 Credential 时复用 Principal，没有时创建 Principal/Credential 并安全保存到本地。
- 非 Owner 的 Project role 只有 `reader` 和 `writer`；只有 Owner 能创建或撤销 Project Grant。
- Project Grant 不设置失效日期；每个 Principal/Project 只有一条当前记录，只有 Owner 能显式变更角色、撤销或重新授予。
- `writer` 可以创建、修改、软删除和恢复 Project 内容，但不能删除或恢复 Workspace/Project 容器。
- OpenAPI、健康检查、能力发现。
- 有界资源合同：请求最大 128 KiB，Issue body 最大 64 KiB，Comment/completion 最大 32 KiB；列表默认 20、最大 100，Agent context 最大 64 KiB 并支持截断续读。
- 管理 API + Agent Skills；不要求首发部署端人类维护网页，Invite bootstrap 页面除外。
- portable Skill bundle 按需携带共享 Node.js/TypeScript scripts；宿主安装、发现和刷新差异属于 bundle 的兼容逻辑，不形成独立 Host Adapter 角色或 cfKanban CLI。远程 MCP adapter 后置。

## 明确非目标

- 替代 Linear/Jira 的人类项目管理体验。
- 重型拖拽 Board、富文本编辑器、实时协同光标。
- Organization、Team、Initiative、Cycle、Roadmap 多级建模。
- 邮箱注册、社交登录、完整账号目录、组织成员与通用 RBAC/邀请平台；Owner 发起的 Project 级邀请仍属于核心。
- 自定义报表、复杂通知、订阅、mention 和自动化市场。
- 面向互不信任组织的公共多租户 SaaS、注册、成员计费和租户生命周期平台。
- 首版语义搜索、自动摘要、自动分派或 AI 决策。
- 完整 D1 导出、导入、本地恢复演练和整库灾难恢复；Cloudflare 平台控制面能力不包装为 cfKanban Skill。
- 把看板凭据当作代码仓、云环境或生产系统授权。

## 人、Agent、Skill 与界面的关系

人类或其他上游系统提出目标，用户的 Agent 是常见调用主体。Skill 是能力说明与可靠调用层；少量内置 Node scripts 只负责需要重复、确定性执行的工作；服务端是权限和领域合同的最终强制层。目标解释、调用时机、动作组合与自主程度属于上层 Agent/宿主/Repo 规则，不是 cfKanban 产品策略。部署、协调、Owner 管理和 Coding 都只是同一个 Agent 的任务模式。

Skill 可携带调用约定、references、经过验证的 helper 和一个本地只读查看器，但不能复制第二套领域规则。Skill 本身不是云端管理面，也不能替代远程凭据吊销、审计和恢复入口。

邀请页面是轻量 bootstrap 文档入口，不是日常管理 UI。Owner 对外只需复制类似“请阅读此 Invite URL 以加入 Project”的短消息；页面可提供可信 Skill 的安装/更新入口、操作说明和机器可读邀请元数据。页面 GET 不得产生兑换副作用。

已确认的分工：

- Agent Skills：公开日常 Issue、Owner 管理、context pack 渲染、错误恢复和可选本地只读 HTML 视图等能力；确定性操作由 bundle 内 Node scripts 承担，不发布独立 cfKanban CLI，也不替上层 Agent 制定日常工作流。
- Agent Skills bootstrap：从 canonical URL 的 stable pointer 发现 immutable release manifest，由 manifest 分别固定 portable Skill bundle 与 Service deployment bundle、宿主安装规则和兼容关系；任何本地写入前先展示来源、版本、digest、scope 和回滚边界。已安装副本/缓存不是版本真相，repo clone 只用于明确的源码试验。
- 发行信任：首次安装信任官方 canonical HTTPS；不可覆盖的版本清单逐工件固定允许来源与 SHA-256 文件指纹，本地 receipt 用于后续来源连续性校验。marketplace/plugin 不能改写官方来源，安装、更新和降级不得自动执行。v0 明确不解决官方发布系统整体失陷，独立数字签名按公共分发或自动更新需求后置。
- 首次部署默认无需参数表：在单一 Cloudflare account/profile 和 strict-zero 前提下，Agent 自动生成完整候选计划与安全/确定性参数；只有会改变账户、费用、域名、数据地域/合规或 release 来源的偏差才询问，用户通过一次计划授权接受最终值。
- Worker Invite bootstrap：只提供邀请说明和兑换入口；可动态响应或使用 Static Assets，但不是远程管理页。
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

## 当前产品讨论入口

Foundation SPEC 与 [Agent Skills & Bootstrap SPEC](../specs/2026-08-28-agent-skills-bootstrap-spec.md) 暂不冻结。下一步按 [Agent-first Storyboard](user-storyboard.md) 用具体场景逐卡验收 URL bootstrap、首次部署、Workspace/Project、邀请与身份复用、Issue 原子能力、跨 Project 读取和恢复运维；场景不定义上层 Agent 工作流。服务端结论回写 Foundation，宿主、Skills/Node scripts 与部署体验结论回写 Agent Skills SPEC。
