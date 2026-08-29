# Cloudflare 架构基线

- 文档状态：Draft
- 适用范围：cfKanban v0 候选架构
- 事实快照：[2026-08-28 Cloudflare 平台快照](../research/cloudflare-platform-snapshot-2026-08-28.md)
- 外部工程参考：[2026-08-29 Edgechat 架构与部署工程快照](../research/edgechat-architecture-snapshot-2026-08-29.md)

## 1. 结论

v0 推荐只把 Workers 和 D1 设为必要持久运行组件：

- Workers 提供 REST API、OpenAPI、鉴权、业务校验、Invite bootstrap，以及同实例极简 Web UI 与 Browser Launch/Session 入口。
- D1 是实例 preferred origin 设置、Workspace、Project、Project Usage、Issue（含 assignment）、Principal、Credential、Project Grant、Invitation、Public Join Policy、Browser Launch、Web Authenticator、Web Session、Comment、Event 等核心事实的唯一权威来源。

KV、Durable Objects、Queues、R2、Vectorize 和 Workers AI 都不应为了“充分利用 Cloudflare”而提前加入。

Workers Rate Limiting binding 可以作为 Worker 的近似边缘请求门控，不成为事实源或额外持久数据服务。精确的 Issue/Comment/Principal active quota 仍由 D1 原子强制。

### 源码、发行包与云端资源是三个层级

- canonical source 采用 monorepo，逻辑上容纳 Web、Worker/API、公共 contracts、D1 migrations、三个 Skills 与文档；Web 已按 D-248 选择 Vue 3 + TypeScript + Vite，具体目录、package manager 与配套测试/状态管理依赖在实现阶段确定。
- stable Service deployment bundle 固定 Worker 代码/配置、预构建 Web assets、D1 migrations 与兼容元数据。普通部署消费 bundle，不在部署者机器上重新选择依赖或现场构建 Web。
- 云端实例仍只创建一个 Worker 和一个 D1。Web 由该 Worker 的 Workers Static Assets 发布，与 API 同 origin、同 deployment version；v0 不创建 Pages project 或 KV namespace。
- 源码开发和 CI 可以使用 lockfile 中的 repo-local Wrangler。它与普通部署者由 `cfkanban-deploy` 管理、独立于任意业务 Repo 的用户级 Tool Runtime 是两个场景，不能互相推导安装位置。

### 可重现构建与 migration 证据

- monorepo 必须提供锁文件约束下的根级验证/构建入口，一次确定性生成 Worker 与预构建 Web assets；具体 package manager、脚本名和 workspace 机制在实现阶段确定。
- D1 migrations 由 bundle 内的有序 manifest 描述，而不是在运行时按目录名称猜测顺序。每条记录固定稳定 ID、内容 digest、兼容/破坏性分类、重入边界与预期 schema artifacts。
- migration 完成需要 ledger 与实际 D1 schema 双重 readback；checksum 漂移、部分 artifacts 或未知 baseline 必须停止并形成 repair plan。命令退出成功不能单独构成完成证据。
- checksum 规范化必须跨目标操作系统稳定，避免 CRLF/LF 等非语义差异制造错误 migration 漂移。
- 无 Cloudflare 凭据、无远端写入的 CI workflow 可以复用根级入口做验证。持有 Cloudflare Token 并执行部署的 GitHub Actions workflow 不属于 v0；下一阶段如引入，必须复用 `cfkanban-deploy` 的 plan、journal、marker 与 readback，不能形成第二套部署合同。

## 2. 逻辑结构

```text
User's Agent -- Agent Skills / Node scripts --> Cloudflare Worker
Human Browser / IAB -- one-time launch / HttpOnly session --> Cloudflare Worker
    |-- REST + JSON + OpenAPI
    |-- authentication / authorization
    |-- validation / idempotency / commands
    |-- approximate rate gates (Workers Rate Limiting binding)
    |-- Invite bootstrap document
    |-- minimal Web static assets
    |
    +--> D1  [authoritative state]

Optional derived paths:
    committed Event --> Queue --> webhook / Vectorize / Workers AI
    attachment metadata --> R2 object
    real-time coordination --> Durable Object (only if later proven necessary)
```

## 3. 请求路径

### 读请求

1. Worker 验证 Bearer Credential，并只从凭据推导 Principal。
2. Worker 判断 Principal 是否为唯一 Deployment Owner；Owner 使用控制面能力，其他参与者根据请求的 Workspace/Project 和 D1 中的 Project Grant 计算 `reader | writer` 权限。
3. D1 使用覆盖常见过滤条件的索引返回有界结果。
4. Worker 返回 opaque cursor、version、truncated 和 allowed actions。

MVP 不启用 D1 read replication，可以减少一致性分支。若以后启用，必须为需要 read-your-own-writes 的 Agent 链路使用 Sessions API/bookmark。

### 普通写请求

1. 验证 Credential、schema、expected version 和权限。
2. 检查 Idempotency-Key 是否已处理。
3. 用条件 UPDATE 完成 CAS。
4. 在同一事务/batch 中追加领域 Event 和幂等结果。
5. 返回新 version、event cursor 和 request ID。

授权检查使用 D1 中当前有效的 Principal/Project Grant，不能依赖长时间缓存。授权校验与业务写必须形成明确的同一一致性顺序：撤销先提交则后续写失败，业务写先提交则留下当时的授权依据和审计事实。

非天然幂等的创建与命令 POST 缺少 `Idempotency-Key` 时直接拒绝；幂等记录保留 24 小时。服务端先完成当前 Credential 与授权判断，再按 Principal、endpoint、完整资源 scope、key 和请求指纹决定重放或返回冲突，不能让旧响应绕过撤权。

Project Grant 在 D1 中对 `(principal_id, project_id)` 建唯一约束，不带 expiry。角色变更、撤销和重新授予更新同一行的 role/revocation/version，并追加 Audit/Event；普通 Project Invite 遇到未撤销 Grant 时不改写它，遇到已撤销 Grant 时才按邀请 role 重新授予。

### 命令写请求

assign-to-me、report-blocked、clear-blocked、complete 等命令可能同时影响 Issue、Relation、Comment 和 Event，必须作为一个业务原子单元。

不把“先 GET、再由应用判断、最后无条件 UPDATE”当作并发控制。判断条件应进入 SQL WHERE 或同一事务。

### Invite bootstrap

1. Owner 创建 `project_grant` 或 `principal_recovery` Invitation。Worker 根据 kind 固定计算 expiry：Project Invite 为 7 天，Recovery Invite 为 1 小时；API 不接受自定义时长。D1 保存 kind、code hash、目标 Project roles 或 bound principal、expiry 和状态；Worker 返回一条可复制的 Invite URL 话术。兑换后的 Project Grant 不继承 expiry。
2. `GET /invite?...` 只返回无副作用的 bootstrap 文档、邀请摘要和可信 Skill 安装或更新入口，不消费 Invitation。
3. Skill 内置脚本以 `instance_id` 查找本地有效 Credential：唯一匹配则复用 Principal，无匹配则可以为首次加入生成并安全保存新 Credential secret；同一实例出现多个不同 Principal 时返回本地冲突且不选择。上层决定是否进入整理或恢复流程。
4. 客户端通过幂等 POST 兑换。Project Invite 创建或复用 Principal/Credential 并写 Project Grants；Recovery Invite 为 bound principal 创建新 Credential，并按轮换/全失恢复模式撤销当前或全部旧 Credential。Worker 在同一业务原子单元中校验并消费 Invitation、完成变更并写 Event/Audit。
5. 响应丢失时，客户端保留本地 secret，并使用相同 Idempotency-Key 重试；服务端返回首次结果，不重复创建身份或 grants。

首次 bootstrap 尚无 Principal，因此该兑换的幂等作用域使用 Invitation ID + endpoint + key，并把客户端 Credential fingerprint 纳入 request fingerprint；这是一条例外，不能推广成其他匿名写入能力。

### Browser Launch

1. 已认证 Agent 为明确 Project、Issue 或 Owner 管理 target 创建固定 5 分钟、一次性的 launch；D1 只保存 code hash、Principal、源 Credential、target 与状态。
2. 浏览器 GET 只加载同源启动页，POST 才原子消费 code 并由 Worker 设置 HttpOnly Session cookie；地址随即移除 code。
3. 浏览器后续仍通过同一 REST 服务读取和执行单资源原子操作。Session 固定 8 小时、不滑动续期且无 refresh；每次请求按 D1 当前 Session、Principal、源 Credential、Grant、容器状态与 target scope 授权。
4. cookie-auth 写入执行同源和 CSRF 校验。Session 不进入 KV，不从页面脚本读取，也不形成第二套权限缓存。

### 实例域名发现与迁移

1. 域名绑定是 Cloudflare 或第三方控制面事实；线上 Worker 不保存 Cloudflare Token，也不能枚举第三方 alias。`cfkanban-deploy` 可以使用部署者现有控制面身份只读 reconcile Cloudflare-native domains/routes。
2. D1 保存一个 Owner 推荐的 `preferred_api_origin` 与递增版本。首次 strict-zero 部署把实际 `workers.dev` HTTPS origin 初始化为推荐入口；后续修改由 `cfkanban-admin` 使用 Owner Bearer Credential 与 expected version 原子发布，不要求重新部署。
3. Worker 在每个可达 origin 动态返回公开、非秘密、`no-store` 的 `/.well-known/cfkanban-instance.json`，其中 `observed_origin` 从本次 `Request.url` 推导；响应不列举 aliases，不接受 forwarded host 覆盖，也不做跨 origin redirect。
4. 已有 Agent 只信任本地当前 trusted origin 给出的更高版本指示。它先不携带 Credential、不跟随 redirect 地探测新 origin，并交叉验证 instance ID、observed/preferred origin 与版本；全部一致后才原子更新本地记录。陌生入口不能靠自报同一 instance ID 获得信任，旧 origin 已失联时需要用户显式 rebind。
5. API Credential 的本地 origin 迁移不搬运浏览器状态。Web Session cookie 按 origin 建立；cfKanban v0 的 Passkey RP ID 固定为当前请求 hostname、expected origin 固定为当次完整 HTTPS origin，不启用跨 hostname 共享。新 hostname 通过 Agent Browser Launch 恢复并重新登记。

## 4. 组件职责

### Workers

承担：

- HTTP 路由、JSON schema、OpenAPI。
- Credential 到 Principal 的认证、唯一 Owner 判断，以及非 Owner Principal Project Grants 的 `reader | writer` 授权。
- 业务不变量、错误映射、请求大小限制。
- D1 transaction/batch 编排。
- 调用三个 Workers Rate Limiting bindings，以单 Principal 120/60 秒、实例动态 API 300/60 秒和未认证敏感操作 30/60 秒做近似门控；返回 429 与 `Retry-After`。首次部署自动生成，后续由 deploy Skill 发布配置修改。
- Invite bootstrap 文档、极简 Web 静态资产、Browser Launch/Session 与同源 CSRF 入口。
- 动态实例发现文档，以及 Owner Bearer-only preferred origin 配置端点；不负责创建、删除或枚举外部域名。

不承担：

- 进程内长期锁或会话事实。
- 请求内大规模文本分析。
- assignment 独占锁或到期计时；v0 的负责人不是执行锁。

### D1

承担：

- 所有核心业务表。
- active Credential、Principal 与 Project Grant 的撤销判断。
- Invitation 的过期、撤销、单次兑换和幂等结果。
- Browser Launch 的短时单次兑换、Web Session 撤销、源 Credential 失效和 target scope 判断。
- Project Invite 与 Principal Recovery Invite 的类型约束、bound principal 和旧 Credential 撤销顺序。
- CAS、唯一约束、关系完整性。
- Event cursor 和可恢复增量读取。
- Public Join enabled Project 独立的三项 active quota 及其可重算 usage；不形成实例共享池，关闭 Public Join 后不再强制或维护 counters。重新开启从权威表原子重算；enabled 期间 soft delete/revoke 释放、restore/regrant 重新占用，并与领域写入原子提交。limit 低于 usage 时只阻止计数继续增长。
- 单例 preferred origin、递增 version、更新 actor/time 与审计依据；它只是应用推荐入口，不代表 Cloudflare/第三方实际域名清单。

设计约束：

- 实例配置只允许一个稳定的 active `owner_principal_id`；不设置备用管理员，不支持 Owner transfer，Credential 轮换或恢复都不能改变 Owner Principal。
- 首次部署只展示一次 Owner bootstrap Credential；全部 Owner Credential 丢失时，应用内无恢复端点，只有掌握 Cloudflare deployment 的操作者可通过部署外受控 Skill 脚本为同一 Principal 重新签发并写安全 Audit。
- D1 按扫描行计量，索引是成本控制的一部分。
- 单个数据库串行处理查询，慢 SQL 会降低整个实例吞吐。
- 所有 Workspace 级查询都必须显式带隔离条件；常见约束和索引应覆盖 `(workspace_id, project_key)`、`workspace_id + project_id + status`、assignee/候选工作过滤、`updated_at`、Event 全局 sequence 与 Project scope、credential prefix、invitation code hash/expiry 和唯一 `(principal_id, project_id)` grant。
- Event 内部使用部署级单调 sequence；公开 opaque cursor 绑定 Principal、规范化过滤和实际可读 Project 集合。Grant 或容器变化导致集合变化时返回 `CURSOR_SCOPE_MISMATCH`，由客户端重新获取 snapshot cursor，不尝试跨 scope 拼接。
- Free 单库容量是硬边界；大附件和长日志不进入 D1。

### Workers KV

v0 不使用。

未来只允许保存可容忍陈旧、可重建的内容，例如公开能力缓存或低风险派生提示。以下内容禁止以 KV 为唯一事实：

- Issue 最新状态；
- Issue assignment 或其他需要即时 CAS 的协调状态；
- Credential 吊销；
- Invitation 兑换状态；
- Principal/Project Grant 授权判断与撤销；
- 精确计数和幂等结果。

KV 的全局最终一致性会直接破坏这些语义。

### Durable Objects

SQLite-backed Durable Objects 当前可用于 Free plan，但“可用”不等于“应该使用”。

后续只有出现以下已验证需求时才评估：

- 每 Project 的实时连接或广播。
- D1 条件更新无法满足的高频协调。
- 需要 alarm 的长连接生命周期。

如果引入，必须明确它是协调器还是事实源，避免 D1/DO 双写同一核心状态。默认仍以 D1 为权威。

### Queues

适合：

- webhook 和通知。
- embedding / Vectorize 异步重建。
- AI 摘要。
- 较慢的外部副作用。

Queue 是至少一次投递通道，消费者必须按 event ID 幂等。Queue 不保存 Issue 真相，也不保证业务状态顺序。

### R2

用于后续附件、Agent 产物和较长日志。D1 只保存 object key、hash、size、content type 和访问策略。v0 不借 R2 包装完整 D1 导出、导入或整库恢复能力。

严格零账单版本可以完全不启用 R2，并限制正文、评论和 completion payload 大小。

### Vectorize 与 Workers AI

当前 Vectorize 已有免费层，并非付费版专属；Workers AI 也有每日免费额度。

它们仍然属于增强层：

- D1 保存原文、索引版本和 mutation 状态。
- Vectorize 保存由 D1 原文与已提交 Event 异步生成的可重建向量；D-214 将其确定为后期检索增强的优先方向。
- Workers AI 负责 embedding、摘要、相似 Issue 或标签建议。
- AI 不参与权限、状态机、assignment 授权或唯一约束。

写入 Vectorize 是异步的，不能用于刚写即读的核心判断。

## 5. 协议分层

### REST/JSON

唯一权威业务合同。所有适配器都调用同一实现。

### OpenAPI

用于 schema、文档、客户端生成和工具描述。它不能保证每个 Coding Agent 自动形成高质量工具，也不能替代服务端约束。

### Agent Skills

首要 Agent 体验层：

- 注入 base URL 和安全凭据引用；
- 解析 Invite URL，按 instance 查找本地身份，并完成幂等 bootstrap/redeem；
- 说明各项能力的参数、后果、组合非事务性和结构化恢复信息，并提供可覆盖的默认建议与本地约定，但不替上层决定工作循环；
- 裁剪/渲染 context pack；
- 对不同 Agent 的配置差异做适配；
- 按需调用 bundle 内 Node.js/TypeScript scripts 完成凭据、重试、部署 journal 等确定性操作；
- 为明确 Project/Issue/Owner 管理 target 创建一次性 Browser Launch；宿主支持时打开 IAB，否则返回普通浏览器 URL。
- 低频读取当前 trusted origin 的实例发现文档；只有更高版本指示与无 Credential 目标探测完全一致时自动更新本地 trusted origin，否则保留旧记录并请求显式 rebind。

Skill 是客户端分发包，不是云端状态或人类页面。v0 不发布独立 cfKanban CLI；Node scripts 只是 Skill 内部执行资源。人类直接表面由同一 Worker 托管的极简 Web UI 提供，并复用同一 REST 业务合同。

### MCP

保留为可选远程适配器，不与 REST/OpenAPI 形成二选一。

当前 MCP 标准支持远程 Streamable HTTP；“MCP 必须运行本地 proxy、stdio 或 WebSocket”不是可靠前提。若以后实现，优先做无状态薄适配，避免复制领域逻辑。参考 [MCP transport specification](https://modelcontextprotocol.io/specification/draft/basic/transports)。

## 6. 部署层级

### 产品层级

已确认的逻辑关系是：

`Deployment Instance → Workspace → Project`

一个部署者控制的部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project。同一个 Worker 与 D1 可以承载这些 Workspace，但这不自动意味着首发公共多租户 SaaS。

每个部署实例只有一个 Deployment Owner。只有 Owner 能创建 Workspace/Project、创建或撤销 Invitation 并管理 Project Grants。参与者首次 bootstrap 使用普通 Project Invite URL；Credential 轮换与全失恢复使用显式绑定既有 Principal 的 Recovery Invite，参与者不能自行签发额外 Credential。Owner 无需 Project Grant，隐式拥有全部控制面与 Project 数据面能力；Owner 操作以 `authorized_via=deployment_owner` 单独审计。

非 Owner Principal 可以通过多个 Project Grants 访问分布在不同 Workspace 的多个 Project；Credential 本身不承载这些 scopes。参与者只有 `reader | writer`，Workspace 不产生向下继承权限，所有业务读写仍显式携带 Workspace/Project 上下文，并校验目标 Project Grant。

`writer` 可以软删除和恢复 Project 内容；删除时写 `deleted_at`、actor、version 和 Event/Audit，不做即时物理删除。`writer` 不能删除或恢复 Workspace/Project 容器，这些容器只能由 Owner 操作。容器软删除只暂停访问，不批量改写子行：子资源和 Grants 保留；恢复后仍有效的 Grants 自动恢复。v0 不提供公开 hard-delete API。

Issue 的 assignee 只表示负责人，不产生独占执行权或新的授权。任何具有目标 Project `writer` 权限的 Principal 都可以继续协作写入；D1 条件更新与 version/CAS 防止静默覆盖，Event 记录真实 actor。

新 assignee 只能是唯一 Owner，或当前具有目标 Project 有效 `writer` Grant 的 Principal；资格检查与 assignment 更新处于同一一致性边界。Grant 后续撤销或降级不改写 Issue 行中的 assignee/status，读取时根据当前 Grant 投影 `assignee_available=false`、`needs_reassignment=true`，并支持定向过滤。

blocked 不占用 workflow status：D1 保存人工 `blocked_reason` 和 `blocked_by` 关系，读取时投影统一 `is_blocked`。依赖完成或关系移除会自动改变投影；人工原因只能由显式 `clear-blocked` 清除，两者都不隐式改写 status。

workflow 不需要通用状态机配置：五个稳定 status key/category/position/terminal 由应用合同固定，D1 只保存每个 Project 可选的显示名称覆盖。查询、候选过滤和 Agent 行为使用稳定 key/category，不能依赖可变显示文本。

Invite URL 是唯一允许 URL 携带 Bearer secret 的 bootstrap 例外，且只承载短期一次性 Invitation code，不承载长期 Credential。页面必须 no-store、no-referrer、无第三方资源/分析并避免完整 URL 日志；GET 永不兑换，防止链接预览和预取产生权限副作用。

当前候选中的所有 Workspace 共享 Worker、D1、域名、部署生命周期和 Cloudflare 配额，因此 Workspace 最多是应用层逻辑隔离，不是基础设施级 hostile-tenant sandbox。一个 Workspace 的高负载可能影响同实例中的其他 Workspace；若未来承载互不信任团队，需要重新做威胁模型、配额隔离和物理数据边界评估。

### Strict-zero baseline

- Workers Free
- D1 Free
- Workers Static Assets（Web、Invite/bootstrap 与 API 由同一个 Worker deployment 发布，不创建 Pages project）
- 应用内 per-Agent Credential
- 无 KV namespace、R2、Queue、DO、Vectorize、AI

超限时以明确失败和退避为主，不产生意外账单。

### Free optional experiments

- Vectorize 小规模语义索引
- Workers AI 免费额度
- Queues 异步派生
- Turnstile 保护人类入口

这些能力必须可关闭，且免费额度用尽后核心仍可运行。

### Billing-enabled

- Workers Paid 提升请求与 CPU 边界
- R2 附件/产物
- 更高 Vectorize/AI 使用量
- 确有实时需求时使用 Durable Objects
- 私有组织部署可考虑 Cloudflare Access

“有免费额度”和“绝不会产生账单”是两种产品承诺，配置与文档必须分开。

## 7. 主要失效场景

| 场景 | 预期行为 |
| --- | --- |
| Workers 请求或 CPU 超限 | 映射清晰错误；客户端指数退避，不快速重试 |
| D1 rows read 超限 | 返回可识别 quota error；减少全表查询，等待额度重置或升级 |
| D1 rows written 超限 | 拒绝业务写入，不假装成功；核心读能力视平台行为保留 |
| Credential 已吊销 | 权威 D1 检查立即拒绝，不依赖 KV 传播 |
| Invite URL 被聊天软件预览或浏览器预取 | GET 只返回说明，不消费 Invitation；真正兑换只接受显式幂等 POST |
| Invitation 兑换成功但响应丢失 | 客户端保留本地生成的 secret，并用同一 Idempotency-Key 重试获得首次结果 |
| 普通 Project Invite 遇到本地失效 Credential | 不按名称恢复旧 Principal；让人选择请求 Recovery Invite 或明确创建新 Principal |
| Recovery Invite 绑定身份与有效本地 Credential 不一致 | 返回 `RECOVERY_PRINCIPAL_MISMATCH`，不消费邀请、不创建 Credential |
| complete 响应丢失 | 同 Idempotency-Key 重试返回首次结果 |
| 两个 Agent 基于同一旧 version 写入 | CAS 只接受一个更新；另一方获得 `VERSION_CONFLICT` 后重新读取和判断 |
| Queue 重复消息 | 派生消费者按 event ID 去重 |
| Vectorize/AI 不可用 | 关闭语义增强，回退到 D1 过滤和关键词查询 |

## 8. 暂不决定

- 是否需要 Cloudflare Access 的组织部署 profile。
- 什么规模或实时证据才触发 Durable Objects。

这些选择记录在[待讨论问题](../project/open-questions.md)，不应在代码中提前固化。
