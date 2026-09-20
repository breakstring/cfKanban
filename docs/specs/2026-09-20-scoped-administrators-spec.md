# 工作区与项目分级管理员

- 状态：Frozen
- 冻结日期：2026-09-20
- 授权依据：用户认可分级管理员分析并授权文档、cfKanban Issue 跟踪及实现；另明确选择管理员计入 Public Join 人数配额。
- 本增量覆盖 Foundation/API/Web/Skills 中“只有 Owner 管理所有容器和成员”“工作区无继承权限”的相关旧条款；未明确覆盖的安全合同继续有效。
- 实施配方：[PLAN](../plans/2026-09-20-scoped-administrators-plan.md)。执行状态和完成证据以 cfKanban Development 为准。

## 角色和授权

保留唯一 Deployment Owner，不增加实例管理员、Owner transfer、自定义角色或 deny。新增 `workspace_admin` 与 `project_admin`；每个范围允许 0..N 位管理员。身份继续使用 immutable Principal UUID，名称不授予权限。

工作区管理员由 Owner 任免；项目管理员由 Owner 或所属工作区管理员任免。项目管理员不能任免同级管理员；工作区管理员不能任免同级管理员。允许上级显式授予自己下级范围的独立授权，但不得通过下级操作提升权限。Owner 不建立管理员授权行，不受非 Owner 人数配额限制。

工作区管理员动态获得该工作区现在和未来所有项目的管理和内容读写权限，不批量复制 Project Grant。项目管理员动态获得本项目读写权限。普通 `reader | writer` Project Grant 保留，直接授权与管理授权独立；撤销一条来源只去掉该来源，不删除其他有效授权。继承管理权不能由项目 reader 或撤销普通 Grant 抵消。

有效能力取各有效来源的并集；展示优先级为 Owner、workspace_admin、project_admin、writer、reader。对既有数据面协议继续返回兼容的 `owner | writer | reader`，另以管理授权和 `allowed_actions` 表达管理能力及来源。不得将局部管理员伪装为 `is_owner=true`。

## 能力矩阵

| 能力 | Owner | 工作区管理员 | 项目管理员 |
| --- | --- | --- | --- |
| 内容读写、指派、评论、标签、关系、附件 | 全实例 | 本工作区全部项目 | 本项目 |
| 工作区改名 | 全实例 | 本工作区 | 无 |
| 创建工作区、工作区归档/恢复 | 是 | 否 | 否 |
| 创建项目 | 全实例 | 本工作区 | 无 |
| 项目改名、context、固定状态显示名 | 全实例 | 本工作区 | 本项目 |
| 项目归档/恢复 | 全实例 | 本工作区 | 无 |
| reader/writer 授予、变更、撤销、邀请 | 全实例 | 本工作区 | 本项目 |
| 工作区管理员任免 | 是 | 否 | 否 |
| 项目管理员任免 | 全实例 | 本工作区 | 否 |
| Public Join 和资源限额修改 | 是 | 否 | 否 |
| 永久删除、实例安全审计、他人 Credential/Passkey 管理、身份恢复 | 是 | 否 | 否 |
| 部署、域名、付费资源配置 | 沿用独立部署授权 | 否 | 否 |

同级管理员可共同维护业务设置和普通成员，但不能撤销管理身份；“移除普通授权”不能移除管理员的有效访问。无局部管理员时由上级接管，无最后一位局部管理员约束。父工作区归档暂停全部继承管理和数据访问；工作区管理员可读取本工作区已归档项目并恢复，但不能恢复归档工作区。项目管理员在项目归档期间无管理能力。

管理员满足 Issue assignee 的 writer 资格；失去全部 writer 来源时沿用 unavailable/needs_reassignment，不清空 assignment 或历史。跨项目 Relation 仍要求同工作区且两端有效 writer；固定浏览器 Session 不得跨越自身范围。

## 人数配额与并发

Public Join 的 `principal_limit` 统计该项目有效直接成员、项目管理员和继承工作区管理员的非 Owner Principal 并集，同一人只计一次。关闭 Public Join 仍停止强制，现有超额状态不自动撤权；只阻止增加人数的动作，重复来源、角色变更或减少人数仍可进行。

授予/重新授予工作区管理员时，在同一个数据库原子操作中检查所有受影响的有效 Public Join 项目；任何项目新增该 Principal 后超额，整个授权失败，不留下局部授权、人数变化或成功事件。项目管理员及普通 Grant/Invite/Public Join 使用相同去重口径。新项目计入现有工作区管理员；启用 Public Join 可以显式配置低于当前用量的限额，沿用 over-limit 语义。项目归档期间保留授权及人数投影，工作区管理员的授权变更应同时维护其所有子项目计数，避免恢复时漂移。

管理授权有 UUID、version、撤销状态和授权 generation；所有写入有 CAS、幂等、实时权限和原子审计。初次授权 expected_version=0，重新授予使用撤销记录的当前 version；撤销使用当前 version。每次重新授予产生新的 generation，旧邀请不会复活。读取在授权消失后不得重放旧可见内容；幂等响应重放前重新检查调用者当前权限。

## 邀请和身份边界

普通成员邀请继续只能授予 reader/writer，不通过 Invite 或 Public Join 授予管理身份。非 Owner 管理员每次只邀请一个明确的受管项目；Owner 现有多项目 Invite 合同保留。身份恢复及 Credential/Passkey 管理仍是 Owner-only。

非 Owner 邀请绑定签发时采用的确切管理员授权 ID/generation；创建和兑换均在原子写入中校验它仍有效及容器可用。授权撤销后尚未兑换的邀请永久失效，即使签发者有其他管理来源或后来重新获权也不复活。容器归档仅暂停兑换，恢复不复活被撤销的签发授权。已兑换成员不随签发管理员撤权自动移除。

局部管理员只能查看和撤销完整目标都在其管理范围内的普通项目邀请；不能列举、读取、撤销身份恢复或夹带无权项目的邀请，不泄露其他范围的 Principal 资料、Credential、Passkey、成员数和审计。签发者失权导致的邀请失效使用既有失效错误族和机器可读 reason，不返回秘密或其他项目事实。

## API 与数据模型

新增独立 scoped administrator 授权关系，保留普通 project_grants 的 reader/writer 字段和语义；不在容器增加单一 admin_principal_id。schema 9 追加迁移，不改旧 migration、不提升既有创建人或 writer、不复制授权。数据库有效项目访问投影供列表、assignee、原子写入和人数去重统一使用；审计区分 workspace_admin/project_admin，保留授权 ID 与版本/generation。

- `GET /api/v1/me` 增加当前直接 `management_grants`，仅含当前调用者的非秘密授权及范围。
- `GET/POST /api/v1/workspaces/{workspace_id}/administrators`：查看/授予工作区管理员；POST 仅 Owner。
- `DELETE /api/v1/workspaces/{workspace_id}/administrators/{administrator_id}?expected_version=...`：Owner 撤销。
- `GET/POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators`：查看/授予本项目管理员；写入只允许 Owner/工作区管理员。
- 对应 Project administrators 子资源 `DELETE .../{administrator_id}?expected_version=...` 撤销。
- 授予 body 为 `{principal_id, expected_version}`；返回沿用 WriteResult、资源 version、allowed_actions 和有效来源。列表使用既有 limit/cursor 合同；撤销记录可用于显式重新授予。
- `GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/members`：供当前项目管理员读取有界、分页的有效成员和授权来源；不返回跨范围身份细节。
- 既有项目 Grant 与普通 Invitation 管理端点按目标扩展局部管理授权；`/admin` 路径不等于全实例授权，实例身份/安全端点继续 Owner-only。
- 工作区/项目读回使用 allowed_actions 表达改名、建项、状态名、归档/恢复、成员及管理员管理。列表包含当前管理员有权管理的空工作区。

数据面兼容的 writer 投影不替代管理授权检查；不会因为所有管理员都可写就允许 writer 管理。权限检查必须处于提交原子边界，不能只改入口 requireOwnerControl。

## Web 与 Skills

第一方 Web 提供工作区/项目的管理入口与成员/管理员列表，清楚显示继承来源、直接授权和移除后的剩余访问；支持多人、CAS 冲突、归档恢复提示、中英文。Owner 仍使用实例管理页面；局部管理员只进入自己范围的管理界面，不展示全实例身份、凭据、用量和安全审计。

沿用新参与者 project_selection Session 的实时权限；管理请求必须同时满足当前角色和 Session 允许范围。既有固定 Project/Issue Session 不扩大为工作区管理范围，Owner 窄 scope Session 也不提升成实例管理。局部管理员用既有 Project/Issue Launch 进入界面，空工作区管理提供明确受限入口；不得复用 Owner admin scope。

cfkanban 保持日常协作；cfkanban-admin 扩展为按当前有效范围管理，明确区分 Owner 专属动作、继承和撤权；cfkanban-howto 同步解释；cfkanban-deploy 不改变部署授权。技能默认解析能力并使用真实 UUID，不通过 display name 推断角色，不暴露长期 Credential 或一次性 Invite。

## 验收与发行边界

覆盖多管理员、空工作区/未来项目继承、独立来源去重和撤销、同级/跨范围越权、固定 Session、实时撤权及幂等重放、并发授予/撤销、邀请失效与重新授权不复活、成员配额全有或全无、assignee/关系/附件/事件一致性、迁移保留历史及 Owner 原有能力。

schema 9 与配套 Worker 必须共同升级，旧 Worker 不支持新增管理权限或配额口径，不能宣称可安全回滚。源码实现与本地验证不等于发行、生产迁移或部署；远端发布仍需独立 preflight 和授权。
