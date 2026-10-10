# cfKanban 文档导航

本目录保存工程合同与维护资料。面向使用者的双语文档源位于 [`apps/docs/`](../apps/docs/)，构建后通过站点 `/docs/` 阅读。

公开文档以 `apps/docs/catalog.json` 维护两级目录；新增或修改功能说明时同步 `en` / `zh-CN` 同名页面，并核对 Agent 提示词、权限和实际 Web 入口。`npm run docs:check` 检查目录、双语页面与链接，`npm run dev --workspace @cfkanban/docs` 预览文档，`npm run build` 将文档纳入同 Worker 工件。旧公开操作指南仍位于 `apps/web/public/`，其机器流程不在文档正文重复维护。

## 状态语义

- `Draft`：讨论基线，允许重写，不代表实现授权。
- `Frozen`：经用户确认的稳定合同，可供实现引用。
- `Superseded`：已被后续文档替代，只保留历史。

没有状态标记的参考文档仅提供事实或导航，不自动成为产品合同。

## 产品与合同

- [产品简报](product/product-brief.md)：产品为何存在、为谁服务、MVP 与非目标。
- [用户使用 Storyboard](product/user-storyboard.md)：从首次部署到日常协作与恢复的逐卡产品验收故事。
- [Web 视觉设计合同](../DESIGN.md)：颜色、排版、布局、组件状态与无障碍约束。

按任务读取相关基础合同及适用增量，不默认通读全部 SPEC。增量只在明确覆盖的范围内替代旧条款，其余约束继续有效；状态和具体语义以各文档本身为准。

### 基础合同

| 涉及范围 | 入口 |
| --- | --- |
| 领域、身份、权限、并发与原子操作 | [Agent-native Kanban Foundation](specs/2026-08-26-agent-native-kanban-foundation-spec.md) |
| HTTP、错误、OpenAPI、D1 schema 与索引 | [API & D1 Schema](specs/2026-08-28-api-schema-spec.md)；机器合同见 [`contracts/`](../contracts/) |
| Skills、bootstrap、宿主、凭据、部署与恢复 | [Agent Skills & Bootstrap](specs/2026-08-28-agent-skills-bootstrap-spec.md) |
| Web 交互、认证、Public Join、语言与域名迁移 | [Web UI](specs/2026-08-29-web-ui-spec.md) |

### 增量合同：容器与协作数据

| 涉及范围 | 入口 |
| --- | --- |
| 容器 UUID、API / URL / scope 寻址 | [容器 UUID](specs/2026-09-08-container-uuid-spec.md) |
| 归档、恢复、永久删除与历史保留 | [容器清理](specs/2026-09-08-container-purge-spec.md) |
| 附件、私有 R2、容量与清理 | [Issue 附件](specs/2026-09-19-issue-attachments-spec.md) |
| 项目里程碑、可选 Issue 归属和进度 | [项目里程碑](specs/2026-10-09-project-milestones-spec.md) |
| 工作区 / 项目 Issue 趋势、里程碑燃起图与历史回填 | [Issue 趋势](specs/2026-10-10-issue-trends-spec.md) |
| Issue 优先级、标签、负责人筛选与查询索引 | [Issue 结构化筛选](specs/2026-09-29-issue-query-filters-spec.md) |
| 活动与审计倒序历史、正序增量兼容与时间索引 | [活动历史倒序](specs/2026-10-01-event-history-order-spec.md) |
| 用量、限额与可选采集 | [用量统计](specs/2026-09-19-usage-statistics-spec.md) |
| Cloudflare 成本保护与用量口径 | [成本保护](specs/2026-10-07-cloudflare-cost-protection-spec.md) |
| Owner Cloudflare Secret 接入、限流管理与日度历史 | [Owner Cloudflare 管理](specs/2026-10-07-owner-cloudflare-control-spec.md) |
| Owner 实例公告、个人接收偏好、逐条确认与 Web/Agent 提醒 | [Owner 实例通知](specs/2026-10-01-instance-notifications-spec.md) |

### 增量合同：身份、管理与 Web Session

| 涉及范围 | 入口 |
| --- | --- |
| Principal 名称唯一性、规范化与人员解析 | [Principal 名称](specs/2026-09-20-principal-names-spec.md) |
| 工作区 / 项目管理员、权限继承、邀请与人数配额 | [分级管理员](specs/2026-09-20-scoped-administrators-spec.md) |
| Owner Credential 全失恢复 | [Owner 恢复](specs/2026-09-20-owner-credential-recovery-spec.md) |
| Owner 多设备、独立凭据与新电脑接入已有部署 | [多设备与部署接入](specs/2026-09-27-owner-devices-deployment-attachment-spec.md) |
| Owner 设备网页批准/撤销、已有本地身份切换与恢复 | [网页与身份切换](specs/2026-09-28-owner-device-web-identity-switch-spec.md) |
| 已登录参与者网页接受普通邀请、Bearer 本人 Passkey 管理 | [参与者邀请与 Passkey](specs/2026-09-28-participant-invitation-passkey-parity-spec.md) |
| 参与者 Web 项目切换与 Session 范围 | [参与者项目切换](specs/2026-09-19-participant-project-switching-spec.md) |
| 首页账户返回、本地闲置恢复、状态分组、父子进度与防环 | [导航与 Issue 层级](specs/2026-10-04-issue-hierarchy-navigation-spec.md) |
| Web 活动续期、绝对到期、多标签页和文字草稿恢复 | [Web Session 续期](specs/2026-10-01-web-session-renewal-spec.md) |

### 增量合同：公开内容与发行

| 涉及范围 | 入口 |
| --- | --- |
| Owner 可编辑的公开首页说明与缺省文案 | [首页实例说明设置](specs/2026-09-20-homepage-settings-spec.md) |
| 公开文档、双语手册、Agent 示例与静态打包 | [站内双语文档中心](specs/2026-09-29-documentation-center-spec.md) |
| API Catalog、Auth.md、Skills 发现归档、robots / sitemap、Content Signals 与 Markdown 协商 | [公开发现与 Agent 阅读](specs/2026-10-09-public-discovery-spec.md) |
| stable 发现、发行版本、工件与更新 | [正式发行生命周期](specs/2026-09-20-stable-release-lifecycle-spec.md) |
| Owner 站内版本发现与更新指引 | [版本与更新](specs/2026-10-06-owner-release-updates-spec.md) |
| 成功升级后可配置自动公告 | [升级通知](specs/2026-10-06-instance-upgrade-notifications-spec.md) |
| 公共 CLI、完整能力矩阵、命令与安装恢复 | [公共 CLI](specs/2026-10-04-public-cli-spec.md) |
| 本地 stdio MCP、DSH Skills / Host / 原生任务面板 | [本地 MCP 与 DSH 接入](specs/2026-10-02-local-mcp-dsh-spec.md) |
| 官方桌面插件 global / thread 工作台、MCP Apps bridge | [官方插件工作台（Draft）](specs/2026-10-04-codex-workbench-spec.md)、[验证计划](plans/2026-10-04-codex-workbench-plan.md) |
| Composer 编号/标题候选、轻量 Issue reference 与读取预算 | [Issue 引用（Draft）](specs/2026-10-05-codex-issue-mentions-spec.md) |
| 项目即时快捷候选、类型化标题/编号及兼容查询模式 | [项目搜索](specs/2026-10-06-project-search-spec.md) |
| 私有 SQLite、后台同步、授权范围增减与搜索游标 | [持久搜索索引（Draft）](specs/2026-10-05-persistent-search-index-spec.md)、[实施计划](plans/2026-10-05-persistent-search-index-plan.md) |

## Skills 与发行维护

- [Agent Skills 说明（English）](skills/README.md) / [简体中文](skills/README.zh-CN.md)：对外技能的职责、使用入口、安装与更新。
- [项目发版技能](../.agents/skills/project-release/SKILL.md)：维护者 RC/正式发行、stable 推进及默认测试实例升级流程，不对外分发。
- [GitHub Release 发布与恢复](release-publication.md)：源码维护者的工件准备、发布工具及恢复说明。

## 技术与研究

- [Cloudflare 架构基线](architecture/cloudflare-baseline.md)：稳定组件职责和演进边界。
- [Cloudflare 平台快照（2026-08-28）](research/cloudflare-platform-snapshot-2026-08-28.md)：易漂移的额度、定价和产品能力证据。
- [Agent Skill 平台快照（2026-08-28）](research/agent-skill-platform-snapshot-2026-08-28.md)：Codex/Claude Skill、Wrangler 与跨平台运行差异。
- [Web 认证与公开加入能力快照（2026-08-29）](research/web-auth-public-enrollment-snapshot-2026-08-29.md)：WebAuthn/Passkey、Cloudflare Access、Rate Limiting 与 Turnstile 的易漂移事实。
- [Cloudflare 缓存、协调与限流能力快照（2026-08-29）](research/cloudflare-cache-rate-limit-snapshot-2026-08-29.md)：Workers KV、Cache API、Durable Objects 与 Rate Limiting 的适用边界。
- [Cloudflare Worker 域名与实例发现能力快照（2026-08-29）](research/cloudflare-worker-domain-discovery-snapshot-2026-08-29.md)：Custom Domains、控制面枚举、第三方代理域名与本地 trusted origin 迁移边界。
- [Edgechat 架构与部署工程快照（2026-08-29）](research/edgechat-architecture-snapshot-2026-08-29.md)：同 Worker 的 Web/API 部署、Cloudflare 产品取舍、D1 migration 与 GitHub Actions 借鉴边界。
- [API / D1 合同验证快照（2026-08-29）](research/api-d1-contract-validation-2026-08-29.md)：OpenAPI、D1 schema、原子操作、Web 安全与错误归一化的实现前证据。
- [D1 读取优化验证（2026-10-02）](research/d1-read-optimization-2026-10-02.md)：schema 18 定向索引、读取成本、写入代价与权限/分页回归边界。

## 项目治理

- [Roadmap](project/roadmap.md)：方向、基线、推荐顺序与暂缓项。
- [决策登记表](project/decision-register.md)：确认、建议和延后项。
- [待讨论问题](project/open-questions.md)：会实质改变合同的选择。
- [`plans/`](plans/)：实施配方；[v0 Implementation Plan](plans/2026-08-29-v0-implementation-plan.md)保留 WP-01～WP-11 的范围、依赖、验收和停止条件，供历史参考。
- [cfKanban 协作约定](project/cfkanban.md)：当前执行入口、准确线上项目、真相边界与 Linear 历史迁移映射。

执行状态和完成证据保存在协作约定指向的 Issue 中，完成使用结构化 `complete`；不在仓库另建动态 backlog 或独立 progress log。Linear 仅保留历史来源。
