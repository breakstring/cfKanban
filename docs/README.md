# cfKanban 文档导航

## 状态语义

- `Draft`：讨论基线，允许重写，不代表实现授权。
- `Frozen`：经用户确认的稳定合同，可供实现引用。
- `Superseded`：已被后续文档替代，只保留历史。

没有状态标记的参考文档仅提供事实或导航，不自动成为产品合同。

## 产品与合同

- [产品简报](product/product-brief.md)：产品为何存在、为谁服务、MVP 与非目标。
- [用户使用 Storyboard](product/user-storyboard.md)：从首次部署到日常协作与恢复的逐卡产品验收故事。
- [Agent-native Kanban Foundation SPEC](specs/2026-08-26-agent-native-kanban-foundation-spec.md)：已冻结的领域、身份、assignment、基础 API 语义和可靠性合同。
- [Agent Skills & Bootstrap SPEC](specs/2026-08-28-agent-skills-bootstrap-spec.md)：已冻结的 Skill 能力暴露、可覆盖 Agent Guidance、宿主兼容、跨平台 Node scripts、部署与凭据安全体验合同；不替上层 Agent 作最终工作决策。
- [API & D1 Schema SPEC](specs/2026-08-28-api-schema-spec.md)：已冻结的 v0 HTTP/OpenAPI、D1 schema、索引和原子写入合同。
- [Web UI SPEC](specs/2026-08-29-web-ui-spec.md)：已冻结的极简第一方 Web、Browser Launch/Session、参与者轻量操作和 Owner 维护合同。
- [Web 视觉设计合同](../DESIGN.md)：已冻结的 warm editorial workbench 颜色、排版、布局、组件状态与无障碍约束。
- [v0 Implementation Plan](plans/2026-08-29-v0-implementation-plan.md)：WP-01～WP-11 的范围、依赖、验收和停止条件；执行状态以 Linear 为准。

## 技术与研究

- [Cloudflare 架构基线](architecture/cloudflare-baseline.md)：稳定组件职责和演进边界。
- [Cloudflare 平台快照（2026-08-28）](research/cloudflare-platform-snapshot-2026-08-28.md)：易漂移的额度、定价和产品能力证据。
- [Agent Skill 平台快照（2026-08-28）](research/agent-skill-platform-snapshot-2026-08-28.md)：Codex/Claude Skill、Wrangler 与跨平台运行差异。
- [Web 认证与公开加入能力快照（2026-08-29）](research/web-auth-public-enrollment-snapshot-2026-08-29.md)：WebAuthn/Passkey、Cloudflare Access、Rate Limiting 与 Turnstile 的易漂移事实。
- [Cloudflare 缓存、协调与限流能力快照（2026-08-29）](research/cloudflare-cache-rate-limit-snapshot-2026-08-29.md)：Workers KV、Cache API、Durable Objects 与 Rate Limiting 的适用边界。
- [Cloudflare Worker 域名与实例发现能力快照（2026-08-29）](research/cloudflare-worker-domain-discovery-snapshot-2026-08-29.md)：Custom Domains、控制面枚举、第三方代理域名与本地 trusted origin 迁移边界。
- [Edgechat 架构与部署工程快照（2026-08-29）](research/edgechat-architecture-snapshot-2026-08-29.md)：同 Worker 的 Web/API 部署、Cloudflare 产品取舍、D1 migration 与 GitHub Actions 借鉴边界。
- [API / D1 合同验证快照（2026-08-29）](research/api-d1-contract-validation-2026-08-29.md)：OpenAPI、D1 schema、原子操作、Web 安全与错误归一化的实现前证据。

## 项目治理

- [Roadmap](project/roadmap.md)：方向真相和推荐顺序。
- [决策登记表](project/decision-register.md)：确认、建议和延后项。
- [待讨论问题](project/open-questions.md)：会实质改变合同的选择。
- [Linear 协作约定](project/linear.md)：在线项目绑定、真相边界和同步规则。

当前不采用独立 progress log。进入实现阶段后，再根据实际协作强度决定是否启用。
