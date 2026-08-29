# cfKanban 决策登记表

- 文档状态：Draft
- 最近更新：2026-08-29

## 状态定义

- Confirmed：来自用户明确方向，或 Agent 在用户明确授予的低偏差决策范围内作出并记录依据；仍可由用户后续修改。
- Proposed：当前推荐方案，需要继续讨论或在 SPEC 冻结时确认。
- Deferred：明确不在当前阶段决定。
- Rejected：已经确认不采用。
- Superseded：由后续决策替代。

“Proposed” 不是实现合同。只有相关 SPEC Frozen 后，公共技术选择才可按稳定合同实施。

## 登记

| ID | 决策 | 状态 | 依据与影响 |
| --- | --- | --- | --- |
| D-001 | 产品主要面向 Coding Agents，人类 UI 不是核心 | Superseded | “Agent 是主要使用者、协议与恢复能力优先”仍成立，但“不把人类 UI 视为 v0 必需表面”的理解已由 D-215 修订 |
| D-002 | 基于 Cloudflare，优先免费服务，付费能力做增强 | Confirmed | 用户初始方向；核心不能依赖 AI/Vector |
| D-003 | 保留 Project、Issue、状态、评论、标签等 Kanban 核心 | Confirmed | 用户初始方向；借鉴 Linear 但不照搬全部层级 |
| D-004 | 当前阶段只讨论并写文档，不进行实现 | Confirmed | 用户本轮明确要求 |
| D-005 | Linear 项目 `cfKanban` 作为执行跟踪真相 | Confirmed | 用户授权创建；2026-08-26 已在线读回 |
| D-006 | 一个部署者控制的部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project | Confirmed | 用户于 2026-08-27 明确确认；Workspace 必须成为显式产品层级 |
| D-007 | Credential 只认证 Principal；同一 Principal 可以通过独立授权访问多个 Workspace 和多个 Project | Confirmed | 用户于 2026-08-27 明确确认；身份与资源授权必须分离 |
| D-008 | Project 与代码仓库不强制一一对应 | Confirmed | 用户当前工作会让同一 Repo 横跨多个项目；Repo 不是身份或授权边界 |
| D-009 | v0 业务权限按 Project 显式授予，不从 Workspace 继承 | Confirmed | 用户于 2026-08-27 选择按 Project 授权；新 Project 不自动向现有 Principal 开放 |
| D-010 | 每个部署实例恰好一个 Deployment Owner | Confirmed | 用户于 2026-08-27 明确确认；Owner 是控制面身份，不是第三种 Project role |
| D-011 | 只有 Owner 能创建 Workspace/Project、邀请参与者和管理 Project Grants | Confirmed | 参与者不能创建容器、邀请 Principal 或改变授权；容器删除与恢复另见 D-119 |
| D-012 | 非 Owner 的 Project role 只有 reader/writer；Project 内容删除属于 writer 且采用软删除 | Confirmed | 不设置 maintainer/delete role；硬删除不进入参与者 API |
| D-013 | 低偏差、可逆且不改变安全或公共产品语义的设计细节可由 Agent 决定；重要边界继续与用户确认 | Confirmed | 用户于 2026-08-27 明确授权；不扩大实现、Linear、部署、迁移、提交或推送权限 |
| D-014 | 常见 Kanban 规则可按“简单、Agent 友好”由 Agent 直接收敛；影响业务方向或关键用户体验的选择仍需用户确认 | Confirmed | 用户于 2026-08-28 明确授权；安全、权限、恢复、成本、不可逆合同和外部副作用边界不因此放宽，也不扩大实现或外部写入权限 |
| D-101 | 一个自托管部署实例对应一个 workspace，实例内多个 Project | Superseded | 被 D-006 的多 Workspace 层级替代 |
| D-102 | Workers + D1 是 v0 唯一必要运行组件 | Confirmed | 依据用户的 Cloudflare 免费优先与简单原则收敛；核心不依赖付费或可选服务 |
| D-103 | D1 是核心事实唯一来源，v0 不使用 KV | Confirmed | 依据简单与一致性收敛；KV 最终一致，不适合权限、幂等和需要 CAS 的 Issue 状态，未来只可承载可重建派生缓存 |
| D-104 | REST/JSON 是权威合同，OpenAPI 描述，Skill/CLI 首要适配，MCP 可选 | Superseded | REST/OpenAPI 与 MCP 方向保留，但独立 CLI 被取消；由 D-164、D-165 替代 |
| D-105 | Credential 直接承载 Workspace/Project scope 与 role | Superseded | 被 D-007 的认证/授权分离替代 |
| D-106 | claim 是会过期并带 fencing 的 lease | Rejected | 用户于 2026-08-27 认为独占执行权过重；由 D-127 的非独占 assignment + version/CAS 替代 |
| D-107 | blocked 与 status 正交，并提供统一 `is_blocked` 投影和便捷命令 | Confirmed | 用户于 2026-08-27 明确同意；依赖完成可自动解除对应阻塞，人工 reason 需显式清除，均不自动改变 status |
| D-108 | Board/Column 是 Project + Status 查询视图，不建独立实体 | Confirmed | 依据 D-014 收敛常见 Kanban 规则；避免 UI 模型污染核心 |
| D-109 | Comment、领域 Event、安全 Audit 分开建模 | Confirmed | 协作者内容、业务历史和安全事实语义不同；完成记录仍以结构化 Comment 呈现 |
| D-110 | 创建/命令 POST 使用 Idempotency-Key，普通聚合更新使用 expected version | Confirmed | 依据 Agent 网络重试和并发正确性收敛；鉴权先于历史响应重放 |
| D-111 | v0 固定五个 status key/category/order/terminal 语义，Project 只可覆盖显示名称 | Confirmed | 用户于 2026-08-27 明确确认；不允许增加、删除、重排状态或自定义 transition graph，Agent 始终依赖稳定 key/category |
| D-112 | Skill 可带本地查看器，但不是唯一远程管理面 | Superseded | 最终由 D-164 明确：管理 API + Agent Skills 是权威入口，本地查看器可选，v0 不要求部署端维护网页 |
| D-113 | 普通 Credential 不允许跨 Workspace | Rejected | 用户明确认为同一 Agent 身份可以跨多个 Workspace/Project |
| D-114 | 用通用 Access Grant 同时表达 Workspace/Project role | Superseded | 被 D-009 的 Project-only 授权替代 |
| D-115 | Workspace maintainer 管理 grants，但不管理 Credential 生命周期 | Superseded | v0 不再设置 Workspace grant/role；最终由 D-010 至 D-012 的单一 Owner 与两档参与者模型替代 |
| D-116 | 用独立 Project Grant 表达 Principal 在一个 Project 上的 `reader | writer` role | Confirmed | 用户已确认按 Project 授权和两档参与者权限；只有 Owner 可创建、变更和撤销，物理字段与唯一约束见 D-121、D-141、D-142 |
| D-117 | Project maintainer 不默认管理 Principal/Credential 生命周期 | Superseded | D-012 已取消 Project maintainer role；控制面统一归唯一 Owner |
| D-118 | Owner 是实例配置引用的唯一 Principal；首次用一次性 bootstrap Credential，支持安全轮换和部署外同 Principal 恢复 | Confirmed | 用户已确认单一不可转移 Owner，并于 2026-08-27 允许部署控制者在全部 Credential 丢失时恢复同一 Principal |
| D-119 | Workspace/Project 容器只能由 Owner 软删除和恢复；Project writer 不能删除容器 | Confirmed | 用户于 2026-08-27 明确同意该权限边界；具体容器失效语义另见 D-123 |
| D-120 | Owner 无需 Project Grant 即隐式拥有全部 Project 的 reader/writer 能力 | Confirmed | 用户于 2026-08-27 明确确认；Owner 不是第三种 Project role，操作以 `authorized_via=deployment_owner` 单独审计 |
| D-121 | 每个 `(principal_id, project_id)` 只有一条当前 Project Grant 记录，带 role、version 和 revocation 字段，不带 expiry | Confirmed | 用户于 2026-08-28 取消 Grant 失效日期；依据简单和低写放大原则，角色变更、撤销与重新授予更新同一行并写 Audit/Event |
| D-122 | `writer` 可以恢复其有权软删除的 Project 内容 | Confirmed | 用户于 2026-08-27 明确确认；恢复与软删除属于同一 `writer` 数据面权限 |
| D-123 | 容器软删除只暂停访问：保留子资源和 Project Grants；恢复后未撤销 Grants 自动恢复 | Confirmed | 用户于 2026-08-27 明确同意暂停语义；已撤销 Grant 不会因容器恢复而复活；原 active lease 条款由 D-127 取消 |
| D-124 | 软删除统一使用 deleted_at/deleted_by/version 并写 Event/Audit；v0 不提供公开 hard-delete API | Confirmed | 依据 D-013 选择简单且可恢复的低偏差方案；长期物理保留策略 Deferred |
| D-125 | 实例不设置第二管理员，也不支持 Owner transfer | Confirmed | 用户于 2026-08-27 明确确认；Credential 轮换或恢复只能继续绑定同一个 Owner Principal |
| D-126 | Owner Credential 全失时，只允许掌握 Cloudflare deployment 的操作者通过部署外受控 Skill 脚本重新签发 | Confirmed | 不提供应用内恢复端点，不复活旧 Credential；恢复写安全 Audit 且不改变 `owner_principal_id` |
| D-127 | v0 用单一可空 assignee 表示 Issue 负责人，不采用 lease 或独占执行权 | Confirmed | 用户于 2026-08-27 明确确认；assignment 不改变授权，任何 Project writer 均可协作写入，静默覆盖由 version/CAS 防止 |
| D-128 | v0 用 Owner 创建的短期一次性 Bearer Invite URL 完成参与者 bootstrap | Confirmed | 用户于 2026-08-27 明确确认；GET 只提供说明且不兑换，Agent 通过可信 Skill 复用本地 Principal，或用 Skill 内置脚本创建 Principal/Credential，再以幂等 POST 原子兑换一个或多个 Project Grants |
| D-129 | assignee 只能是 Owner 或目标 Project 的有效 writer；失效后保留引用并投影待重新分配 | Confirmed | 用户于 2026-08-27 明确确认；reader/无权 Principal 不可分配，assignment 不扩大授权，撤权不静默改写 assignee 或 status |
| D-130 | 参与者 Credential 轮换/全失恢复使用 Owner 创建的 Principal Recovery Invite，与普通 Project Invite 严格分离 | Confirmed | 用户于 2026-08-27 明确确认；恢复邀请绑定既有 Principal 并继承其全部授权与历史，轮换撤销当前旧凭据，全失恢复撤销全部旧凭据；参与者不能自行签发额外 Credential。邀请 mode 的创建与兑换语义由 D-205 进一步固定 |
| D-131 | status 显示名称仅 Owner 可修改；Owner 或 Project writer 可在固定状态间任意显式转换和 reopen | Confirmed | 用户于 2026-08-28 明确确认；写入必须带 expected version 并记录旧状态、新状态和 actor，terminal 不表示不可逆，转入 done 不能绕过 Q-101 的原子完成合同 |
| D-132 | 完成结果保存为结构化、不可变且不可删除的 completion comment，不建立独立 Completion 实体 | Confirmed | 用户于 2026-08-28 明确确认；complete 原子校验 version、追加完成记录、转为 done 并写 Event，reopen 保留旧记录，再次完成追加新记录 |
| D-133 | v0 Issue Relation 支持 blocks、parent、related、duplicate 四类语义 | Confirmed | 依据 D-014 直接收敛常见 Kanban 规则；反向关系由读取投影派生，关系本身不自动改变 status、assignee 或权限；关系范围见 D-134 |
| D-134 | v0 允许同一 Workspace 内跨 Project 建立全部四类 Issue Relation，禁止跨 Workspace | Confirmed | 用户于 2026-08-28 明确允许跨 Project；跨 Project 写入要求同时拥有两端 writer，读取只暴露调用者同时可读的两端，避免关系成为越权写入或存在性泄露通道 |
| D-135 | v0 不首发原子 assign-next，提供彼此独立的确定性候选列表、assign 与 assign-to-me | Confirmed | 依据 D-014 收敛并按 D-195 修订；assignment 不形成独占权。上层可以自行组合这些能力；Skill 不封装规范工作流，VERSION_CONFLICT 只返回当前 version 与刷新指引，不替上层选择其他 Issue |
| D-136 | v0 不要求部署端人类维护网页，管理 API + CLI/Skill 是权威维护入口 | Superseded | 轻 UI 方向保留，但独立 CLI 被取消；由 D-164 替代 |
| D-137 | v0 首批 Agent 集成为一个通用 CLI 加 Codex 与 Claude Code 的薄 Skill | Superseded | 用户于 2026-08-28 明确不希望维护独立 cfKanban CLI；由 D-162 替代 |
| D-138 | v0 提供部署级、按当前 Principal 授权过滤的跨 Workspace/Project Issue 聚合读取 | Confirmed | 用户于 2026-08-28 明确同意；只聚合读取，不提供跨范围批量写入或 assign-next，详情和写入仍使用明确 Workspace/Project 上下文 |
| D-139 | 聚合读取的 Project filter 在 API 上可省略，但 Skill 在已知上下文中强烈推荐一个或多个明确 Project | Confirmed | 用户于 2026-08-28 明确要求并按 D-190/D-195 修订；作用域使用无歧义的 workspace + project 组合，响应始终返回 resolved scope 与范围警告。何时省略过滤由上层决定，Skill 不拒绝合法的全授权范围读取 |
| D-140 | Project Grant 支持可选 expires_at，默认不过期；只有 Owner 能延长、重新启用或撤销 | Superseded | 用户随后认为 Grant expiry 会显著复杂化授权判断；由 D-141 替代 |
| D-141 | Project Grant 不设置失效日期，Invitation expiry 是唯一的邀请时效 | Confirmed | 用户于 2026-08-28 明确调整并由 D-219 修订；授权只由容器状态、Grant role 和 revocation 决定，避免自动失权、续期与临时角色回退 |
| D-142 | 普通 Project Invite 不改写已有有效 Grant；已撤销 Grant 可按新邀请重新授予 | Confirmed | 用户于 2026-08-28 大体认可并要求简化 Grant；已有有效访问返回 already_has_access，角色变化走 Owner 显式操作，多 Project 邀请仍原子处理各项目结果 |
| D-143 | Event 使用部署级单调序号；公开 opaque cursor 绑定 Principal、过滤条件和实际可读 Project 集合 | Confirmed | 依据 D-014 按 Agent 友好的增量恢复直接收敛；权限或 scope 变化返回 CURSOR_SCOPE_MISMATCH，客户端重新获取有界快照，Credential 轮换不使同 Principal cursor 失效 |
| D-144 | Issue priority 固定为 none/low/medium/high/urgent，v0 不保存手工 rank | Confirmed | 依据 D-014 按简单和低写放大收敛；默认 none，候选按 priority 后 created_at/ID 稳定 FIFO，不为拖拽顺序制造批量写入 |
| D-145 | 非天然幂等的创建与命令 POST 必须携带 Idempotency-Key，记录保留 24 小时 | Confirmed | 依据 Agent 重试窗口和 D1 容量直接收敛；作用域绑定 Principal/endpoint/完整资源 scope，请求指纹不同则冲突，鉴权始终先于响应重放 |
| D-146 | 结构化错误提供稳定 code、retryable 与 recovery hint，并隐藏无权资源存在性 | Confirmed | 依据 D-014 按 Agent 可恢复性与最小信息泄露收敛；同请求可安全重试才标 retryable，版本/cursor 冲突要求刷新而非盲重试 |
| D-147 | v0 普通 Comment 追加后不可原地编辑，可软删除/恢复；纠错使用引用旧 Comment 的新 Comment | Confirmed | 依据 D-014 按简单与可审计历史收敛；避免 Comment revision 子系统和静默改写，completion comment 仍不可编辑、删除或恢复 |
| D-148 | v0 保留显式 assign-to-me 命令，不以通用 PATCH 作为唯一自分配入口 | Confirmed | 依据 D-014 按 Agent 友好收敛；服务端从当前 Credential 推导 Principal，避免客户端复制自身 ID，命令仍只设置 assignee 而不产生 lease |
| D-149 | v0 Credential 不设置自动失效日期，只能显式撤销、轮换或随 Principal disable 失效 | Superseded | “Credential 不自动过期”继续有效；Principal disable 已由 D-219 移除，Credential 只通过显式 revoke、rotation 或 full recovery 中的撤销失效 |
| D-150 | v0 使用小而明确的应用级资源上限，并通过 cursor/truncated 引导 Agent 分批读取 | Confirmed | 依据 D-014 按上下文友好和 D1 成本收敛；请求 128 KiB、Issue body 64 KiB、Comment/completion 32 KiB、列表默认 20/最大 100、context 最大 64 KiB，不接受大日志或附件内联 |
| D-151 | 聚合读取用可重复的 `project=workspace_key/project_key` 表达最多 20 个明确 Project scope | Confirmed | 依据 D-014 按 Agent 可读性直接收敛；服务端去重并按内部 Project ID 规范化，同维度 OR、跨维度 AND，参数顺序不影响 cursor scope |
| D-152 | v0 Invite URL 固定使用 `/invite?code=<opaque>`，并以 no-store/no-referrer/无第三方资源保护 Bearer code | Confirmed | 沿用用户提出的最简单离线话术形式并按 D-014 收敛编码；GET 永不兑换，完整 query 不进入应用日志，页面读取后尽快移除可见 code |
| D-153 | 普通 Project Invite 固定有效 7 天，Principal Recovery Invite 固定有效 1 小时，v0 不支持自定义或延长 | Confirmed | 用户于 2026-08-28 明确确认；兼顾离线转发与高风险身份恢复，减少时效配置分支，过期后由 Owner 重新创建 |
| D-154 | Foundation SPEC 冻结领域、权限、并发与基础 HTTP 语义，不替代完整 OpenAPI/DDL | Confirmed | 依据项目文档真相边界收敛；字段级请求响应、未逐项列出的单操作 CRUD/command 与 D1 DDL/索引在实现前进入独立 Frozen API/Schema SPEC，Foundation 冻结不授权实现 |
| D-155 | Foundation SPEC 暂不冻结，先用部署到日常协作和恢复的用户 Storyboard 逐卡复核 | Confirmed | 用户于 2026-08-28 明确提出；Storyboard 是产品验收剧本而非实现 backlog，新发现的稳定结论再回写产品简报、决策登记表或 SPEC |
| D-156 | Agent-first 的默认操作主体是 Agent；人类负责表达意图、提供不可推导信息并在重要副作用前授权 | Confirmed | 用户于 2026-08-28 指出原 Storyboard 仍以人为操作主体；部署、建项、邀请和 Issue 工作均应从“人给目标，Agent 判断与执行”的责任链验收 |
| D-157 | Agent 使用与部署体验由独立 Agent Skills & Bootstrap SPEC 治理，不继续塞入 Foundation SPEC | Confirmed | Foundation 负责服务端领域、权限和可靠性合同；Agent Skills SPEC 负责 bootstrap、安装、宿主差异、跨平台 scripts、凭据落地与操作恢复；两份 Draft 都不授权实现 |
| D-158 | v0 Agent 集成采用 portable Skill core、宿主 adapter、共享确定性 CLI 与服务端强制合同四层分工 | Superseded | 用户取消独立 CLI 和 Host Adapter 角色；由 D-161 至 D-163 替代 |
| D-159 | 共享 CLI 与确定性 helper 优先采用 Node.js/TypeScript，并锁定经验证的本地 Wrangler 版本 | Superseded | Node.js/TypeScript 选择保留，但载体改为 Skill 内置 scripts；由 D-162 替代 |
| D-160 | 部署入口采用 canonical HTTPS bootstrap document，解析 immutable、可校验版本工件，不执行远程 pipe-to-shell | Confirmed | 用户于 2026-08-28 确认 SB-01；官网 bootstrap 是信任入口，marketplace/plugin 只作便捷分发，不能成为唯一真相源。具体 release manifest 与 Skill/Service bundles 分层由 D-209 完善 |
| D-161 | 产品只建模“用户的 Agent”这一种操作主体，部署、Owner 管理、Coding 与协调只是任务模式 | Confirmed | 用户于 2026-08-28 明确指出林的 Agent、陈的 Agent才是真实使用关系；任务模式不得成为 Principal kind、权限、审计身份或独立 Agent 角色 |
| D-162 | v0 不发布独立 cfKanban CLI；确定性逻辑放入 Skill bundle 内少量 Node.js/TypeScript scripts | Confirmed | 用户于 2026-08-28 明确要求简化；scripts 只由 Agent 按 Skill 调用，不形成独立用户界面或公共命令合同，Wrangler 固定为 bundle 验证版本 |
| D-163 | Host Adapter 不作为独立角色或产品层，宿主差异由 bootstrap 安装规则与 Skill 内置 scripts 吸收 | Confirmed | Codex、Claude Code、小龙虾、Workbuddy 等仍是同类用户 Agent；安装路径、刷新和 metadata 属于实现细节，不能扩展权限或复制领域逻辑 |
| D-164 | v0 权威维护入口为管理 API + Agent Skills，不要求部署端维护网页 | Superseded | 原轻 UI 判断低估了人类直接查看 Kanban 和低频参与的价值；由 D-215 替代 |
| D-165 | REST/JSON 与 OpenAPI 是权威服务合同，Agent Skills 是首要适配，远程 MCP 可选且后置 | Confirmed | Skills 可以直接调用 HTTP 或使用内置 scripts，但不复制服务端领域规则；不以独立 CLI 作为中间公共合同 |
| D-166 | Node 是用户拥有的通用开发环境；Skill 可以探测和引导，但不能静默决定安装器、版本管理器、路径或全局默认版本 | Confirmed | 用户于 2026-08-28 明确担心跨 OS 安装方式、Node 版本与用户习惯冲突；已有兼容 Node 优先复用，任何安装或环境修改都先由用户选择并授权 |
| D-167 | stable Skill release 用机器可读 semver range 声明已验证 Node 范围，稳定 SPEC 不写死具体 Node 版本 | Confirmed | Node LTS/Current 状态会变化；兼容合同随 release 验证，Agent 不为追逐最新版改变用户环境 |
| D-168 | Wrangler 是 deploy source 中由 lockfile 锁定的项目本地依赖，不要求或修改全局 Wrangler | Superseded | `deploy source` 与“项目本地”在 cfKanban 场景含义不清，容易误解为每个用户 Repo 安装一份；由 D-170 替代 |
| D-169 | 用户选定 Node 安装方式后，Agent 可在展示精确计划并取得授权后代为执行和验证；计划外的系统级变化需要另行授权 | Confirmed | 用户于 2026-08-28 明确认可。授权只覆盖已展示的命令、来源、版本范围、scope 和目标路径；新增 package source/version manager、提权、修改 PATH/shell profile、改变全局默认版本或卸载旧版本不能隐含在这次授权中 |
| D-170 | Wrangler 优先复用用户显式配置或 PATH 中的兼容版本，否则安装到跨 Agent/Repo 共享的用户级 cfKanban Tool Runtime | Confirmed | 用户于 2026-08-28 明确认可。不修改用户现有 Wrangler，不在任意工作 Repo 重复安装；私有 runtime 不属于 Codex/Claude，不向 PATH 暴露全局命令。具体目录、版本并存和清理策略是后续实现细节，不改变该解析模型 |
| D-171 | v0 同时支持 Windows 原生和 WSL2，但把它们视为互不混用的独立执行环境 | Confirmed | 用户于 2026-08-28 明确确认。Windows 原生是一等环境；Agent 完整运行在 WSL2 内时按独立 Linux 环境支持。Node、Wrangler、Skills、Tool Runtime 与 Credential 都在当前环境内解析和保存，不跨 Windows/WSL 边界自动发现、调用或共享 |
| D-172 | cfKanban Credential 优先使用 OS secure store；不可用时才允许显式受限文件降级 | Rejected | 用户于 2026-08-28 明确认为 OS secure store 会带来安全提示、远程 SSH 和跨环境访问摩擦，不符合简单、Agent-first 的目标；由 D-173 替代 |
| D-173 | v0 默认把 cfKanban Credential 保存到用户主目录下的受限本地文件；OS secure store 不作为依赖 | Confirmed | 用户于 2026-08-28 明确选择类似 `~/.cfkanban/` 的用户级目录。目录和文件依赖 OS ownership/ACL 与最小权限保护，不声称加密；写入前和使用前校验，不进入 Repo、同步/临时目录、日志、环境配置或 Agent 正常上下文 |
| D-174 | 一次明确的部署计划授权覆盖同一 Agent 任务内该计划列出的 Cloudflare 写入与无漂移恢复；计划外高风险副作用另行授权 | Confirmed | 用户于 2026-08-28 明确确认。用规范化 plan digest + operation ID/journal 绑定授权；计划内 Worker/D1、bindings、非破坏性 migration、服务部署、Owner bootstrap 和验证不逐步重复确认；新增付费、DNS/domain、删除/覆盖、破坏性 migration、未知资源接管、账户变化或 plan delta 必须再次确认 |
| D-175 | v0 默认 strict-zero 部署每实例只创建一个 Worker 和一个 D1，先使用 `workers.dev` 地址；custom domain 与可选服务显式启用 | Confirmed | 用户于 2026-08-28 明确确认。Agent 从人类可读 instance key 提议资源名并在 plan 展示。同名资源只有本地 receipt/journal、Cloudflare account、资源类型与远端 instance marker 全部匹配才可 resume/update；否则停止并建议新名称，不自动接管、覆盖或猜测归属 |
| D-176 | “更新”必须拆成互不隐含的本地 Skill update 与云端 Instance upgrade 两个平面 | Confirmed | 用户于 2026-08-28 明确指出两类更新。只读 update check 可同时报告两边版本；执行任一更新不能静默触发另一边。若兼容性要求两者都更新，Agent 必须在计划中分成两个阶段分别记录结果 |
| D-177 | 本地 Skill update 从 canonical immutable bundle 原子切换，保留上一已知良好版本，不改变云端实例 | Confirmed | 依据 D-013/D-014 和已确认的 SB-01 发行模型收敛：检查更新只读；写入前展示精确版本/source/digest/兼容性，已安装副本有本地修改时停止；更新后做 discovery smoke，失败回到旧 bundle |
| D-178 | 云端 Instance upgrade 使用固定目标版本、兼容矩阵、D1 restore point 与独立 upgrade plan；数据库 restore 永不自动执行 | Confirmed | 用户于 2026-08-28 明确确认。Worker 版本回滚不包含 D1 状态，旧 Worker 也可能与新 schema 不兼容。migration 按顺序执行：失败的单个 migration 回滚，但此前成功项保持已应用，因此整次升级不是一个跨 migration/Worker 的事务。常规升级只接受声明为向后兼容的 migration；破坏性 migration、无可验证 restore point、Worker rollback 或 D1 Time Travel restore 都必须展示额外风险和授权边界 |
| D-179 | Owner 的明确创建意图允许 Agent 展示自动推导的唯一 Workspace key 后直接创建；key 在 v0 不可变，display name 可修改 | Superseded | action preview、二次确认和自然语言消歧属于上层 Agent/宿主策略，不能成为 cfKanban 合同；由 D-198 修订。Workspace key 不可变、display name 可修改、创建不隐含 Project/Grant/默认成员等服务事实继续有效 |
| D-180 | Project 创建沿用 action preview 后直接执行；Project key 从创建起不可变，Repo 关联不自动上传到服务端 | Superseded | action preview 与何时执行属于上层 Agent/宿主策略，由 D-198 修订。Project key 不可变、Repo 不是权限边界、不自动上传本地路径/Git remote、canonical Repo URL 只是非授权 external reference 等服务事实继续有效 |
| D-181 | Project 创建后立即可用；可选 Project context 只是 Owner 维护的非可信背景信息，不是 Agent 指令或授权来源 | Confirmed | 用户于 2026-08-28 明确确认。固定 workflow 已提供可用默认值，不应增加必做初始化。单一有界 context 可保存目标、约定和链接，但必须与稳定合同、本地仓库规则和当前用户授权分层呈现；参与者可读但不能修改，默认不创建 Labels，任何远程内容都不能授权外部操作 |
| D-182 | v0 提供同一 Project 内 Issue 与内部关系的小批量原子创建 | Rejected | 用户于 2026-08-28 明确否决；批量事务会扩大服务端合同和失败恢复复杂度，不符合简单、稳妥、安全的方向。由 D-183 的单领域操作合同替代 |
| D-183 | v0 不提供公开批量写入；每次 API 调用只表达一个原子领域操作 | Confirmed | 用户于 2026-08-28 明确确认。一次 Issue 创建可以在内部原子写入该 Issue 所需的标签关联、Event 和幂等记录，但不能创建多个 Issue；Relation 等后续动作独立调用。调用方是否拆分复合目标、调用顺序和中断后的续做策略属于上层编排；服务只保证每个操作各自的幂等、并发、审计和可读回结果，不自动回滚或删除已经成功的其他操作 |
| D-184 | 明确的 Project Invite 请求在完整 scope preview 后直接创建；人类未指定 role 时默认 writer，只有明确只读才使用 reader | Superseded | 原决策把 API 合同、Skill 建议与上层 preview/确认混在一起，现由 D-198、D-203、D-204 分层替代。API 仍要求逐项显式 role；Skill 保留“未指定时推荐 writer、明确只读时 reader”的可覆盖建议；preview 与确认属于上层策略 |
| D-185 | v0 Principal 不区分 human/agent kind；服务端记录 immutable principal ID 与非唯一 display name，不从 OS/Git 身份静默推断 | Confirmed | 用户于 2026-08-28 明确确认并补充跨用户显示需求。Credential/Principal 表达稳定身份，Agent 宿主只是执行载体。principal ID 用于授权、assignee、审计和引用；display name 仅供展示、允许重名且不能用于恢复。没有现有 Credential 且接收方未给出名称时，Agent 只询问这一个必要参数 |
| D-186 | 每个 Principal 可通过默认日常 Skill 查看并原子修改自己的服务端 display name | Confirmed | 用户于 2026-08-28 明确确认。使用 `GET /api/v1/me` 与带 expected version 的 `PATCH /api/v1/me`，只允许修改非空 display name；成功写 Audit/Event，不改变 principal ID、Credential、Grants、assignment 或历史。v0 不新增独立 profile Skill，也不允许 Owner 代改他人名称；默认日常 Skill 的最终名称由 D-208 固定为 `cfkanban` |
| D-187 | 每个执行环境对每个部署实例只维护一个当前本地 Principal；多个不同 Principal 视为冲突而不是常规选择 | Confirmed | 用户于 2026-08-28 明确确认简化。`.cfkanban/` 可以保存多个上游实例，但每个 `instance_id` 正常只有一个当前 Principal/Credential 槽位；同一 Principal 轮换时短暂存在的新旧 Credential 属于内部过渡状态。发现同一实例对应多个 Principal 时停止并引导整理，不按名称、Repo、最近使用或 Agent 宿主猜测，也不提供常规身份切换器 |
| D-188 | 本地实例记录以 immutable `instance_id` 为稳定主键，API 地址是可显式 rebind 的安全元数据 | Confirmed | 用户于 2026-08-28 明确确认。域名变化不搬移或复制 Credential；但 `instance_id` 只用于定位记录，不能单独授权向任意新地址发送 Bearer secret。已信任 origin 返回不同 ID 时停止；新 origin 声称已有 ID 时，在任何认证请求前展示旧/新地址和影响并取得明确 rebind 授权，成功后原子更新该实例的 trusted API origin 与本地 receipt。只改变 Invite/展示域名而 canonical API origin 未变时无需 rebind |
| D-189 | Repo 推荐工作范围可使用单个非秘密 scope 文件；Invite 兑换或 discover 不自动创建或修改它 | Confirmed | 用户于 2026-08-28 明确确认。文件名为 Repo 根目录 `.cfkanban-scope.json`，只保存 schema version 和一个或多个 `instance_id + workspace_key + project_key` target，不保存 Credential、API origin、绝对路径、Git metadata、role 或权限快照。Skill 提供显式创建/合并 helper 并拒绝覆盖不兼容配置；何时调用、如何选择 targets、是否提交 Git 由上层决定 |
| D-190 | Project filter 是已知工作上下文中的强烈推荐能力，Skill 提供可覆盖的 scope 解析顺序 | Confirmed | 依据用户此前“Project filter 强烈推荐”的要求并按 D-203/D-204 修订。推荐顺序为“本次显式 Project targets → Repo scope targets → 无过滤聚合并提示范围扩大”；Repo 中多个 target 平级且不保存优先级/last-used。API 允许一个、多个或省略 filters，并返回 resolved scope；Skill 暴露失效 target 和范围警告，但不替上层作最终选择或拒绝合法聚合读取 |
| D-191 | “找工作”只读；“开始/接手”可授权 Agent self-assign，并按需推进到 `in_progress` | Superseded | 用户随后指出何时以及如何组合 Issue 动作属于上层 Agent 的能力与协调方式，不应由 cfKanban 解释自然语言后规定。由 D-195 的能力层边界替代；assign-to-me、状态转换和候选读取仍是独立服务能力 |
| D-192 | 所有 Issue 使用实例级全局 `CFK-<正整数>` 引用号，不再使用 Project key 作为前缀 | Confirmed | 用户于 2026-08-28 明确要求固定 `CFK`，认为按 Project 前缀会增加引用负担。每个部署实例共享一条单调递增、允许空洞且永不复用的 Issue number 序列，canonical identifier 为 `CFK-1`、`CFK-2`；因此在实例内唯一。不同实例可各自出现 `CFK-123`，由 `instance_id` 消歧。Project key 只用于 Project scope，不参与 Issue identifier |
| D-193 | 默认 Agent context pack 保留核心事实并有界返回最近 10 条评论，任何裁剪都必须可继续读取 | Confirmed | 依据 64 KiB 上限、Agent token 友好和常规规则授权于 2026-08-28 收敛。identifier、归属 scope、version、status、priority、assignee、blocked 与 allowed actions 永不因历史过长而消失；正文、Project context、关系和评论按有界 section 返回。默认最多 10 条最近可见评论并按时间正序呈现；超限先裁旧评论和低相关关系，响应明确 truncated sections、遗漏计数与 continuation，不抓取外部 artifact |
| D-194 | 执行已授权 Issue 时，由 cfKanban Skill 规定 Agent 可自主记录哪些进度或阻塞 | Rejected | 用户于 2026-08-28 指出这属于上层 Agent 的能力与协调方式。cfKanban 只提供 Comment、Relation、report/clear blocked、assignment、status、complete 等受权限和并发约束的原子能力，不判断何时调用或什么内容“值得”记录 |
| D-195 | cfKanban Issue 协作层是能力提供者，不是上层 Agent 的最终工作流协调器 | Confirmed | 用户于 2026-08-28 明确确认边界并随后补充：Service 定义动作语义、输入校验、权限、并发、幂等、审计和读取结果；Skill 除了说明能力、参数、后果与恢复，也必须提供可覆盖的推荐默认和常用范式。上层决定何时调用、如何组合和是否采纳建议；cfKanban 不把推荐或自然语言触发词写成服务端强制合同 |
| D-196 | assignment 与交接 Comment 是两个独立原子能力，服务端不要求 handoff summary | Confirmed | 依据 D-183 与 D-195 的简单能力边界直接收敛。assignment 只更新 assignee 并校验目标资格/version；调用方需要交接说明时另行创建普通 Comment。服务端不捆绑两次写入、不判断是否需要评论，中途失败按各自结果恢复 |
| D-197 | complete/reopen 的调用时机属于上层编排；服务只强制完成与重开各自的领域不变量 | Confirmed | 依据 D-101 与 D-195 直接收敛。任何有效 writer 均可调用 complete，不以 assignee 作为权限门槛；complete 原子追加不可变 completion Comment 并转 done。reopen 显式改状态且保留历史。响应返回当前 assignee 等事实，但服务和 Skill 不规定何时自动完成、警告或重开 |
| D-198 | Workspace、Project 与 Project Invite 提供显式原子能力，不规定上层 Agent 的最终预览、确认或消歧策略 | Confirmed | 依据 D-195 修订。服务校验 Owner 权限、显式目标、字段、幂等和不变量；Workspace/Project key 创建后不可变，Invite 请求必须逐项携带 `reader | writer`。Skill 可以提供 key、role 和安全处理的推荐默认，但不能把建议伪装成服务端字段默认或替上层作最终授权判断 |
| D-199 | Project scope 是可选读取过滤能力；单项写入请求必须携带其所属的一个明确 Project，目标解析属于上层编排 | Confirmed | API 允许按一个或多个 Project 过滤，也允许在授权范围内省略过滤；Skill 强烈推荐在已知工作上下文中传入 Project filters，并返回 resolved scope。Repo scope 文件只是非秘密候选配置，不能成为服务端授权或强制默认。创建 Issue 等单项写入的 wire contract 只接受一个明确 Project；cfKanban 不决定上层如何选出它 |
| D-200 | Event cursor 的持久化时机与生命周期属于上层编排；服务只定义 opaque、scope-bound 的增量读取合同 | Confirmed | cursor 不是 Credential，不能跨 Principal 或不兼容 scope 复用。服务检测 scope/授权变化并返回结构化 mismatch；Skill 说明保存格式、校验与重新快照能力，但不规定每个 Agent 会话是否自动持久化 cursor |
| D-201 | Vectorize、Workers AI、Queues、R2、DO 都属于可选增强 | Deferred | 先验证核心工作流与真实瓶颈 |
| D-202 | 面向互不信任组织的公共多租户 SaaS、成员与计费、Cycle/Initiative | Deferred | 多 Workspace 不等于公共 SaaS；当前没有产品证据，不进入 v0 |
| D-203 | Agent Guidance 是 cfKanban 的一等产品表面，与服务强制合同和上层最终决策分层 | Confirmed | 用户于 2026-08-28 补充确认：不能因为工作决策属于上层，就删除上层必须知道的默认建议、本地约定和安全用法。面向 Agent 的信息统一分为 Service/安全脚本强制的 MUST、Skills 提供且可覆盖的 SHOULD、用户/宿主/Repo/编排最终 DECIDES；相关 `SKILL.md` 必须直接携带简短全局合同与高频建议，详细内容再路由到包内 references |
| D-204 | 首版 Agent Guidance 固定包含本地状态位置、Invite role 建议、Project filter 建议和原子组合范式 | Confirmed | 用户明确举例确认。用户级状态根为当前环境 home 下 `.cfkanban/`，Repo scope 为非秘密 `.cfkanban-scope.json`；Invite role 按“明确上层 role → 推荐 writer”解析，明确只读即 reader，API 始终显式提交；Issue 查询 scope 推荐“本次显式 targets → Repo scope → 无过滤并提示扩大”；Skill 说明幂等/readback 安全组合范式，上层仍可按更具体规则覆盖 |
| D-205 | Principal Recovery Invite 创建时固定不可互换的 `rotation | full_recovery` mode，并按稳定 principal ID 绑定 | Confirmed | 用户于 2026-08-28 明确同意。Owner 可按 ID、名称文本和 Project membership 查找候选，但创建只接受 principal ID；Skill 在一次明确授权前展示身份/Grant/assignee/Credential 非秘密摘要和撤销范围。`rotation` 要求旧 Credential 证明且只撤销该凭据；`full_recovery` 以一小时 Bearer Invite 授权并撤销全部先前 Credential；兑换现场不能自动切换模式 |
| D-206 | v0 通过显式 `deleted=only` tombstone 视图提供恢复候选，不设“最近删除”专用端点或批量恢复 | Confirmed | 依据用户对普通规则的授权按简单、原子、Agent 友好原则收敛。已知稳定标识可直接读取，否则有恢复权限的调用者分页查询按 `deleted_at` 倒序的有界摘要；只列资源自身 tombstone，不把父容器暂停展开为子资源删除；每次恢复仍是一个显式原子写操作 |
| D-207 | v0 以完整 D1 SQL + manifest、本地隔离演练和部署外 break-glass 手册作为最低自托管恢复合同 | Superseded | 用户曾于 2026-08-28 确认，随后从用户场景重新评估并明确取消完整导出与整库恢复产品能力；由 D-213 替代 |
| D-208 | 首发固定 `cfkanban / cfkanban-admin / cfkanban-deploy` 三个工作场景 Skill | Confirmed | 用户于 2026-08-28 明确认可三类场景，并要求默认入口去掉原候选名的 `-work` 后缀，使其明显区别于两个特殊入口。`-admin` 表示 Owner 应用管理，`-deploy` 表示 Cloudflare 控制面；三者不是 Agent 类型、Principal kind 或 role，同一 Agent 可按任务和真实权限调用不同入口 |
| D-209 | immutable release manifest 是具体版本真相源，并分别固定 Skill bundle 与 Service deployment bundle | Confirmed | 用户于 2026-08-28 明确同意。stable pointer 只用于发现，安装/部署/升级计划必须固定 manifest/version/digest；已安装 Skill 和用户级缓存只是可验证执行副本，不能取代 manifest。repo clone 是开发源码，只能用于明确的非 canonical 源码试验；普通 stable 部署不得从当前工作树或业务 Repo 隐式取材。本地 Skill update 与云端 Instance upgrade 继续独立 |
| D-210 | 首次部署默认零参数生成 strict-zero 计划，只有结果性偏差才询问 | Confirmed | 用户于 2026-08-28 明确同意。单一 account/profile 明确时，Agent 自动解析 stable deployment bundle、提议无冲突资源名，并生成 bindings、非秘密 IDs/operation/幂等/journal 等值；计划只声明 Owner Credential 生成/保存策略，secret 在授权后直接落入受限文件。人类一次授权完整 plan，不填表或逐字段确认。只有 account 歧义，或 custom domain、付费能力、数据地域/合规、非 stable/源码试验等偏差才请求最少输入；未知资源不接管，默认改提新名称 |
| D-211 | v0 发行信任采用官方 HTTPS、不可覆盖版本清单、SHA-256 文件指纹和来源连续性，不引入独立签名 | Confirmed | 用户于 2026-08-28 在中文解释后明确认可。首次安装信任 canonical HTTPS；manifest 只能发布新版本，逐工件固定允许来源和文件指纹；本地 receipt 记录 publisher/origin/manifest/digests，更新或降级发现来源变化必须停止。marketplace/plugin 不能覆盖官方来源，安装、更新和降级不自动执行。该机制不防 canonical publisher 整体失陷；独立签名及密钥轮换/撤销后置到公共分发、自动更新或托管分离出现时再评估 |
| D-212 | Foundation SPEC 与 Agent Skills & Bootstrap SPEC 同时冻结 | Confirmed | 用户于 2026-08-28 在冻结就绪度审查后明确同意。两份文档状态改为 Frozen：前者固定 Foundation 级领域、权限、并发、资源层级与 HTTP 语义，后者固定公共 Agent 体验、发行、部署、凭据与恢复安全边界。完整 OpenAPI 字段、D1 DDL/索引、具体 Skill/npm/路径及实现代码不在本次冻结范围；冻结不授权实现、Linear 写入、部署、迁移、提交或推送 |
| D-213 | v0 取消完整 D1 导出、导入、本地恢复演练和整库灾难恢复产品能力 | Confirmed | 用户于 2026-08-28 从用户场景重新评估后明确要求移除。`cfkanban-deploy` 只负责部署、升级、检查和 migration 安全；migration 前仍可记录 Cloudflare restore point/bookmark 作为平台证据，但 Skill/API 不提供 export/import/Time Travel restore/SQL restore 能力或手册。业务资源的单项 soft-delete restore、Principal Recovery Invite 与失败后的幂等恢复不受影响 |
| D-214 | 后期检索增强优先采用可选 Cloudflare Vectorize 派生索引 | Confirmed | 用户于 2026-08-28 明确这是长期计划。v0 不启用 Vectorize，也不把向量索引作为权限、CAS、唯一约束或核心事实源；后期可由已提交 Event 异步构建并允许重建，失败或关闭时回退到 D1 结构化过滤与基础 title 搜索。Workers AI embedding、费用、同步延迟和具体检索语义在进入对应版本时另行冻结 |
| D-215 | v0 必须提供同实例托管的极简第一方 Web UI | Confirmed | 用户于 2026-08-29 明确指出 Agent-first 不等于 Agent-only。Web UI 面向 Owner 的简单维护和参与者的直接 Kanban 查看/轻量参与；`reader` 只读，`writer` 提供常用 Issue 增删改、状态、assignment、Comment、Label、Relation、complete/reopen 等与 API 权限一致的原子能力。UI 必须保持功能、视觉和代码简洁，不发展批量操作、自定义工作流、复杂报表、实时协同或第二套领域逻辑 |
| D-216 | Web 登录采用 Agent 签发一次性 Browser Launch URL 并兑换 HttpOnly Session | Confirmed | 用户于 2026-08-29 明确认可。浏览器不读取 `~/.cfkanban/`，不要求粘贴长期 Credential，也不把长期 Credential 放入 URL、localStorage 或页面脚本可读存储。已认证 Agent 为明确 target 创建短期一次性 launch capability；浏览器 POST 兑换为 `HttpOnly + Secure + SameSite` Session。TTL、session 绑定/撤销与 scope 后由 D-217 固定；CSRF 仍在 Web/API Draft 收敛 |
| D-217 | Browser Launch 固定 5 分钟一次性，Web Session 固定 8 小时并绑定源 Credential 与 target scope | Confirmed | 用户于 2026-08-29 在确认过期/刷新体验后同意继续，并由 D-219/D-222 修订。Session 不滑动续期且无 refresh token；源 Credential revoke 或 Session 显式 revoke 立即失效，Project Grant 逐请求校验。Project/Issue launch 只允许访问对应 Project；Owner `admin` launch 进入实例级管理与数据面但默认不自动查询全部 Issue。过期后页面不接受长期 Credential，只引导用户让 Agent 重新创建 launch |
| D-218 | v0 Web Board 不做拖拽、autosave、富文本、乐观成功或批量操作 | Superseded | 用户重新评估后认为五列拖拽和落列即保存是常用 Kanban 能力；由 D-220 替代。无批量操作、无手工 rank、无 WYSIWYG 和不自动重放失败写入仍保留 |
| D-219 | v0 移除 Principal disable/enable/delete | Confirmed | 用户于 2026-08-29 明确同意。Owner 使用 Credential revoke 停止认证、Grant revoke 停止某 Project 权限、Recovery Invite 恢复同一身份；Principal、assignment 与历史引用保持稳定。移除全局 disabled 状态轴，避免重新启用时旧 Credential 是否复活的复杂安全语义 |
| D-220 | v0 Web Board 支持五列拖拽并在落列后立即保存状态 | Confirmed | 用户于 2026-08-29 明确要求保留常用拖拽能力。拖到非 done 列立即发起单 Issue CAS 状态写入；卡片显示 saving，服务确认后才算成功，失败或冲突回到服务端真实列。拖入 done 自动路由到 complete 合同；若没有必填 summary，先显示极简完成框，提交后才落列，取消则回原列。正文与评论支持安全 Markdown 渲染，但不引入 WYSIWYG |
| D-221 | Web 不管理 Owner Credential 生命周期，Owner 正常轮换由 Agent 安全完成 | Confirmed | 用户于 2026-08-29 明确确认防锁死边界。Owner Web Session 可以查看 Owner Credential 非秘密摘要，但不能撤销或轮换任何 Owner Credential；Web 只允许 Owner 撤销参与者 Credential。`cfkanban-admin` 先在受限本地文件生成并保存替代 Owner Credential，再通过 Bearer-only 原子 rotation 建立新凭据并撤销当前旧凭据，最后验证并切换本地槽位；全部 Owner Credential 丢失仍只走 `cfkanban-deploy` 的部署外同 Principal 恢复。因此不存在从 Web 撤销当前或最后一个 Owner Credential 的路径 |
| D-222 | Owner `admin` Web Session 可以显式进入实例内任意 Project 数据面 | Confirmed | 用户于 2026-08-29 明确同意。`admin` target 本来就是唯一 Owner 的实例级 scope，因此同一 Session 可以使用 Owner 的隐式数据面权限进入任意 Workspace/Project 看板；默认落在 Overview，不自动读取全部 Issue，必须显式选择 Project。普通 Project/Issue launch 仍限定单一 Project，参与者不能获得该范围 |
| D-223 | 未认证实例首页提供产品介绍和可复制的 Agent 部署话术 | Confirmed | 用户于 2026-08-29 明确提出人类直接打开网站时的首页方向。页面中央提供指向 canonical bootstrap document 的短话术与复制按钮，不嵌入安装脚本或 secret；部署实例还清楚标识这是一个独立实例，并为后续登录和单 Project Public Join 保留入口。canonical 项目站点不显示任何实例私有数据 |
| D-224 | 首次 Agent 登录后可注册 Passkey，供人类后续直接登录 | Confirmed | 用户于 2026-08-29 明确认可 SB-30。Passkey 是 v0 唯一免 Agent 直登方法：首次/补充登记要求 Agent-launch Session，后续认证只签发固定 8 小时 Web Session，不创建 API Credential、Grant 或 refresh token。允许同 Principal 多个认证器并支持本人列举/撤销、Owner 撤销参与者认证器；撤销只使其来源 Sessions 失效。RP ID/domain 变化或丢失时回到 Agent Browser Launch |
| D-225 | 大团队加入与公开试用拆成 Team Join Link 与 Public Join Offer | Rejected | 用户于 2026-08-29 认为 Team Join 携带多个 Project 授权过重，明确不采用；不再保留 Team Link、群组入口或一次授予多个 Project 的公开能力 |
| D-226 | 自助加入只保留单 Project Public Join，访客选择公开 Project 与 reader/writer | Confirmed | 用户于 2026-08-29 明确确认。Owner 可逐个 Project 开关 Public Join，并同时公开多个 Project；访客每次选择一个 Project 和一个 `reader|writer`，只执行一条 Project Grant 的原子 self-join。公开 writer 风险必须在 Owner 启用时明确提示，但系统不静默收窄为 reader。普通一次性 Invitation 保持不变；撤权后重入由 D-227 固定，资源上限由 D-228/D-229 分层收敛 |
| D-227 | Public Join 不建立逐 Principal 重入阻止；公开期间撤权者可以再次加入 | Confirmed | 用户于 2026-08-29 明确认为重入阻止会把事情复杂化。Owner 若不希望任何人继续自助加入，应关闭该 Project 的 Public Join；单独撤销 Grant 只撤销当前授权，不创建 blacklist/denylist。相同 Principal 再加入复用同一 Grant 行，不创建重复身份或授权记录 |
| D-228 | 开启 Public Join 前，Owner 必须显式设置 Project Issue 与 Comment 存储行数上限，删除不释放额度 | Superseded | “必须设置 Issue/Comment 上限”继续有效，但用户于 2026-08-29 明确否决 tombstone 永久占用额度；由 D-230 的 active resource quota 替代 |
| D-229 | Public Join Project 必须同时设置 Principal 数量上限 | Confirmed | 用户于 2026-08-29 明确确认 Issue、Comment、Principal 三项都必填。Principal quota 统计 Project 当前 active 非 Owner Grants，不区分 Invitation/Public Join 来源；Grant revoke 释放、regrant/self-join 重新占用，role change 不改变数量。Public Join 创建新身份/Grant 与 quota 校验必须原子，满额不能留下孤立 Principal/Credential |
| D-230 | Public Project 三项 quota 都按当前 active 资源计数，soft delete/revoke 释放、restore/regrant 重新占用 | Confirmed | 用户于 2026-08-29 明确认为删除不释放会让 Project 永久无法新增。Issue soft delete 释放一个 Issue slot，并释放其当前有效 Comments 对 Comment quota 的占用；Comment soft delete 释放一个 Comment slot；Grant revoke 释放一个 Principal slot。restore/regrant 必须重新校验并占用，满额时原子失败。completion comment 永不可删除，并在所属 Issue active 时占用；active quota 只限制当前工作集，不声称回收 D1 tombstone 存储 |
| D-231 | 请求频率门控采用 Owner 可见、全局可设置的实例级配置 | Confirmed | 用户于 2026-08-29 明确要求限流不能对 Owner 完全不透明。至少呈现单 Principal 与实例总请求门槛，并补充未认证/Public Join 路径门槛；返回稳定 429、Retry-After 和当前生效策略摘要。精确业务 quota 仍由 D1 强制；边缘限流只抵御部分恶意请求。配置载体与默认档位已经由 D-232 进一步固定 |
| D-232 | v0 使用原生 Workers Rate Limiting 部署配置，并随首次部署提供零参数默认档位 | Confirmed | 用户于 2026-08-29 接受限流通过 `cfkanban-deploy` 更新 Worker 配置，并要求首次部署已有正常业务可用值。初始档位固定为：单 Principal 动态 API 120 次/60 秒、实例全部动态 API 300 次/60 秒、未认证敏感操作 30 次/60 秒；静态资产不进入应用限流。每个请求按适用门控叠加检查，429 携带 Retry-After。Owner Web 只读展示实际部署值和配置来源；修改必须作为显式 deployment plan delta，发布配置但不执行 D1 migration。原生计数仍按 Cloudflare location 近似维护，不能承诺严格全球总量 |
| D-233 | 服务端错误与 Cloudflare 边缘失败采用统一分类、分层归一化的错误合同 | Confirmed | 用户于 2026-08-29 指出限流、业务配额和 Cloudflare 配额错误必须让 Web 与 Agent 得到一致可操作提示。进入 Worker 的错误统一返回 JSON envelope、机器 code/category/source、request ID、retryable/recovery 和可选 Retry-After；Project active quota、应用限流、D1 平台 quota 分别使用稳定类别。Worker 免费日请求上限等可能在代码执行前由 Cloudflare 返回 1027/HTML，服务端无法包装；Web/Skill 客户端必须把已知边缘响应归一化为同一错误结果模型并标记 `source=cloudflare_platform`，不能把本地归一化伪装成 OpenAPI JSON 响应，也不能依赖供应商自然语言文案分支 |

## 需要显式修订的决策

Foundation 的领域与服务端公共技术选择、Agent-first Storyboard 及首发 Skill/部署体验已经完成第一轮收敛，两份 SPEC 已于 2026-08-28 按 D-212 冻结、按 D-213 形成修订 2，于 2026-08-29 依次形成修订 3～11，并按 D-233 形成修订 12，固定统一错误分类与 Cloudflare 边缘失败的客户端归一化边界。Web UI 和 API/Schema 仍为 Draft，不因此获得实现授权。
