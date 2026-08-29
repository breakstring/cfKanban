# cfKanban v0 Implementation Plan

- 文档状态：Ready
- 日期：2026-08-29
- Roadmap：R1～R4 的首个可部署闭环
- Linear Project：[cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f)
- 产品合同：[Foundation SPEC](../specs/2026-08-26-agent-native-kanban-foundation-spec.md)（Frozen）
- Agent 合同：[Agent Skills & Bootstrap SPEC](../specs/2026-08-28-agent-skills-bootstrap-spec.md)（Frozen）
- API 合同：[API & D1 Schema SPEC](../specs/2026-08-28-api-schema-spec.md)（Frozen）
- Web 合同：[Web UI SPEC](../specs/2026-08-29-web-ui-spec.md)（Frozen）
- 视觉合同：[DESIGN.md](../../DESIGN.md)（Frozen）
- 验证基线：[API / D1 合同验证快照](../research/api-d1-contract-validation-2026-08-29.md)
- 实施授权：本计划与 Linear 任务获准建立；业务编码、部署和远端 migration 尚未开始

## Linear 映射

Milestone：[v0 可部署闭环](https://linear.app/kennzhang/project/cfkanban-567c4995296f/overview)

| Work package | Linear |
| --- | --- |
| WP-01 | [KENN-318](https://linear.app/kennzhang/issue/KENN-318) |
| WP-02 | [KENN-319](https://linear.app/kennzhang/issue/KENN-319) |
| WP-03 | [KENN-321](https://linear.app/kennzhang/issue/KENN-321) |
| WP-04 | [KENN-320](https://linear.app/kennzhang/issue/KENN-320) |
| WP-05 | [KENN-317](https://linear.app/kennzhang/issue/KENN-317) |
| WP-06 | [KENN-323](https://linear.app/kennzhang/issue/KENN-323) |
| WP-07 | [KENN-322](https://linear.app/kennzhang/issue/KENN-322) |
| WP-08 | [KENN-324](https://linear.app/kennzhang/issue/KENN-324) |
| WP-09 | [KENN-325](https://linear.app/kennzhang/issue/KENN-325) |
| WP-10 | [KENN-326](https://linear.app/kennzhang/issue/KENN-326) |
| WP-11 | [KENN-327](https://linear.app/kennzhang/issue/KENN-327) |

## 1. 目标

交付一套可以由用户的 Agent 安装、部署、更新和日常使用的 cfKanban v0：一个 Cloudflare Worker、一个 D1、同 Worker Static Assets、三个 portable Skills，以及足够人类查看和轻量参与的双语 Web UI。

完成标准不是“端点数量齐全”，而是下面的端到端闭环在真实环境可重复：

1. 新部署者的 Agent 从 canonical bootstrap 安装 Skills，生成 strict-zero plan 并部署 Worker/D1/Web；
2. Owner Agent 创建 Workspace/Project，创建 Invite；
3. 参与者 Agent 复用或创建本地 Principal/Credential，兑换 Project Grant；
4. Agent 创建、查询、分配、阻塞、评论、关联、完成和恢复 Issue；
5. 人类通过 Browser Launch 或 Passkey 打开 Web，看板拖拽和常用编辑复用同一 API；
6. Public Join、Project quota、Workers Rate Limiting、错误恢复、migration/readback 与升级边界可验证。

## 2. 实现边界

### 必须包含

- TypeScript monorepo，使用根级 npm lockfile 与统一 `npm run validate`；Node 支持范围沿用 release manifest 声明。
- Worker/API、D1 migrations、OpenAPI/contracts、Vue 3 + TypeScript + Vite Web、三个 Skills 和 release bundle 的明确目录边界。
- D1 单一事实源；公开 API 每次只表达一个原子领域操作。
- Bearer Credential、Project Grant、Invitation、Browser Launch/Web Session、Passkey、CSRF、Public Join、quota、Event、CAS 和 idempotency 的 Frozen 合同。
- English / 简体中文公共 Web 文案、Markdown 安全渲染、固定五列 Board 拖拽与完成对话框。
- canonical immutable manifest、digest、migration journal/schema readback、Skill/Instance 两个独立更新平面。

### 不包含

- KV、Durable Objects、Pages、Queues、R2、Vectorize、Workers AI、远程 MCP。
- 公共 batch/bulk API、assign-next、WebSocket、通知、附件、WYSIWYG、自定义 workflow、复杂报表。
- 持有 Cloudflare Token 并写远端的 GitHub Actions 部署；v0 CI 只能做无凭据验证。
- 产品化 D1 导出/导入/Time Travel restore、Owner transfer、第二管理员、Principal device binding。

## 3. 推荐源码结构

```text
apps/
  worker/              # Worker 路由、中间件、领域服务和 D1 repositories
  web/                 # Vue 3 + TypeScript + Vite SPA
contracts/             # OpenAPI 与客户端错误归一化合同
migrations/            # versioned D1 SQL 与 manifest
packages/
  domain/              # 无 Cloudflare I/O 的稳定类型、状态和纯规则
  client/              # Agent/Web 共用的 typed HTTP transport 与错误模型
skills/
  cfkanban/
  cfkanban-admin/
  cfkanban-deploy/
scripts/               # 合同生成、release、Skill 内置确定性脚本
validation/            # 合同原型和跨层测试夹具
docs/
```

只在两个以上消费者实际需要时才把逻辑提升到 `packages/`；不为目录对称提前制造抽象。Worker 是权限、并发和领域规则的唯一强制来源，Web 与 Skills 只复用 transport/types 和 guidance。

## 4. 实施切片与依赖

### WP-01 工程骨架与可重现验证

建立 npm workspaces、TypeScript 基线、Worker/Web 构建、同 Worker Static Assets 配置、无 Cloudflare secret 的 CI verification，以及当前 OpenAPI/migration 原型的生成漂移检查。

验收：干净 checkout 可用一个根级命令完成 typecheck、unit、contract、local D1、Worker build 和 Web build；生成物漂移会失败；CI 不持有 Cloudflare Token。

### WP-02 Worker 内核与 D1 原子执行层

实现路由装配、request ID、结构化错误、请求上限、Bearer/Cookie 认证、Origin/CSRF、参数化 D1 访问、operation/idempotency state machine、Event/commit sentinel 和统一 readback。

验收：错误 envelope 与 OpenAPI 一致；未知/无权资源不泄露；真实 local `env.DB.batch()` 可证明成功提交和 guard 失败整批回滚；日志不包含 secret。

依赖：WP-01。

### WP-03 实例、身份与容器

实现 instance bootstrap、Owner、`/me`、Workspace、Project、固定五状态显示名、preferred origin/discovery 和容器 soft-delete/restore。

验收：只有 Owner 能创建/维护容器；Project 创建后立即可用；key 不可变；容器恢复正确恢复仍 enabled 的 Public Join 提示边界；discovery 动态、`no-store` 且不信任 forwarded host。

依赖：WP-02。

### WP-04 Credential、Grant 与 Invitation

实现参与者 Credential 摘要/撤销、Owner rotation、Project Grants、普通 Project Invite、Principal Recovery Invite 和无孤立身份的原子兑换。

验收：Credential 只认证 Principal；权限只来自 Project Grant或 Owner；普通邀请与 recovery mode 不可混用；响应丢失可用同一 Idempotency-Key 恢复；长期 secret 不回传、不入日志。

依赖：WP-03。

### WP-05 Issue 核心工作账本

实现实例级 `CFK-<number>`、Project/聚合读取、priority、固定 status、assignment/assign-to-me、blocked reason、CAS、soft delete/restore 和 context projection。

验收：编号全局单调不复用；聚合读取按当前授权过滤；Project filter 可省略但返回 resolved scope；所有写入重新鉴权并带 version；进入 done 不能绕过 complete。

依赖：WP-03。

### WP-06 Comment、完成、Label、Relation 与 Event

实现普通/完成 Comment、complete/reopen、Label、Issue-Label、同 Workspace Relation、跨 Project 双端权限，以及 domain/security Event/cursor。

验收：completion comment 不可修改/删除；跨 Project Relation 同时验证两端 writer/version 并完整回滚；无权端点不泄露；cursor scope 变化返回可恢复错误。

依赖：WP-05。

### WP-07 Browser Launch、Web Session 与 Passkey

实现 5 分钟一次性 Browser Launch、8 小时固定 Session、source/scope revoke 联动、double-submit CSRF、discoverable Passkey registration/authentication 和 D-252 counter 异常策略。

验收：GET launch 无副作用；一次兑换；无 open redirect；Agent-launch Session 才能登记 Passkey；ES256/RS256、RP ID/origin/user handle/challenge 全验证；公开失败不泄露 credential 存在；counter 异常拒绝并审计但不自动 revoke。

依赖：WP-02、WP-03。

### WP-08 Public Join、成本门控与平台错误

实现公开 Project 列表、单 Project self-join、三项 active quota、Project-local counters、Workers Rate Limiting bindings 读取/执行、Cloudflare/D1 错误映射和客户端 transport 归一化。

验收：limit 可低于 usage；只阻止本 Project 计数增长；关闭 Policy 后停止强制且不影响其他 Project；soft delete/revoke 释放、restore/regrant 重占；匿名响应不泄露精确 usage；Worker 外错误明确标记客户端归一化。

依赖：WP-04、WP-05、WP-07。

### WP-09 极简双语 Web UI

实现 public home、Launch/Passkey、Project selection、固定五列 Board、Issue detail、常用原子写、Owner Overview/Workspaces/Access/Audit、个人资料、Passkey 管理和 English/简体中文切换。

验收：reader/writer/Owner 能力不超出 API；拖拽 saving/冲突回滚和 done 完成框符合合同；Markdown 渲染防 XSS；Session 失效清除远端数据；无 Credential 输入框、无 Web Storage secret；Codex IAB 与普通浏览器均可用。

依赖：WP-05、WP-06、WP-07、WP-08。

### WP-10 三个 Skills、部署与更新

实现 `cfkanban`、`cfkanban-admin`、`cfkanban-deploy`，canonical bootstrap/manifest、用户级 Tool Runtime、`.cfkanban/` state、strict-zero deploy、Skill update、Instance upgrade 和 migration journal/readback。

验收：macOS、Windows 原生、WSL2、Linux 的 capability detection 不静默改变 Node/PATH；Credential 文件边界/权限校验；一个实例一个本地身份槽位；trusted origin rebind；两个更新平面不互相隐含；部署计划外变化重新授权。

依赖：WP-01、WP-03、WP-04；Instance upgrade 的最终验收还依赖 WP-09 的 deployment bundle。

### WP-11 端到端加固与 v0 release candidate

跨 Worker/D1/Web/Skills 验证首次部署、邀请加入、日常协作、Passkey、Public Join、更新、错误恢复和兼容矩阵；生成 immutable release manifest 与可验证 bundle。

验收：所有根级验证通过；真实 Cloudflare 隔离实例的部署/migration/smoke 另获授权后完成；至少在 Codex 与另一种 Agent 宿主、IAB 与普通浏览器、两类 OS 环境验证主流程；已知限制进入 release notes，不以测试夹具冒充真实部署。

依赖：WP-06、WP-08、WP-09、WP-10。

## 5. 实施规则

- 每个 Linear Issue 开始前重读其直接依赖的 Frozen SPEC；发现合同冲突先停下修订，不在实现中默补。
- shared schema、migration、OpenAPI、认证权限、错误 envelope 和根配置由单一实现 owner 串行修改；并行工作按 Worker/Web/Skills 或独立验证模块分区。
- 每个切片先证明最小垂直行为，再扩充同类端点；禁止一次性生成 91 个空 handler 后声称 API 已实现。
- D1 migration 一旦进入首个发布 bundle 即不可改写；发布前 prototype `0001_initial` 可以随 Frozen 合同校准一次。
- 不把本地 validation prototype 直接当 production module；可以提炼已验证 SQL/规则，但必须有实现层测试。
- 任何远端 Cloudflare 写入、migration、domain、付费配置、发布、Git push 都按独立授权边界执行。

## 6. 验证矩阵

| 层 | 最低证据 |
| --- | --- |
| Domain | 纯规则单测：权限投影、status/priority、counter、error mapping、scope/cursor |
| D1 | migration apply、schema readback、FK/CHECK/unique、query plan、并发/rollback、response-loss |
| Worker | Miniflare/Wrangler integration：auth、CSRF、idempotency、Event、secret redaction、Static Assets routing |
| Web | typecheck、component/interaction、Markdown/XSS、i18n fallback、drag conflict、session expiry |
| Skills | manifest/digest、跨平台 capability fixtures、文件权限、pending/current、plan/journal/rebind |
| End to end | 部署→建项→邀请→协作→Web→Passkey/Public Join→更新/恢复；远端步骤需独立授权 |

## 7. 交付与停止条件

每个 WP 只有在其验收证据读回后才能在 Linear 完成。以下情况必须停止并回到合同层：

- 需要增加业务角色、Workspace 权限继承、公开 batch、第二事实源或新的 Cloudflare 付费依赖；
- 无法在 D1 单个原子单元内保证已冻结的并发/配额/恢复语义；
- 需要浏览器接收长期 Credential、降低 Passkey/CSRF/origin 边界或改变 Owner 恢复模型；
- migration 需要破坏性数据变化、自动 Time Travel restore 或 Worker rollback 隐式回退 D1；
- 实际 Free profile 证据表明当前请求/写放大无法接受。
