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
- [API & D1 Schema SPEC](specs/2026-08-28-api-schema-spec.md)：仍在收敛的 v0 HTTP/OpenAPI、D1 schema、索引和原子写入 Draft 合同。
- `docs/plans/`：目前尚未采用；只有形成明确实现授权和实施配方后才创建。

## 技术与研究

- [Cloudflare 架构基线](architecture/cloudflare-baseline.md)：稳定组件职责和演进边界。
- [Cloudflare 平台快照（2026-08-28）](research/cloudflare-platform-snapshot-2026-08-28.md)：易漂移的额度、定价和产品能力证据。
- [Agent Skill 平台快照（2026-08-28）](research/agent-skill-platform-snapshot-2026-08-28.md)：Codex/Claude Skill、Wrangler 与跨平台运行差异。

## 项目治理

- [Roadmap](project/roadmap.md)：方向真相和推荐顺序。
- [决策登记表](project/decision-register.md)：确认、建议和延后项。
- [待讨论问题](project/open-questions.md)：会实质改变合同的选择。
- [Linear 协作约定](project/linear.md)：在线项目绑定、真相边界和同步规则。

当前不采用独立 progress log。进入实现阶段后，再根据实际协作强度决定是否启用。
