# cfKanban

[English](README.md) | 简体中文

面向 Coding Agents 的极简、API-first Cloudflare Kanban。它更接近一个“可靠的 Agent 工作协调账本”，而不是去掉 UI 的传统项目管理工具。

> 当前状态：Foundation 与 Agent Skills 合同已冻结到修订 12；极简 Web UI 和 API / D1 Schema 合同仍在 Draft 收敛。仓库里只有文档，没有业务代码，也没有已授权的实现计划。

## 产品原则

- Agent 是默认操作主体；人类表达目标并在重要副作用前授权，Agent 负责读取 Skill、判断、执行、恢复和汇报。
- 保留 Kanban 核心：Project、Issue、状态、优先级、标签、评论、依赖和历史。
- 默认以 Cloudflare 免费层可运行，付费服务只增强能力，不能成为核心依赖。
- 追求少组件：MVP 先用 Workers + D1；不用为了“用上 Cloudflare”而引入 KV、Durable Objects 或 AI。
- v0 必须有极简第一方 Web UI，服务人类直接查看 Kanban、轻量参与 Issue 和 Owner 简单维护；它复用同一 API 并保持刻意克制。

## 当前产品合同

- 一个部署者控制的部署实例可以包含多个 Workspace，一个 Workspace 可以包含多个 Project。
- 每个部署实例只有一个 Deployment Owner；只有 Owner 能创建 Workspace/Project，并邀请 Principal 加入 Project 或变更 Project Grant。
- Owner 无需 Project Grant，天然拥有全部 Project 的读写能力；Owner 是部署级身份，不是第三种 Project role。
- 实例不设置第二管理员，Owner 身份不支持转移；Credential 轮换或恢复不能改变 Owner Principal。
- 首次部署只展示一次 bootstrap Credential；Owner Credential 全部丢失时，仅允许掌握 Cloudflare 部署权限的人通过部署外受控 Skill 脚本为同一 Owner Principal 重新签发。
- Credential 只认证一个 Principal 身份；同一 Principal 可以通过多个 Project Grants 访问分布在不同 Workspace 的多个 Project。
- 非 Owner 参与者在每个 Project 上只有 `reader` 或 `writer`；权限不从 Workspace 继承，`writer` 包含 Project 内容的创建、修改、软删除和恢复，不设置独立 delete role。
- `writer` 的删除与恢复范围只包含 Project 内容；Workspace/Project 容器只能由 Owner 软删除和恢复。
- Project 是工作协调命名空间，不等同于代码仓库；同一 Repo 可以关联多个 Project，一个 Project 也可以涉及多个 Repo。
- Issue 可以分配给一个 Agent 或人类 Principal；assignee 只表示当前负责人，不产生独占执行权或额外权限，其他 `writer` 仍可协作修改。
- blocked 与 status 正交：Issue 保留原工作阶段，通过未完成依赖或人工原因形成 `is_blocked` 投影。
- Owner 通过一条可复制的短期一次性 Invite URL 邀请参与者；普通 Project Invite 固定有效 7 天，Principal Recovery Invite 固定有效 1 小时。接收方把 URL 交给自己的 Agent，Skill 复用本地身份或通过内置脚本创建新 Principal/Credential，并原子兑换对应 Project Grants。
- v0 workflow 固定为 `backlog / todo / in_progress / done / canceled`；Project 只能覆盖显示名称且仅 Owner 可修改。Owner 或 Project `writer` 可在固定状态间任意显式转换和 reopen，写入使用 version/CAS 并记录 Event。
- Issue 只能分配给 Owner 或目标 Project 的有效 `writer`；撤权后保留原 assignee 引用，并通过 `assignee_available=false`、`needs_reassignment=true` 提示显式重新分配。
- Invitation 明确分为普通 Project Invite 与绑定既有 Principal 的 Recovery Invite；只有 Owner 能创建，参与者不能自行签发额外 Credential。
- complete 原子追加结构化、不可变且不可删除的 completion comment 并转为 `done`；reopen 保留旧记录，再次完成追加新记录。
- v0 Issue 关系固定支持 `blocks / parent / related / duplicate`，允许同一 Workspace 内跨 Project、禁止跨 Workspace；跨 Project 写入要求同时拥有两端 `writer`，关系不自动改变状态或权限。
- v0 先提供确定性候选列表和显式 assign/assign-to-me，不首发原子 assign-next；上层 Agent 可以按用户意图与本地规则组合这些原子能力。
- v0 包含由同一实例托管的极简第一方 Web UI，复用 REST 权限、version、幂等和审计合同，提供 Project 看板、常用 Issue 轻量操作和 Owner 简单维护；仍不发布独立 cfKanban CLI。
- Web 看板支持在固定五列间拖拽单张卡片并以乐观并发控制立即保存状态；拖入 `done` 自动使用原子 complete 合同。正文和 Comment 使用 Markdown 源码编辑与安全渲染，不提供多卡拖拽、手工 rank 或 WYSIWYG。
- 已认证 Agent 为明确 Project、Issue 或 Owner target 创建固定 5 分钟、一次性的 Browser Launch URL；浏览器兑换固定 8 小时、target-scoped、无滑动续期和 refresh token 的 HttpOnly Session，源 Credential 撤销时同步失效。长期 Credential 不进入 URL、页面脚本、localStorage 或 sessionStorage；应用内浏览器只是宿主便利能力，不是协议依赖。
- 首次 Agent Launch 后，Principal 可以登记 Passkey 供后续直接登录 Web。Passkey 只认证 Web，不是 API Credential 或 Grant；Agent Launch 始终保留为恢复入口。
- Owner 可以通过 Public Join 同时公开多个 Project；访客每次选择一个 Project 和 `reader | writer` 后原子加入。v0 不提供 Team Join 或多 Project 公开授权。
- 开启 Public Join 前必须显式设置 Project 的 Issue、Comment、非 Owner Principal 三项 active limits。软删除或撤销 Grant 会释放活跃额度，恢复或重新授权会再次占用。UI 可建议 50/500/50，但 API 没有静默默认。
- 请求频率门控是 Owner 可见的部署配置。零参数首次部署提供单 Principal 认证 API 120 次、实例动态 API 300 次、未认证敏感操作 30 次的每 60 秒档位；调整时由 `cfkanban-deploy` 发布 Worker 配置，不执行 D1 migration。它只提供按 location 的近似抗滥用保护，精确业务 quota 仍由 D1 强制。
- Web 与 Agent 共用机器可读的错误模型，明确区分业务 quota、应用限流、D1 平台额度和平台故障。Worker 执行前产生的 Cloudflare 错误由客户端显式归一化，不能伪装成 cfKanban/OpenAPI JSON。
- v0 提供按权限过滤的部署级跨 Workspace/Project Issue 聚合读取；Project filter 可以省略，但 Skill 在已知上下文时强烈推荐传入一个或多个明确 Project，避免无关项目噪声。
- Project Grant 不设置失效日期；每个 Principal/Project 只有一条当前记录，只能由 Owner 显式变更角色、撤销或重新授予。Invitation 自身仍有独立的短期有效期。
- Issue priority 固定为 `none / low / medium / high / urgent` 且默认 `none`；v0 不保存手工 rank，候选按 priority 后 FIFO 稳定排序。
- 非幂等创建/命令强制携带 `Idempotency-Key` 并保留 24 小时；结构化错误提供稳定 `code`、`retryable` 和 `recovery`，供 Agent 确定恢复动作。
- 普通 Comment 追加后不可原地编辑，可软删除/恢复；纠错追加引用旧 Comment 的新记录。completion comment 继续不可编辑或删除。

Credential 与 Project Grant 都不自动过期。Credential 只通过显式撤销、轮换或 full recovery 中的撤销失效；Grant 只通过显式角色变更、撤销或重新授予改变。Invitation 是唯一自动过期的 bootstrap 能力；v0 不提供 Principal disable/enable/delete 生命周期。

v0 使用有界资源合同：请求最大 128 KiB、Issue body 64 KiB、Comment/completion 32 KiB；列表默认 20、最大 100，Agent context 最大 64 KiB。大日志和附件使用外部 artifact 引用。

Foundation SPEC 与 Agent Skills & Bootstrap SPEC 已冻结到合同修订 12，包含极简 Web、Browser Launch/Session、Owner Credential 防锁死、Owner admin Session 范围、Passkey 直登、单 Project Public Join、简单重入、三项 active quota、带默认档位的透明限流部署配置和分层错误归一化；冻结仍不授权实现。CSRF 细节，以及完整 HTTP/OpenAPI 字段、D1 DDL、索引和原子写入配方仍在 Draft 收敛。软删除数据的长期物理保留策略继续延后；v0 不提供公开硬删除 API，也不提供完整 D1 导出、导入或整库灾难恢复能力。

## 文档入口

- [文档导航](docs/README.md)
- [产品简报](docs/product/product-brief.md)
- [用户使用 Storyboard](docs/product/user-storyboard.md)
- [Foundation SPEC](docs/specs/2026-08-26-agent-native-kanban-foundation-spec.md)
- [Agent Skills & Bootstrap SPEC](docs/specs/2026-08-28-agent-skills-bootstrap-spec.md)
- [极简 Web UI SPEC](docs/specs/2026-08-29-web-ui-spec.md)
- [API & D1 Schema SPEC](docs/specs/2026-08-28-api-schema-spec.md)
- [Cloudflare 架构基线](docs/architecture/cloudflare-baseline.md)
- [Cloudflare 平台快照](docs/research/cloudflare-platform-snapshot-2026-08-28.md)
- [Agent Skill 平台快照](docs/research/agent-skill-platform-snapshot-2026-08-28.md)
- [Roadmap](docs/project/roadmap.md)
- [决策登记表](docs/project/decision-register.md)
- [待讨论问题](docs/project/open-questions.md)
- [Linear 协作约定](docs/project/linear.md)

## 项目跟踪

Linear 项目：[cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f)。

Linear 只保存执行状态；产品与技术合同仍以仓库文档为准。目前没有为了填满看板而批量创建实现 Issue。
