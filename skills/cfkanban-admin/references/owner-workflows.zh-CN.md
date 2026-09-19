# Owner 工作流

语言：[English](owner-workflows.md) | [简体中文](owner-workflows.zh-CN.md)

只读取相关章节。每个已安装 release 首次使用或输入不明确时，在 Skill 目录运行 `node scripts/cfkanban-tool.mjs help` 查看 admin 命令边界。普通 REST 操作使用 `api request`，一次性 capability 分别使用 `invite create` 与 `web launch`，secret 轮换使用专用 `owner rotate-credential`。

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
2. 复用已给出的显示名称和明确选定的既有 Workspace；一次询问缺失名称，写入前消歧已有重名对象；
3. 仅在用户要求或第一个看板需要时创建 Workspace，读回服务端生成的 UUID，再在该 UUID 下用独立 Idempotency Key 创建请求的 Project 并读回；
4. 使用 `target.kind=admin` 运行 `web launch`；默认直接打开浏览器，不返回一次性 URL；
5. 提供彼此独立的后续选项：用 `cfkanban` 创建第一条 Issue、创建显式 role Invite，或配置 Public Join 与全部三项 quotas。

名称不是唯一标识；通过授权读取确定既有容器，重名时先消歧，不猜测 UUID。不静默创建默认 Project、Label、Grant、Issue、Invite 或 Public Join policy。Project 创建失败不回滚已创建的 Workspace。

## 管理端 endpoint 对照

| 任务 | Method 与 path | 必要检查 |
| --- | --- | --- |
| 验证 Owner | `GET /api/v1/me` | 要求稳定 Principal ID 与 `is_owner=true`。 |
| 列出/创建 Workspace | `GET/POST /api/v1/workspaces` | 使用显示名称创建，读回服务端生成的 UUID；名称不作为唯一标识。 |
| 读取/改名/暂停 Workspace | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_id}` | 改名/删除使用 current version。 |
| 恢复 Workspace | `POST .../commands/restore` | 先展示所有会恢复公开的 enabled Public Join Projects。 |
| 列出/创建 Project | `GET/POST /api/v1/workspaces/{workspace_id}/projects` | 使用显示名称创建，读回服务端生成的 UUID；名称不作为唯一标识。 |
| 读取/改名/暂停 Project | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_id}/projects/{project_id}` | UUID 永不修改；改名与归档使用 current version。 |
| 恢复 Project | `POST .../commands/restore` | 展示会恢复的 Public Join role/summary/limits。 |
| 读取/修改 status 显示名 | `GET .../statuses`、`PATCH .../statuses/{status_key}` | 固定五个 key 和语义不能改变。 |
| 列出/创建 Invite | `GET /api/v1/admin/invitations`；专用 `invite create` | 显式 kind、准确 target(s)、每个 Project 显式 `reader | writer`。 |
| 读取/撤销 Invite | `GET/DELETE /api/v1/admin/invitations/{invitation_id}` | 使用稳定 ID；不保存完整 Bearer URL。 |
| 列出/读取 Principal | `GET /api/v1/admin/principals`、`GET .../{principal_id}` | display name 不唯一，不能选择目标。 |
| 列出参与者 Credential | `GET /api/v1/admin/principals/{principal_id}/credentials` | 只展示 fingerprint/status，不展示 secret。 |
| 撤销参与者 Credential | `DELETE /api/v1/admin/credentials/{credential_id}` | 读回准确 Credential 与 audit；不适用于 Owner Credential。 |
| 轮换 Owner Credential | 专用 `credential prepare` + `owner rotate-credential` | 见下方轮换流程。 |
| 列出/创建 Project Grant | `GET/POST /api/v1/admin/projects/{project_id}/grants` | 一个稳定 Principal 与显式 role。 |
| 读取/改 role/撤销 Grant | `GET/PATCH/DELETE /api/v1/admin/grants/{grant_id}` | Role 变化或撤销不抹除 assignment/history。 |
| 读取审计 | `GET /api/v1/admin/audit-events` | 有界分页；可按一个不可变 `project_id` 和／或 `stream=domain|security` 筛选，并核对 `resolved_filters`。 |
| 读取/修改 preferred origin | `GET/PUT /api/v1/admin/instance-origin` | 无 Credential 探测 candidate、CAS、新旧 discovery 读回。 |
| 管理 Public Join | `GET/PUT/DELETE /api/v1/admin/projects/{project_id}/public-join` | `expected_version` 使用 `project.version`，不能使用 `policy_version`；关闭不撤销 Grants。 |
| 读取/修改 Project limits | `GET/PATCH /api/v1/admin/projects/{project_id}/resource-limits` | 使用返回的 `project.version`，提交显式 Issue/Comment/Principal limits。 |
| 检查 rate gates | `GET /api/v1/admin/rate-limit-settings` | 这里只读；bindings 由 deploy Skill 修改。 |
| 撤销参与者 Passkey | `DELETE /api/v1/admin/passkeys/{passkey_id}` | 不撤销 API Credential 或 Grant。 |
| 打开 Owner Web | 专用 `web launch`，`target.kind=admin` | 选择显式 section；默认不输出 capability，直接在系统浏览器打开 Overview。 |

## Invitation 与恢复

普通 Project Invite 固定 7 天、一次性使用。每个目标 Project 都要显式提交 `reader | writer`。上层没有 role 时 Skill 可建议 `writer`；明确只读则解析为 `reader`。推荐值不能变成省略的 API 字段。

Principal Recovery Invite 固定 1 小时。创建前：

1. 选择准确稳定 Principal ID，不能用 display name。
2. 读取当前 Grants、assignment/history 连续性与 Credentials。
3. 选择不可变的 `rotation` 或 `full_recovery`，并展示准确撤销范围。
4. 用独立 Idempotency Key 通过 `invite create` 创建一个 Invite，再按 invitation ID 读回。
5. 默认使用 `delivery=clipboard`，把一次性话术复制到剪贴板而不写 stdout；cfKanban 不负责发送，用户或 Agent 只应粘贴给目标接收方。

没有剪贴板时，默认在创建前停止；只有用户明确接受宿主保留工具输出的风险，才使用 `delivery=stdout_once`，并传入准确确认句 `I understand this one-time capability may be retained by the Agent host`。其 `sensitive_output` 只展示一次，不得在回复、日志、journal、receipt、文件或后续消息中复述或保存；幂等重放只返回安全 metadata，无法找回 URL。

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

Policy 响应会有意展示两个版本号：Public Join 开启、更新、关闭和 resource-limit 写入的 CAS 值是 `project.version`；`policy_version` 只表示 Policy 记录自己的历史，绝不能复制到 `expected_version`。遇到 `VERSION_CONFLICT` 时重新读取 Project/Policy 事实并判断原请求；只有并发改动实质改变目标或影响时才询问，不能猜一个版本继续重试。

## Tombstone 与容器恢复

通过已知稳定 identifier 或显式分页 `deleted=only` view 定位；不存在隐藏的“最近删除”时间窗，也没有 bulk restore endpoint。每次只恢复一个资源。

恢复 Project 或 Workspace 前，列出所有会重新生效的 enabled Public Join Policy，包括 Project、role、public summary、limits 与 active usage。此前 disabled 的 Policy 保持关闭。

## Preferred origin 与 Owner Web

修改 preferred origin 前，不带 Credential 探测目标 HTTPS origin，使用 current expected version 更新，再从新旧 origin 分别读取 public discovery document。认证请求不依赖跨 origin redirect。

### 解析实例与已认证目标

运行 `web resolve`，传入已知 `instanceId` 或 `origin`（仅 HTTPS origin，不含 path/query/fragment）；在 Repo 工作时可传 `repoRoot`。该命令只读本地可信实例 metadata 和 current 槽位是否存在，不鉴权、不输出 secret，状态为 `resolved`、`selection_required` 或 `credential_required`。用户明确指向的当前浏览器 origin 属于显式上下文；无关 ambient tab 不构成目标。优先显式目标，其次 Repo 唯一实例，再其次本地唯一 current 实例；Repo 有多个候选时保留歧义。只展示候选标识与域名、询问一次，不按第一项、最近使用或 Owner 身份选择。显式未知 origin 应转入可信登记/加入或恢复，不回退其他实例，也不向它发送 Credential。

解析后以私有 current Credential 请求 `GET /api/v1/me`。凭据失效则停止 launch 并转入恢复。已验证 Owner 未指定更窄 target 时，经 `cfkanban-admin` 打开 admin Overview。参与者缺少明确 Project/Issue 时只读列出授权 Projects，唯一时进入该 Project，否则询问；这决定初始页面。支持新合同的 Service 将新兑换的非 Owner launch 签发为 `project_selection`，只允许当前实时授权项目；既有固定 scope Session 和 Owner Project/Issue Session 不扩大。不可从本地 Skill 版本推断线上已支持。已有浏览器 Session 只有核对 Principal 与 target scope 后才能复用。完成标准是进入准确的已认证页面，不是仅打开 tab 或完成 relay 跳转。

### 交付到 IAB 或其他宿主控制的浏览器

用户指定 IAB 或宿主可控制的浏览器时，先确认浏览器工具能够访问当前进程的 loopback，再使用 `delivery=host_browser`。以短 shell yield 启动 CLI，保留运行进程；CLI 先流式输出包含 `local_url` 的 `browser_relay_ready` event，等待浏览器 GET 后再输出最终结果。立即用指定浏览器的导航工具打开准确的本地 URL。不要先用 fetch、curl、预览或其他浏览器探测：GET 会消费本地交付能力。导航后收取仍在运行的 CLI 最终结果。

随机路径的 loopback 入口只能使用一次，60 秒失效。它是短暂进入宿主工具上下文的敏感本地 capability，不在回复中复述，也不写文件、日志、receipt 或报告；远端 ticket URL/code 始终只在进程内存，不打印。远端票据仍为 5 分钟，兑换后 Session 仍为 8 小时，本地 60 秒不改变这些时效。若指定浏览器与进程处于不同宿主/网络空间，或缺少可用导航工具，应在创建票据前停止并解释交付限制，不静默换浏览器。relay 成功仅证明交付，还须检查最终页面；无法验证登录时如实说明。默认 `system_browser` 与显式确认的 `stdout_once` 行为保持不变。

Owner Browser Launch 只用 current Owner Credential 创建固定 5 分钟的 opaque code。`web launch` 默认通过纯内存 loopback relay 打开系统浏览器，远端 URL 不进入 stdout 或进程参数；它兑换为实例级 admin Session，默认打开 Overview，不预取全部 Issues。用户随后可显式选择 Workspace/Project。长期 Credential 不进入浏览器。headless 输出沿用 Invite 的显式 `stdout_once` 确认与禁止留存规则。

## 审计筛选

任务只涉及一个已知 Project 时使用 `project_id`，只关心一种事件时使用 `stream=domain|security`。两者都省略表示有意读取整个实例的业务与安全审计。响应会在 `resolved_filters` 中回显规范化的 `project_id` 与 stream 列表。只有筛选条件完全不变时才能继续使用 `next_cursor`；任何筛选变化都应开启新的分页序列。

使用 `subject.type` 与 `subject.id` 判断 Event 记录的是哪个资源的生命周期；`authorized_via` 与 `grant_id` 是历史授权证据。参与者写 Issue、Comment、Label 或 Relation 时，Event 的 `grant_id` 可以指当时授权该写入的 Project Grant；管理 Grant 的 Event 也可以在同一字段记录作为 subject 的 Grant。因此只按 `grant_id` 筛选会混入其他资源的生命周期。定位 Grant 变更时先匹配 `subject.type=project_grant` 与准确 `subject.id`，再用 `grant_id` 和 `authorized_via` 解释操作如何获权。

## 错误与读回

每个原子写操作独立使用 Idempotency Key，并读回修改后的资源；核对授权或生命周期历史时再检查相关 audit event。普通写入遵循已有用户/宿主授权，本 Skill 不为每次调用增加审批。只按稳定机器字段解释错误，不匹配 `message`。后续步骤失败时，之前已提交的操作保持提交，必须单独汇报而不能声称回滚。

## 已归档容器永久删除

归档（`DELETE`）仍可恢复。永久删除是独立的 Owner 操作，只允许已归档项目，或不含未永久删除项目的已归档工作区。容器路径为 `/api/v1/workspaces/{workspace_id}` 或其 `/projects/{project_id}` 子路径。

1. 读取 `GET {container_path}/purge-preview`，展示准确目标、内容计数、跨项目关系、受影响邀请和共享邀请。`can_purge=false` 时停止。
2. 取得对本次预览范围不可恢复清理的明确授权；归档授权不等于永久删除授权。清理包括事项、普通及完成评论、标签、关系、Grants、项目会话和相关历史/响应缓存。共享未兑换邀请撤销，其他项目既有 Grants 保留。保留最小 UUID 墓碑和精简审计；旧游标可能需要重新读取。不承诺 Cloudflare 存储指标即时下降，也不删除平台备份。
3. 通过 `api request` 发送 `POST {container_path}/commands/purge`，携带 `expected_version=target.version`、`confirm_name=target.display_name`、`preview_digest` 与独立 Idempotency Key。预览过期需重新核对；结果未定时保持同一请求与 key 恢复，不能生成不同删除请求。
4. 核对 `resource.purged=true`，并通过显式 `deleted=only` 列表/详情确认目标不可见，必要时读取精简 Owner 审计。永久删除后不能恢复；同名新建会获得不同 UUID，不隐含逐个或定时清理其他容器。

## Owner 用量与限额

通过 `api request` 调用 `POST /api/v1/admin/usage/refresh`，与 Web 刷新使用同一 Owner-only 投影和服务端缓存。附件 `reserved_bytes` 包含上传中、就绪、软删除和未确认回收对象，是应用预留预算，不是 R2 计费容量。Cloudflare 数据可选且仅限本实例；明确展示 `not_configured`、`pending`、`error`、`stale` 和 null，不把未知改写为零，也不从实例推算账户剩余额度。日操作量采用 UTC 当日窗口；容量采用最近 24 小时最后观测桶，默认只展示一次简短更新时间；需要核对时再区分观测时间、采集时间和准确 UTC 区间。统计 Token/资源配置交由 cfkanban-deploy；附件容量仍由下节应用设置管理，凭据不得进入 API 请求体或 Issue。

每次技能查询都调用与页面“刷新用量”相同的刷新入口。`{ "mode": "stale" }` 和 `{ "mode": "manual" }` 统一复用不足 15 分钟的成功快照，manual 不绕过缓存。缺少、过期、失败或中断的采集可重试，但共用实例级 60 秒尝试冷却。并发请求返回当前投影并以 `refreshing` 标记；不轮询。每次响应仍实时读取附件预留与设置。该派生缓存刷新不要求 Idempotency-Key，不写领域 Event/Audit。

每次查询运行 `node scripts/cfkanban-tool.mjs api request`，通过 stdin 提交已解析的可信实例 UUID：

```json
{"instanceId":"<trusted-instance-uuid>","method":"POST","apiPath":"/api/v1/admin/usage/refresh","body":{"mode":"manual"}}
```

无需先 GET。只有用户明确要求仅查看已存快照时才用 `GET /api/v1/admin/usage`。刷新请求可能命中有效缓存，应报告实际采集时间，不把本次查询时间当作采集时间。

汇报附件 `reserved_bytes`、`limit_configured` 和 `limit_bytes`。仅已配置有限上限时计算剩余应用容量 `max(0, limit_bytes - reserved_bytes)`；不限制没有剩余容量数值，未设置则暂停新上传。云端有数据时概括 D1 容量/当日读写行数、R2 容量/对象数/当日操作量。本 API 不提供账户账单、账户剩余免费额度或 Worker 请求量。

`not_configured` 仍可返回有效的附件数据；说明统计配置缺失或禁用，不因此创建 Token 或启用采集。`refreshing=true` 或冷却期间返回旧快照时如实说明，不能宣称刚刚采集成功。旧服务不支持接口时说明能力未上线（用量需要 schema 6；容量设置需要 schema 7），将另行授权的升级交由 cfkanban-deploy；不回退直接查询 Cloudflare，也不自动升级。

## 附件容量设置

Owner 修改前先读取 `GET /api/v1/admin/attachment-settings`。`configured=false` 表示尚未选择策略，不等于不限制；此时暂停新上传预留。通过 `PATCH /api/v1/admin/attachment-settings` 提交 `{limit_bytes: <正安全整数字节值或 null>, expected_version: <读回版本>}`，携带独立 Idempotency-Key，然后读回设置。null 明确表示 Owner 选择不限制。此操作改变应用设置，遵循普通领域写入的权限、CAS 与幂等合同，不属于统计缓存刷新例外。不得推断不限制，也不静默选择旧有 1 GiB。从旧固定策略迁移后需要 Owner 重新明确选择，部署不能代选或覆盖。已有对象仍计入预留字节，包括软删除但尚未实际回收的对象。应用容量不是 Cloudflare 账单上限。
