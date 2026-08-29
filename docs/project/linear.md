# Linear 协作约定

- 采用模式：Linear 已启用
- 在线核验日期：2026-08-29
- 机器绑定：[`.linear/project.json`](../../.linear/project.json)

## 已验证绑定

| 项 | 值 |
| --- | --- |
| Workspace | [KennZhang](https://linear.app/kennzhang) |
| Team | KennZhang / `KENN` |
| Team ID | `e0caa5d5-8cba-4fe1-b97b-dc0247e3312f` |
| Project | [cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f) |
| Project ID | `f530afb1-f9ce-4e67-9690-302cac532aa7` |
| Project status | Planned |
| Project lead | Kenn Zhang |

项目创建前已经按 `cfKanban` 和 `Agent Native Kanban` 查重。2026-08-29 在建立实现 backlog 前再次按固定 Workspace/Team/Project ID 读回，并确认当时 Milestone 与 Issue 均为 0。

## 真相边界

- [Roadmap](roadmap.md)：方向、当前基线、推荐顺序和暂缓项。
- Linear：Issue、Milestone、负责人、优先级、排期、状态和执行评论。
- [Foundation SPEC](../specs/2026-08-26-agent-native-kanban-foundation-spec.md)：产品与公共技术合同。
- [决策登记表](decision-register.md)：确认、建议和延后决策。
- 当前不采用独立 progress log。

文档不复制 Linear 动态状态；Linear Issue 只链接必要的 SPEC/PLAN，不复制长篇合同。

## 当前在线快照

截至 2026-08-29 冻结合同并建立执行范围后：

- Project status：Planned；
- Milestone：`v0 可部署闭环`；
- 实现 Issues：KENN-317～KENN-327 中属于本项目的 11 个 WP，全部为 Backlog、未分配、无排期；
- 依赖关系按 [v0 Implementation Plan](../plans/2026-08-29-v0-implementation-plan.md) 建立。

这是核验快照，不是长期状态真相。后续状态必须在线读回，不能仅凭本段判断。

## Roadmap 映射

R0～R6 不逐项复制成 Milestone。首个实现阶段只使用一个 `v0 可部署闭环` Milestone，承载由 Frozen 合同推导的 WP-01～WP-11；后续版本是否增加 Milestone 以真实交付证据决定。

Roadmap ID 只提供稳定方向锚点，不等于优先级或 Issue 编号。

## 写入规则

1. 首次操作先在线确认 workspace、team、project 和同名对象。
2. 讨论中的 Proposed 项不自动建实现 Issue。
3. 冻结方向后，Issue 按可独立交付和可验证的范围拆分，并链接 SPEC/PLAN。
4. 不把 Roadmap 整段机械复制成 backlog。
5. 创建、更新、关闭、评论或批量迁移属于外部写操作，按当前用户授权范围执行。
6. 不在仓库或 Linear 描述中保存 token、OAuth、cookie 或其他凭据。

## 工具不可用时

Linear 暂时不可用不阻塞本地产品讨论。只有项目已经明确采用、且确有待执行的 Linear 写操作时，才在下方建立短期 pending；恢复后逐条回放、在线确认并删除。

当前 pending：无。
