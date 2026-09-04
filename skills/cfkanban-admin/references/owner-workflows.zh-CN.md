# Owner 工作流

语言：[English](owner-workflows.md) | [简体中文](owner-workflows.zh-CN.md)

在 Skill 目录运行 `node scripts/cfkanban-tool.mjs help`，查看当前 release 的 admin 命令边界。普通 REST 操作使用 `api request`，secret 轮换使用专用 `owner rotate-credential`。

## 通用请求方式

通过 stdin 提供一个 JSON 对象，不要放进进程参数：

```json
{
  "instanceId": "11111111-1111-4111-8111-111111111111",
  "method": "GET",
  "apiPath": "/api/v1/admin/audit-events"
}
```

将其作为 `node scripts/cfkanban-tool.mjs api request` 的 stdin。命令在内部读取 current Owner Credential。不得把 Credential、pending secret、完整 Invite URL 或 recovery code 放入普通请求输入。

## 部署后的第一个可用看板

部署不会自动创建应用容器。处理常见的首次使用请求时：

1. 检查本地状态，并验证 `/api/v1/me` 返回预期稳定 Principal 且 `is_owner=true`；
2. 从用户取得明确、不可变的 Workspace key 和 display name，把所选 key 规范为小写，按 `[a-z][a-z0-9-]{1,31}` 校验，在预览中展示 canonical key，用一个 Idempotency Key 创建，再读回；
3. 取得明确、不可变的 Project key 和 display name，把所选 key 规范为大写，按 `[A-Z][A-Z0-9-]{1,15}` 校验，在预览中展示 canonical key，用另一个 Idempotency Key 在该 Workspace 中创建，再读回 Project 和固定五个 statuses；
4. 使用 `target.kind=admin` 创建 Owner Browser Launch，只把一次性 URL 返回给用户；
5. 提供彼此独立的后续选项：用 `cfkanban` 创建第一条 Issue、创建显式 role Invite，或配置 Public Join 与全部三项 quotas。

用户选择的 key 可以使用任意字母大小写，不能仅因大小写要求用户重新输入。大小写规范化不代表可以 slugify、派生或以其他方式改写 key。不得从 Repo、path、Git remote、hostname 或 display name 猜测 key；不得静默创建默认 Project、Label、Grant、Issue、Invite 或 Public Join policy。如果 Workspace 创建成功而 Project 创建失败，必须把 Workspace 报告为已提交，不能声称整组操作已回滚。

## 管理端 endpoint 对照

| 任务 | Method 与 path | 必要检查 |
| --- | --- | --- |
| 验证 Owner | `GET /api/v1/me` | 要求稳定 Principal ID 与 `is_owner=true`。 |
| 列出/创建 Workspace | `GET/POST /api/v1/workspaces` | 预览/提交前把显式 immutable key 规范为小写并校验；同时提交 display name 与 Idempotency Key。 |
| 读取/改名/暂停 Workspace | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_key}` | 改名/删除使用 current version。 |
| 恢复 Workspace | `POST .../commands/restore` | 先展示所有会恢复公开的 enabled Public Join Projects。 |
| 列出/创建 Project | `GET/POST /api/v1/workspaces/{workspace_key}/projects` | 预览/提交前把显式 immutable key 规范为大写并校验；创建不隐含 Grant、Label 或另一个 Project。 |
| 读取/改名/暂停 Project | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_key}/projects/{project_key}` | Project key 永不修改。 |
| 恢复 Project | `POST .../commands/restore` | 展示会恢复的 Public Join role/summary/limits。 |
| 读取/修改 status 显示名 | `GET .../statuses`、`PATCH .../statuses/{status_key}` | 固定五个 key 和语义不能改变。 |
| 列出/创建 Invite | `GET/POST /api/v1/admin/invitations` | 显式 kind、准确 target(s)、每个 Project 显式 `reader | writer`。 |
| 读取/撤销 Invite | `GET/DELETE /api/v1/admin/invitations/{invitation_id}` | 使用稳定 ID；不保存完整 Bearer URL。 |
| 列出/读取 Principal | `GET /api/v1/admin/principals`、`GET .../{principal_id}` | display name 不唯一，不能选择目标。 |
| 列出参与者 Credential | `GET /api/v1/admin/principals/{principal_id}/credentials` | 只展示 fingerprint/status，不展示 secret。 |
| 撤销参与者 Credential | `DELETE /api/v1/admin/credentials/{credential_id}` | 读回准确 Credential 与 audit；不适用于 Owner Credential。 |
| 轮换 Owner Credential | 专用 `credential prepare` + `owner rotate-credential` | 见下方轮换流程。 |
| 列出/创建 Project Grant | `GET/POST /api/v1/admin/projects/{project_id}/grants` | 一个稳定 Principal 与显式 role。 |
| 读取/改 role/撤销 Grant | `GET/PATCH/DELETE /api/v1/admin/grants/{grant_id}` | Role 变化或撤销不抹除 assignment/history。 |
| 读取审计 | `GET /api/v1/admin/audit-events` | 有界分页与显式 filters。 |
| 读取/修改 preferred origin | `GET/PUT /api/v1/admin/instance-origin` | 无 Credential 探测 candidate、CAS、新旧 discovery 读回。 |
| 管理 Public Join | `GET/PUT/DELETE /api/v1/admin/projects/{project_id}/public-join` | 一个 Project 与显式 role；关闭不撤销 Grants。 |
| 读取/修改 Project limits | `GET/PATCH /api/v1/admin/projects/{project_id}/resource-limits` | 显式 Issue/Comment/Principal limits 与 current usage。 |
| 检查 rate gates | `GET /api/v1/admin/rate-limit-settings` | 这里只读；bindings 由 deploy Skill 修改。 |
| 撤销参与者 Passkey | `DELETE /api/v1/admin/passkeys/{passkey_id}` | 不撤销 API Credential 或 Grant。 |
| 打开 Owner Web | `POST /api/v1/web-launches`，`target.kind=admin` | 选择显式 section；默认行为是 Overview。 |

## Invitation 与恢复

普通 Project Invite 固定 7 天、一次性使用。每个目标 Project 都要显式提交 `reader | writer`。上层没有 role 时 Skill 可建议 `writer`；明确只读则解析为 `reader`。推荐值不能变成省略的 API 字段。

Principal Recovery Invite 固定 1 小时。创建前：

1. 选择准确稳定 Principal ID，不能用 display name。
2. 读取当前 Grants、assignment/history 连续性与 Credentials。
3. 选择不可变的 `rotation` 或 `full_recovery`，并展示准确撤销范围。
4. 用独立 Idempotency Key 创建一个 Invite，再按 invitation ID 读回。
5. 只把可复制邀请话术返回给用户；cfKanban 不负责发送，Agent 也不记录。

## Owner Credential 轮换

1. 验证 `/api/v1/me` 是 current Owner，并读取 current Credential fingerprint。
2. 使用同一 Owner Principal ID、稳定 operation ID、Idempotency Key 和 `purpose=owner_rotation` 运行 `credential prepare`。替代 secret 直接写入私有 pending 槽位。
3. 只传 `instanceId` 运行 `owner rotate-credential`。它用 current secret 认证、在内部把 pending secret 注入 rotation body，二者都不进入 stdout/stdin/参数。
4. 命令用替代 Credential 认证 `/api/v1/me`，只在 Principal ID 与 fingerprint 匹配后提升为 current。
5. 提交状态不确定时保留同一个 pending secret，并重跑同一命令；不能再生成替代值。
6. 只有远端未提交已被证明时才运行 `credential clear`。

Web Session 不能轮换或撤销 Owner Credential。全部 Owner Credential 丢失时，使用 `cfkanban-deploy` 为同一 Owner Principal 执行部署外受控恢复。

## Public Join 与 quota

开启或修改 Public Join 前，读取 Project、Policy、active usage 与三项 limits。影响摘要必须包括：

- public `writer` 允许未知互联网参与者修改/软删除内容并产生 D1 writes；
- 只显示显式 public summary，不复用内部 Project context；
- Issue、Comment、active non-Owner Principal limits 按本 Project 隔离，且只在该 Project Public Join enabled 时强制；
- 50/500/50 只可建议，不能静默提交；
- limits 可以低于 current usage，既有数据和 Grants 不删除，只阻止继续增加对应计数的操作；
- soft delete/Grant revoke 释放 active capacity，restore/regrant 再占用；
- 关闭后阻止新 self-join 并停止 quota 强制，但不撤销既有 Grants；
- Project 仍公开时，撤销 Grant 不会建立 rejoin blacklist。

## Tombstone 与容器恢复

通过已知稳定 identifier 或显式分页 `deleted=only` view 定位；不存在隐藏的“最近删除”时间窗，也没有 bulk restore endpoint。每次只恢复一个资源。

恢复 Project 或 Workspace 前，列出所有会重新生效的 enabled Public Join Policy，包括 Project、role、public summary、limits 与 active usage。此前 disabled 的 Policy 保持关闭。

## Preferred origin 与 Owner Web

修改 preferred origin 前，不带 Credential 探测目标 HTTPS origin，使用 current expected version 更新，再从新旧 origin 分别读取 public discovery document。认证请求不依赖跨 origin redirect。

Owner Browser Launch 只用 current Owner Credential 创建固定 5 分钟的 opaque code；它兑换为实例级 admin Session，默认打开 Overview，不预取全部 Issues。用户随后可显式选择 Workspace/Project。长期 Credential 不进入浏览器。

## 错误与读回

每个原子写操作独立使用 Idempotency Key。读回修改后的资源与相关 audit event。只按稳定机器字段解释错误，不匹配 `message`。后续步骤失败时，之前已提交的操作保持提交，必须单独汇报而不能声称回滚。
