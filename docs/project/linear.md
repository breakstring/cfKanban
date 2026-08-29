# Linear 协作约定

- 采用模式：Linear 已启用
- 在线核验日期：2026-08-26
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

创建前已经按 `cfKanban` 和 `Agent Native Kanban` 查重，没有找到现有项目；创建后已按 Project ID 在线读回。

## 真相边界

- [Roadmap](roadmap.md)：方向、当前基线、推荐顺序和暂缓项。
- Linear：Issue、Milestone、负责人、优先级、排期、状态和执行评论。
- [Foundation SPEC](../specs/2026-08-26-agent-native-kanban-foundation-spec.md)：产品与公共技术合同。
- [决策登记表](decision-register.md)：确认、建议和延后决策。
- 当前不采用独立 progress log。

文档不复制 Linear 动态状态；Linear Issue 只链接必要的 SPEC/PLAN，不复制长篇合同。

## 当前在线快照

截至 2026-08-26 创建并读回时：

- Project status：Planned；
- Milestones：0；
- 实现 Issues：0。

这是核验快照，不是长期状态真相。后续状态必须在线读回，不能仅凭本段判断。

## Roadmap 映射

当前不把 R0–R6 自动创建成 Milestone。等 Foundation SPEC 冻结并确认真实交付阶段后，再决定哪些 Roadmap 方向需要 Linear Milestone。

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
