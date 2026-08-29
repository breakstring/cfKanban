# cfKanban API & D1 Schema SPEC

- 文档状态：Draft
- Roadmap：R1 / R2
- 上游合同：[Agent-native Kanban Foundation SPEC](2026-08-26-agent-native-kanban-foundation-spec.md)（Frozen）
- Agent 合同：[Agent Skills & Bootstrap SPEC](2026-08-28-agent-skills-bootstrap-spec.md)（Frozen）
- 架构基线：[Cloudflare 架构基线](../architecture/cloudflare-baseline.md)
- 平台快照：[2026-08-28 Cloudflare 平台快照](../research/cloudflare-platform-snapshot-2026-08-28.md)
- 最近更新：2026-08-28
- 冻结日期：待确认

## 1. 目的与边界

本文把两份 Frozen 上游合同推导为可实现、可验证的 v0 HTTP API、OpenAPI 约定、D1 逻辑 schema、索引和原子写入配方。本文不得重新解释 Owner、Principal、Project Grant、Invitation、assignment、status、blocked、soft delete、Event/Audit 或 Agent Guidance 的产品语义。

本文仍是 Draft，不授权编写业务代码、生成 migration、创建 Linear 实现 Issue、部署或迁移。冻结前应通过 OpenAPI/DDL 原型和本地 D1 验证本文的 SQL 能力假设，但原型不能被表述为产品实现。

本文定义：

- `/api/v1` 的资源、命令、请求响应和错误合同；
- OpenAPI 的稳定命名、版本和兼容策略；
- D1 表、字段、约束、索引和读取模型；
- 适配 D1 `batch()`、查询限制和串行写入模型的原子操作方式；
- 幂等、CAS、Event/Audit、cursor 与软删除的数据库落点；
- Free profile 下避免全表扫描、N+1 和写放大的约束。

本文不定义：

- Worker 的具体框架、目录、ORM 或 query builder；
- 完整 TypeScript 实现与生成后的 `openapi.json`；
- Skill 文件、Node scripts 或部署 bundle 的具体代码；
- Vectorize、Workers AI、Queues、R2、Durable Objects、远程 MCP 或重型 UI；
- 完整 D1 导出、导入、本地恢复演练或整库灾难恢复；
- 物理 purge、公共多租户或 v1 之后的兼容策略。

## 2. Cloudflare 约束如何进入设计

截至 2026-08-28，本文只依赖 Cloudflare 官方文档确认的下列能力：

- Workers Free 的 CPU、内存、请求和 subrequest 上限要求同步请求保持短小、有界；应用自己的 128 KiB JSON 上限远低于平台请求体上限。
- D1 使用 SQLite 语义并支持 prepared statements、外键、JSON 函数和 `batch()`；prepared statement 只使用有序参数，所有外部值必须绑定。
- D1 `batch()` 中的语句顺序执行并构成一个 SQL transaction；任一语句失败会回滚整批。D1 没有让 Worker 在事务中间读取结果、再动态追加下一条 SQL 的 callback transaction API。
- Free profile 每个 Worker invocation 最多 50 次 D1 查询；单条 SQL 最多 100 个 bound parameters、100 KB SQL，单行/字符串/BLOB 最大 2 MB。本文把普通 API 目标控制在明显更低的应用预算内。
- D1 按扫描/写入的行计量；索引与 keyset pagination 是成本合同的一部分，不使用 offset pagination 或每页 `COUNT(*)`。
- v0 strict-zero 不启用 read replication；如果未来启用，必须另行引入 Sessions API/bookmark，不能假设普通 replica read 自动满足 read-your-own-writes。
- D1 migrations 只在部署阶段按顺序执行，不能在请求热路径建表或建索引。
- v0 只需要 identifier exact 与 title substring 的基础检索，不在核心 schema 中引入 FTS5 virtual table。后期检索增强按 D-214 优先设计为 Cloudflare Vectorize 可重建派生索引，不提前把另一套索引生命周期加入 v0。

主要官方依据：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Database / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [D1 indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

易漂移数字只保存在平台快照，不升级为永久产品承诺。本文固定的是应用预算、正确性策略和降级行为。

## 3. API 通用合同

### 3.1 路径、媒体类型与版本

- 业务 API 固定前缀为 `/api/v1`；`/healthz`、`/openapi.json` 和 `/invite` 是例外公共入口。
- 请求与响应使用 `application/json; charset=utf-8`；Invite 浏览器说明可以返回 HTML，但其机器可读入口仍为 JSON。
- JSON 字段使用 `snake_case`；枚举使用稳定小写 key；显示名称另行返回，不能代替稳定 key。
- v1 内可以增加可选响应字段、可选查询参数和新端点；删除字段、改变字段含义、增加请求必填字段或改变权限语义需要新的 Frozen 修订或新的 path major。
- 请求对象拒绝未知字段，避免 Agent 拼错字段后被静默忽略；调用方必须容忍响应中新增的未知字段。

### 3.2 认证与安全 Header

除下列入口外，所有 `/api/v1` 请求都需要 `Authorization: Bearer <credential>`：

- `POST /api/v1/invitations/redeem`：Project Invite 首次创建 Principal 和 `full_recovery` 可以没有旧 Credential；复用身份与 `rotation` 仍按合同要求认证。

其他公共入口：

- `GET /healthz`；
- `GET /openapi.json`；
- `GET /invite?code=<opaque>`。

Credential 格式固定为版本化 opaque token：`cfk_v1_<prefix>_<secret>`。`secret` 至少 256 bit 随机熵；D1 只保存完整 token 的 SHA-256 hex digest、用于日志安全识别的短 prefix/fingerprint 和元数据。高熵随机 token 不使用面向低熵密码的慢 hash；v0 不使用部署 pepper，避免增加第二份必需 secret 及其轮换合同。鉴权只做 digest 精确查询并统一返回不泄露原因的认证失败，任何日志只允许 fingerprint。

Invitation code 同样至少 256 bit 随机熵，D1 只保存 SHA-256 hex digest。Invite code、Credential、Authorization Header 和请求中的新 Credential secret 禁止进入日志、错误、Event payload、Audit payload、receipt 或 tracing attribute。

响应总是带 `X-Request-ID`。429/503 中存在安全重试窗口时带 `Retry-After`；不暴露 D1 bookmark、内部 SQL、表名或 Cloudflare 原始错误详情。

### 3.3 ID、时间、布尔与空值

- 不可变领域 ID 由 Worker 使用 `crypto.randomUUID()` 生成 UUID v4，以 JSON string 返回。
- Issue 的公开 identifier 由 D1 `INTEGER PRIMARY KEY AUTOINCREMENT` 分配的正整数形成 `CFK-<number>`；number 与 identifier 在实例内唯一、允许空洞、永不复用。
- Event sequence 同样使用 `INTEGER PRIMARY KEY AUTOINCREMENT`，只进入 opaque cursor 或 Owner 审计结果；所有公开整数必须保持在 JavaScript safe integer 范围内。
- D1 时间保存为 Unix epoch milliseconds `INTEGER`；API 返回 UTC RFC 3339 字符串，例如 `2026-08-28T12:34:56.789Z`。
- D1 布尔值使用带 `CHECK (value IN (0,1))` 的 `INTEGER`；API 使用 JSON boolean。
- PATCH 中字段缺失表示不修改；只有 schema 明确可空的字段接受 `null`，不能用空字符串代替清除。

### 3.4 稳定 key 与名称

- Workspace key：`[a-z][a-z0-9-]{1,31}`，创建前转为小写，创建后不可修改。
- Project key：`[A-Z][A-Z0-9-]{1,15}`，创建前转为大写，创建后不可修改。
- Workspace key 在实例内唯一；Project key 在 Workspace 内唯一；soft delete 后仍保留唯一性，不允许复用。
- display name 去除首尾空白后必须非空，最多 128 Unicode code points，不参与唯一性、认证或寻址。
- Label name 去除首尾空白后最多 64 Unicode code points；同一 Project 内按 SQLite `NOCASE` 规则唯一，soft delete 后仍保留名称，避免创建替身导致恢复冲突。`NOCASE` 的大小写折叠只承诺 SQLite 的 ASCII 语义，非 ASCII 名称按原文本区分。

### 3.5 请求上限与幂等

- Worker 在读取完整正文前执行流式/长度预检；JSON request 最大 128 KiB。
- `Idempotency-Key` 为调用方生成的 1～128 个可打印 ASCII 字符，不得包含 secret。
- 所有创建、命令和其他非天然幂等写入都要求 `Idempotency-Key`；纯读取和带 `expected_version` 的资源 PATCH/DELETE 不强制该 Header，但 Skill 可以统一提供。
- request fingerprint 是 `method + route_template + normalized_resource_scope + RFC 8785 canonical JSON body` 的 SHA-256；query 中影响写入语义的参数必须进入 normalized scope。
- 幂等记录保留 24 小时。重放前必须重新验证当前 Credential、Principal 状态和 effective authorization；授权失效时返回当前鉴权错误，不返回历史业务响应。

### 3.6 并发前置条件

- 所有可变资源包含从 1 开始的 `version`。
- PATCH、soft delete、restore、assignment、status、blocked、label association、relation 和 complete 请求都显式携带 `expected_version`；跨两个 Issue 的 Relation 写入同时携带两端当前 version。
- version 不匹配返回 409 `VERSION_CONFLICT`，`retryable=false`，并在调用者仍可见该资源时返回当前 version。
- `done` 只能通过 complete 命令进入；普通 Issue PATCH 把 status 设为 `done` 返回 `INVALID_TRANSITION`。
- assignee 不参与写权限；资格与当前授权必须在实际 D1 写入的同一 transaction predicate 中复核。

### 3.7 响应形状

为减少 Agent token 与嵌套层级，v0 不使用通用 `{data, meta}` 外壳：

- 单资源读取直接返回资源对象。
- 列表返回 `{items, next_cursor, has_more, resolved_scope?}`。
- 写入返回变更后的最小资源摘要，以及 `event_cursor`、`idempotent_replay`。
- DELETE 表示 soft delete 或 revoke，成功返回更新后的 tombstone/revocation 摘要，不返回 204。
- 响应中的 `allowed_actions` 是当前事实投影，不是未来授权保证；执行时仍重新鉴权。

## 4. Cursor 与查询合同

### 4.1 Cursor 格式

所有 cursor 都是调用方不可解释的 base64url canonical JSON，至少编码：

- `v`：cursor schema version；
- `kind`：列表类型；
- `last`：上一页最后一条的 keyset tuple；
- `filter_hash`：规范化过滤条件 SHA-256；
- `scope_hash`：本次调用者实际可读 Project ID 集合的 SHA-256。

cursor 不包含 secret，也不以保密性作为安全边界。服务端每次重新计算 filter/scope hash；不匹配返回 `CURSOR_SCOPE_MISMATCH`。无法解析、版本未知或 keyset 非法返回 `INVALID_CURSOR`。所有查询仍重新执行当前权限过滤，因此修改 cursor 不能读取无权资源。

### 4.2 分页和排序

- 默认 `limit=20`，最大 100；查询使用 `limit + 1` 推导 `has_more`，不为普通列表执行总数 `COUNT(*)`。
- 普通 Issue 列表按 `updated_at DESC, number DESC`；候选列表按 `priority_rank ASC, created_at ASC, number ASC`。
- Comment 按 `created_at ASC, id ASC`；Event 按 `sequence ASC`；tombstone 按 `deleted_at DESC, stable_id DESC`。
- 禁止 offset pagination 和 `ORDER BY RANDOM()`。

### 4.3 Scope 与关键词

- 可重复 `project={workspace_key}/{project_key}` 最多 20 个；可重复 `workspace={workspace_key}` 最多 20 个。同维度 OR、不同维度 AND。
- Project Invite 一次最多携带 20 个 Project grant specifications，以适配 Agent 上下文、D1 100 bound parameter 上限和单操作可审阅性。
- `q` 经 Unicode NFKC、lowercase 和首尾空白清理后为 1～128 UTF-8 bytes。title 查询使用参数化的 `instr(title_search, ?1) > 0`，不把调用方文本解释成 `LIKE/GLOB` pattern。
- v0 的 Issue `q` 只匹配 identifier exact 或规范化 title substring，不扫描 body/comment。substring 查询不承诺索引加速；它允许省略 Project filter，但响应必须在 `resolved_scope` 中警告 `broad_search=true`，超过应用扫描预算时返回 `QUERY_SCOPE_TOO_BROAD`。Skill 仍强烈推荐明确 Project。
- v0 不建 FTS5 virtual table。真实用量证明普通 title 搜索不足时，按 D-214 优先设计基于 Cloudflare Vectorize、可丢弃且可重建的搜索派生层，而不是把新的索引生命周期默默加入核心 schema。Vectorize 查询仍必须先经过 D1 授权 scope 过滤，且不能成为权限、CAS、唯一约束或刚写即读的判断依据；未启用、同步滞后或故障时回退到 D1 结构化过滤与基础 identifier/title 查询。

## 5. HTTP 资源与端点

下表中的“writer”始终包括 Deployment Owner；Owner 控制面权限不通过 Project Grant 表达。

### 5.1 公共、发现与当前身份

| Method | Path | 权限 | 语义 |
| --- | --- | --- | --- |
| GET | `/healthz` | Public | 仅返回 service/schema version 与 D1 reachability，不泄露实例内容 |
| GET | `/openapi.json` | Public | 当前部署的 v1 OpenAPI |
| GET | `/invite?code=...` | Public bearer URL | 无副作用 bootstrap 文档/摘要，`no-store`、`no-referrer` |
| GET | `/api/v1/meta` | Authenticated | instance、service/schema version、capabilities、当前可见 scope 摘要 |
| GET | `/api/v1/me` | Authenticated | 当前 Principal、Credential fingerprint、Grants 摘要和 allowed actions |
| PATCH | `/api/v1/me` | Authenticated | 只修改自己的 display name，带 `expected_version` |
| GET | `/api/v1/events` | Authenticated | 按当前可读 Project 过滤的 domain Event 增量读取 |

### 5.2 Workspace、Project 与状态显示

| Method | Path | 权限 | 语义 |
| --- | --- | --- | --- |
| GET/POST | `/api/v1/workspaces` | visible / Owner | 列表；创建一个 Workspace |
| GET/PATCH/DELETE | `/api/v1/workspaces/{workspace_key}` | visible / Owner | 读取、改 display name、soft delete |
| POST | `/api/v1/workspaces/{workspace_key}/commands/restore` | Owner | 原子恢复容器 |
| GET/POST | `/api/v1/workspaces/{workspace_key}/projects` | visible / Owner | 列表；创建一个 Project |
| GET/PATCH/DELETE | `/api/v1/workspaces/{workspace_key}/projects/{project_key}` | reader / Owner | 读取；修改 name/context；soft delete |
| POST | `/api/v1/workspaces/{workspace_key}/projects/{project_key}/commands/restore` | Owner | 原子恢复 Project |
| GET | `/api/v1/workspaces/{workspace_key}/projects/{project_key}/statuses` | reader | 五个固定状态及显示名 |
| PATCH | `/api/v1/workspaces/{workspace_key}/projects/{project_key}/statuses/{status_key}` | Owner | 只改显示名，带 Project `expected_version` 并递增 Project version |

容器列表支持 `deleted=exclude|only`，默认 `exclude`。容器 restore 不级联恢复单独删除的子资源或撤销的 Grants。

### 5.3 Issue、Label、Relation 与 Comment

| Method | Path | 权限 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/v1/issues` | Authenticated | 跨授权 Project 聚合列表 |
| GET | `/api/v1/issues/candidates` | Authenticated | 只读确定性候选列表 |
| GET/POST | `/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues` | reader / writer | Project 列表；创建一个 Issue |
| GET/PATCH/DELETE | `/api/v1/issues/{identifier}` | reader / writer | detail；普通字段/CAS 更新；soft delete |
| POST | `/api/v1/issues/{identifier}/commands/restore` | writer | 恢复一个 Issue |
| GET | `/api/v1/issues/{identifier}/context` | reader | 64 KiB 有界 Agent context |
| POST | `/api/v1/issues/{identifier}/commands/assign-to-me` | writer | assignee 设为当前 Principal |
| POST | `/api/v1/issues/{identifier}/commands/report-blocked` | writer | 只写人工 blocked reason；依赖关系使用独立 Relation 操作 |
| POST | `/api/v1/issues/{identifier}/commands/clear-blocked` | writer | 只清人工 blocked reason |
| POST | `/api/v1/issues/{identifier}/commands/complete` | writer | completion Comment + done + Event 原子提交 |
| POST | `/api/v1/issues/{identifier}/commands/add-label` | writer | 每次只添加一个现有 Label |
| POST | `/api/v1/issues/{identifier}/commands/remove-label` | writer | 每次只移除一个 Label association |
| GET/POST | `/api/v1/issues/{identifier}/comments` | reader / writer | 分页读取；追加一个 standard Comment |
| GET/DELETE | `/api/v1/comments/{comment_id}` | reader / writer | 读取；只 soft delete standard Comment |
| POST | `/api/v1/comments/{comment_id}/commands/restore` | writer | 只恢复 standard Comment |
| GET/POST | `/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels` | reader / writer | 列表；创建一个 Label |
| GET/PATCH/DELETE | `/api/v1/labels/{label_id}` | reader / writer | 读取、改名/颜色、soft delete |
| POST | `/api/v1/labels/{label_id}/commands/restore` | writer | 恢复一个 Label |
| GET/POST | `/api/v1/issues/{identifier}/relations` | reader / writer on both ends | 可见关系；创建一个 Relation |
| GET/DELETE | `/api/v1/relations/{relation_id}` | reader / writer on both ends | 读取；soft delete |
| POST | `/api/v1/relations/{relation_id}/commands/restore` | writer on both ends | 恢复一个 Relation |

Issue PATCH 可修改 `title`、`body`、`status_key`（除进入 `done`）、`priority_key` 和 `assignee_principal_id`。一次请求可以修改同一 Issue 的多个普通字段，因为它仍是一个资源的单一 CAS 更新；它不能顺带创建 Comment、Relation、Label 或其他 Issue。

Relation 的方向固定：`blocks` 表示 source blocks target；`parent` 表示 source child has parent target；`duplicate` 表示 source duplicates target；`related` 为无向关系，服务端按两个 Issue immutable ID 排序后保存。blocker 只有在 source status 为 `done` 时自动解除；`canceled` 不等于完成，调用方应删除 Relation 或显式调整目标。

### 5.4 Invitation、Principal、Credential、Grant 与 Audit

| Method | Path | 权限 | 语义 |
| --- | --- | --- | --- |
| POST | `/api/v1/invitations/redeem` | Invite capability + conditional auth | 兑换 Project/Recovery Invite |
| GET/POST | `/api/v1/admin/invitations` | Owner | 列表；创建一种明确 kind/mode 的 Invitation |
| GET/DELETE | `/api/v1/admin/invitations/{invitation_id}` | Owner | 读取；撤销未兑换 Invitation |
| GET | `/api/v1/admin/principals` | Owner | 按 ID、名称文本、Project membership 查找 |
| GET | `/api/v1/admin/principals/{principal_id}` | Owner | 身份、Grant、assignee、Credential 非秘密摘要 |
| POST | `/api/v1/admin/principals/{principal_id}/commands/disable` | Owner | 禁用一个非 Owner Principal；v0 不提供 enable |
| GET | `/api/v1/admin/principals/{principal_id}/credentials` | Owner | 只返回 ID、fingerprint、issued/last-used/revoked |
| DELETE | `/api/v1/admin/credentials/{credential_id}` | Owner | 撤销一个参与者 Credential；Owner Credential 生命周期走 deploy Skill |
| GET/POST | `/api/v1/admin/projects/{project_id}/grants` | Owner | 列表；创建或重新授予一条明确 Grant |
| GET/PATCH/DELETE | `/api/v1/admin/grants/{grant_id}` | Owner | 读取；改 reader/writer；撤销，均带 expected version |
| GET | `/api/v1/admin/audit-events` | Owner | 按 sequence 增量读取安全与领域审计投影 |

Project Invite 创建 body 必须逐项给出 Project immutable ID 与 `reader|writer`，1～20 项且去重。API 不采用 Skill 的默认 role 建议。Recovery Invite 必须给出 bound `principal_id` 和不可变 `rotation|full_recovery` mode，不能同时携带 Project grants。

## 6. 核心请求与响应 Schema

### 6.1 通用资源摘要

所有资源摘要至少返回自身 immutable ID、稳定寻址字段、version、created/updated 时间和 soft-delete 状态；没有业务含义的内部列不返回。

```json
{
  "id": "uuid",
  "version": 3,
  "created_at": "2026-08-28T12:34:56.789Z",
  "updated_at": "2026-08-28T12:40:00.000Z",
  "deleted_at": null
}
```

### 6.2 Issue summary/detail

```json
{
  "id": "uuid",
  "number": 123,
  "identifier": "CFK-123",
  "workspace": {"key": "agent-tools", "display_name": "Agent Tools"},
  "project": {"id": "uuid", "key": "CORE", "display_name": "Core"},
  "title": "Implement invitation redeem",
  "status": {"key": "todo", "category": "unstarted", "display_name": "Todo", "terminal": false},
  "priority": "high",
  "labels": [{"id": "uuid", "name": "security", "color": "#B42318"}],
  "assignee": {"principal_id": "uuid", "display_name": "陈", "available": true},
  "needs_reassignment": false,
  "is_blocked": false,
  "version": 3,
  "created_at": "2026-08-28T12:34:56.789Z",
  "updated_at": "2026-08-28T12:40:00.000Z"
}
```

detail 在此基础上增加 `body`、人工 blocked reason、可见 Relation 摘要、Comment continuation 和 `allowed_actions`。任何无权 relation endpoint 都不进入数组或计数。

### 6.3 写请求

```json
{
  "expected_version": 3,
  "title": "New title",
  "assignee_principal_id": null
}
```

创建 Issue：

```json
{
  "title": "Implement invitation redeem",
  "body": "Optional Markdown",
  "status_key": "backlog",
  "priority_key": "none",
  "assignee_principal_id": null,
  "label_ids": []
}
```

`status_key`、`priority_key`、`assignee_principal_id` 和 `label_ids` 缺失时分别使用 `backlog`、`none`、`null`、空数组。`label_ids` 最多 20 个且只绑定既有 active Label；这是单个 Issue 创建的内部组成，不是批量 Issue API。

complete：

```json
{
  "expected_version": 7,
  "summary": "Implemented and verified invite replay",
  "verification": ["unit tests", "local D1 integration"],
  "artifacts": [{"kind": "url", "value": "https://example.invalid/run/123"}],
  "follow_ups": []
}
```

整个 completion payload 最大 32 KiB。服务端校验结构但不读取 artifact，也不把内容当指令。

Invitation redeem 使用由本地可信脚本预先生成并安全落盘的 Credential token。首次创建 Principal 的 Project Invite 示例：

```json
{
  "invite_code": "opaque-one-time-secret",
  "redeem_as": "new_principal",
  "display_name": "陈",
  "new_credential_token": "cfk_v1_prefix_secret"
}
```

`redeem_as` 固定为：

- `new_principal`：仅用于 Project Invite；不带 Authorization，必须提供 display name 与新 token；
- `current_principal`：仅用于 Project Invite；必须使用当前有效 Credential 认证，不接受新 token；
- `recovery`：仅用于 Principal Recovery Invite；必须提供新 token；`rotation` 还要求旧 Credential 认证，`full_recovery` 不要求旧 Credential。

服务端只保存新 token 的 digest，并在响应中返回 Credential ID/fingerprint，不回传明文 token。这样即使响应丢失，本地仍持有同一 token，可以用相同 Invite code、请求体和 `Idempotency-Key` 重试。`invite_code` 与 `new_credential_token` 都属于请求 secret，禁止进入日志、Event、Audit、idempotency response 或错误详情。

### 6.4 错误

```json
{
  "code": "VERSION_CONFLICT",
  "message": "Issue version changed.",
  "request_id": "uuid",
  "retryable": false,
  "recovery": "refresh_resource",
  "details": {"current_version": 4}
}
```

除 Frozen Foundation 已列出的 code 外，本文增加：

- `INVALID_CURSOR`；
- `RESOURCE_DELETED`（只在调用者有权使用 tombstone 视图时）；
- `LABEL_LIMIT_EXCEEDED`；
- `RELATION_SCOPE_MISMATCH`；
- `INVITATION_MODE_MISMATCH`；
- `PRINCIPAL_DISABLED`；
- `QUERY_SCOPE_TOO_BROAD`（仅保护无法在应用预算内安全执行的查询，不替代正常分页）。

## 7. D1 Schema 通用规则

### 7.1 类型与命名

- 表名、列名、索引名使用 `snake_case`；应用表不使用 Cloudflare 保留前缀。
- UUID、enum、digest、JSON 和正文使用 `TEXT`；时间、version、sequence、布尔和 issue number 使用 `INTEGER`。
- 除 Issue number、Event sequence 和明确列出的复合主键外，表中的 `id` 都是 UUID v4 `TEXT PRIMARY KEY`；外部稳定 identifier/key 另建唯一约束，不把可变显示名称作为主键。
- JSON 列必须带 `CHECK (json_valid(column))`；仍由 Worker 在写入前执行完整 JSON Schema 校验。
- 所有外键显式声明，默认 `ON UPDATE RESTRICT ON DELETE RESTRICT`。业务 API 不执行物理 delete，因此不使用业务级 cascade。
- soft-deletable 表统一包含 `deleted_at`、`deleted_by_principal_id`、`version`；容器的 effective deletion 通过 join 判断，不批量改写子行。
- 所有 SQL 使用 `prepare(...).bind(...)`；动态排序、字段名和 SQL 片段只能来自代码内 allowlist，不能绑定或拼接用户文本。
- schema 变更只通过 D1 versioned migrations；应用启动和请求路径不执行 `CREATE/ALTER/DROP/PRAGMA optimize`。

### 7.2 可恢复操作标识

每个写请求生成非秘密 UUID `operation_id`。新建资源保存 `created_operation_id`，可变资源保存最近一次成功写入的 `last_operation_id`；`operation_commits.operation_id` 是一次业务原子操作是否真正提交的唯一判据。一次操作可以写多条 Event，每条使用从 0 开始、由操作配方固定的 `event_index`。

这些列不是公开业务字段，只用于：

- D1 transaction 内把后续 Event/Comment/association 写入绑定到刚刚成功的条件写；
- Worker 在业务 transaction 已提交但响应或幂等 finalize 丢失时通过 operation commit 与资源读回结果；
- 防止两个相同 Idempotency-Key 的并发请求重复产生副作用。

普通读取不能依赖 `last_operation_id` 推导业务状态，operation metadata 也不能替代 version/CAS。

## 8. D1 表与约束

### 8.1 实例、身份与授权

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `instance_meta` | singleton=1, instance_id, owner_principal_id, service_version, schema_version, created_at | 恰好一行；owner 不可由应用 API 修改 |
| `principals` | id, display_name, version, disabled_at, created_at, updated_at, last_operation_id | display name 非唯一；Owner Principal 不能 disable |
| `credentials` | id, principal_id, token_prefix, token_digest, issued_at, last_used_at, revoked_at, revoked_by_principal_id, revoke_reason, created_operation_id, last_operation_id | token_digest unique；无 expiry；secret 永不保存 |
| `project_grants` | id, principal_id, project_id, role, revoked_at, revoked_by_principal_id, version, created_at, updated_at, last_operation_id | unique(principal_id, project_id)；role CHECK reader/writer；Owner 不建 Grant |

`last_used_at` 只允许按低频阈值更新，例如距离上次记录超过 24 小时；不能每次请求写 D1。鉴权逻辑只看 token digest、revoked_at 和 principal.disabled_at，不依赖 last-used。

### 8.2 Workspace、Project 与状态

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `workspaces` | id, key, display_name, version, deleted_at/by, created/updated, created_operation_id, last_operation_id | key unique，删除后不复用 |
| `projects` | id, workspace_id, key, display_name, context, version, deleted_at/by, created/updated, created_operation_id, last_operation_id | unique(workspace_id,key)，删除后不复用；context 最大 32 KiB UTF-8 bytes，由 CHECK 与 Worker 双重校验 |
| `project_status_names` | project_id, status_key, display_name, updated_at/by, last_operation_id | PK(project_id,status_key)；status_key 固定五值；并发前置条件使用所属 Project version |

固定状态 category/position/terminal 保存在 Worker 常量与 OpenAPI enum，不建可变 workflow 表。Project status name 没有 override 行时使用默认显示名。

### 8.3 Issue、Label、Relation 与 Comment

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `issues` | number INTEGER PK AUTOINCREMENT, id, project_id, title, title_search, body, status_key, priority_key/rank, assignee_principal_id, blocked_reason, version, deleted_at/by, created/updated/by, created_operation_id, last_operation_id | id unique；五状态/五优先级 CHECK；priority key/rank 一致；正文 bytes CHECK |
| `labels` | id, project_id, name COLLATE NOCASE, color, version, deleted_at/by, created/updated, created_operation_id, last_operation_id | unique(project_id,name) 覆盖 tombstone；color 为 null 或 `#RRGGBB` |
| `issue_labels` | issue_id, label_id, added_at/by, created_operation_id | PK(issue_id,label_id)；只表示当前 association；remove 物理删除 association 并由 Event 保留历史 |
| `issue_relations` | id, workspace_id, kind, source_issue_id, target_issue_id, version, deleted_at/by, created_at/by, created_operation_id, last_operation_id | source != target；同语义关系 unique；两端必须同 Workspace |
| `comments` | id, issue_id, kind, author_principal_id, body, completion_json, reply_to_comment_id, version, deleted_at/by, created_at, created_operation_id, last_operation_id | standard/completion 的列组合 CHECK；completion 不可更新/删除 |

`title_search` 由 Worker 对 title 执行 Unicode NFKC + lowercase 后写入，只用于 v0 title substring；它不是显示字段。Issue number 由 D1 自动分配，因此并发创建不会重复；事务失败可能产生空洞，符合 Frozen 合同。

`priority_rank` 固定为 urgent=0、high=1、medium=2、low=3、none=4，并用 CHECK 保证与 `priority_key` 一致，避免候选列表对文本 enum 排序或建立表达式临时排序。

Relation 唯一性：

- `related` 保存前按 immutable Issue ID 排序；
- 其他 kind 保留 source/target 方向；
- unique(kind, source_issue_id, target_issue_id) 覆盖 soft-deleted 行，重复创建应引导 restore 而不是产生第二条 identity。

`is_blocked` 不持久化：查询时以非空人工 reason，或存在一个 active `blocks` Relation 且 source Issue `status_key != 'done'` 推导。`canceled` blocker 不自动解除关系。

### 8.4 Invitation、Event 与幂等

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `invitations` | id, kind, code_prefix, code_digest, bound_principal_id, recovery_mode, expires_at, revoked_at/by, redeemed_at/by, created_at/by_owner, created_operation_id, last_operation_id | code_digest unique；kind/mode/bound principal 的跨列 CHECK；一次性 |
| `invitation_project_grants` | invitation_id, project_id, role | PK(invitation_id,project_id)；仅 project_grant kind，最多 20 由 Worker + transaction guard 校验 |
| `invitation_redemption_items` | invitation_id, project_id, operation_id, outcome, effective_role | PK(invitation_id,project_id)；immutable；记录 created/regranted/already_has_access，用于精确 replay |
| `operation_commits` | operation_id, primary_subject_type/id, last_event_sequence, committed_at | operation_id PK；由业务 batch 最后一条条件 INSERT 写入；immutable |
| `events` | sequence INTEGER PK AUTOINCREMENT, id, stream, type, operation_id, event_index, actor_principal_id, actor_credential_id, authorized_via, grant_id, workspace_id, project_id, subject_type/id, payload_json, created_at | unique(operation_id,event_index)；append-only；stream domain/security |
| `idempotency_records` | id, scope_key, method, route_template, resource_scope_hash, idempotency_key, request_hash, operation_id, state, response_status, response_json, created_at, expires_at | unique(scope_key,method,route_template,resource_scope_hash,idempotency_key)；state pending/committed |

`scope_key` 为 `principal:<id>`；没有旧 Credential 的 `new_principal` 或 `full_recovery` 兑换使用 `invitation:<id>`。它永不依赖 nullable 列的 UNIQUE 行为。`response_json` 只保存已去敏且不超过应用响应上限的精确结果。

`events` 是一个物理 append-only 表、两个逻辑读取面：参与者 Event feed 只查询 `stream='domain'` 且执行 Project 授权过滤；Owner audit endpoint 可以读取 domain + security 投影。一个跨 Project 或安全敏感操作可以写多条具有同一 operation ID 的 Event；每条 domain Event 只绑定一个明确 Project，避免用 JSON Project 列表绕过授权查询。`operation_commits.last_event_sequence` 指向该操作最后一条 Event，作为写响应的 `event_cursor` 基础。

## 9. 必需索引与查询形状

索引只服务已知高频查询，避免为了“可能有用”增加每次写入成本。冻结前必须用 `EXPLAIN QUERY PLAN` 证明下列查询不做意外全表扫描：

| 索引 | 服务查询 |
| --- | --- |
| unique `credentials(token_digest)`；`credentials(principal_id, revoked_at)` | 每请求鉴权；Owner Credential 摘要 |
| unique `workspaces(key)` | Workspace path lookup |
| unique `projects(workspace_id,key)`；`projects(workspace_id,deleted_at,display_name,id)` | Project path/list/tombstone |
| unique `project_grants(principal_id,project_id)`；`project_grants(project_id,revoked_at,role,principal_id)` | 授权与 Project 成员查找 |
| `issues(project_id,deleted_at,updated_at DESC,number DESC)` | 普通 Project Issue 列表 |
| `issues(project_id,status_key,deleted_at,priority_rank,created_at,number)` | 候选列表 |
| `issues(project_id,assignee_principal_id,deleted_at,status_key,updated_at DESC)` | assignee 与 needs-reassignment 候选 |
| `labels(project_id,name COLLATE NOCASE)` | Label lookup/unique |
| `issue_labels(issue_id,label_id)` 与 `issue_labels(label_id,issue_id)` | Issue/Label 双向过滤 |
| `comments(issue_id,deleted_at,created_at,id)` | 评论分页/context |
| `issue_relations(source_issue_id,deleted_at,kind)` 与 target 对称索引 | 关系与 blocked 投影 |
| unique `invitations(code_digest)`；`invitations(created_at DESC,id)` | redeem 与 Owner 列表 |
| `events(project_id,stream,sequence)`；`events(stream,sequence)` | Project-filtered Event 与 Owner audit |
| `operation_commits(operation_id)` | 响应丢失后的提交探针 |
| unique idempotency scope key；`idempotency_records(expires_at,id)` | claim/replay 与有界清理 |

跨最多 100 个 ID 的二次读取使用一个 JSON array bound parameter + `json_each(?1)`，避免 N+1 和撞到 100 parameters 限制。列表只选择投影所需列，不使用 `SELECT *`。Labels、assignee 和 blocked 摘要应通过有界 join/二次查询组装，不能每个 Issue 单独请求 D1。

普通读取目标不超过 10 次 D1 query；复杂 context/admin detail 不超过 20 次；任何公开请求不得接近 Free profile 当前 50 次上限。该预算包含鉴权与 scope 解析。

## 10. D1 原子写入与幂等状态机

### 10.1 为什么不能只做“先读后写”

Worker 在 `db.batch()` 提交前无法在同一个 transaction callback 中读取第一个 statement 的结果并动态决定后续 SQL。正确模式是：

1. Worker 预生成 IDs、timestamp、operation ID 和规范化 request hash；
2. 只读鉴权、schema 校验和幂等 preflight 用于快速失败，但不作为最终授权保证；
3. business batch 中的第一条 INSERT/UPDATE 使用条件 SQL，同时复核 active Credential、Principal、Owner/Grant、容器状态和 expected version；
4. 后续 Comment/Relation/Event 写入以相同 operation ID 和已成功业务行作为条件；任何真实 SQL/constraint 失败使整个 batch 回滚；
5. batch 最后只有在该配方预期的业务变更与 Event 都存在时，才条件写入唯一 `operation_commits` 行；
6. Worker 检查 `meta.changes`/operation readback，区分成功、version conflict、权限变化和状态冲突；
7. 响应丢失时以 operation ID 找到 operation commit、Event 和资源，而不是再次盲写。

### 10.2 Idempotency record 状态机

`pending` 记录可以先于业务 transaction 存在，但它不是领域成功事实：

1. claim：按完整 unique scope 插入 pending；同 key/different request hash 立即冲突；
2. probe：若 committed，重新鉴权后返回 stored response；若 pending，先按 operation ID 检查 `operation_commits` 是否已提交；
3. execute：不存在 operation commit 时才执行可恢复 business batch；
4. finalize：业务提交后读回最小结果，把精确去敏 response 写为 committed；
5. resume：若 Worker 在 business commit 与 finalize 之间中断，重试从唯一 operation ID 重建并 finalize，不重复副作用；
6. expire：超过 24 小时的 pending/committed 记录不再作为安全重试依据，使用有界维护 SQL分批清理。

同一 key 的两个并发请求共享 operation ID。创建使用 `created_operation_id UNIQUE` 或对应业务唯一约束防重；更新使用 expected version 与 `last_operation_id`；`operation_commits.operation_id` 是最终提交探针，Event 使用 `(operation_id,event_index)` 防止同一操作重复写入同一逻辑事件。

### 10.3 关键业务 batch

| 操作 | 同一 transaction 必须包含 |
| --- | --- |
| Issue create | 最终授权 predicate、Issue INSERT、0～20 个既有 Label association、domain Event |
| Issue PATCH/assignment/status | 最终授权 + expected version 条件 UPDATE、domain Event |
| complete | 最终授权 + expected version、Issue → done/version+1、immutable completion Comment、domain Event |
| report-blocked | Issue CAS、人工 blocked reason、domain Event；不创建 Relation |
| Relation cross-Project write | 两端可见/active、同 Workspace、两端 writer、两端 expected version、Relation、两端 version 更新、Event |
| Project Invite redeem | Invite active/未过期/未消费、新或已认证 Principal、可选新 Credential、逐 Project Grant outcome、Invitation consume、redemption items、每 Project domain Event 与 security summary Event |
| recovery redeem | Invite kind/mode/bound Principal、可选旧 Credential 证明、新 Credential、精确旧 Credential 撤销集合、Invitation consume、security Event |
| Grant revoke/role/regrant | Owner Credential/Principal、Grant CAS、Event；assignee 不批量改写 |
| Container soft delete/restore | Owner、容器 CAS、Event；不更新子行/Grant |

业务 batch 必须保持短小。公开 API 不暴露 batch；内部 `db.batch()` 只是实现一个领域原子操作。

### 10.4 重试

- Worker 可以依赖 D1 对只读查询的内建安全重试，但仍必须处理最终失败。
- 写操作只有在 Idempotency-Key + operation probe 能证明安全时才由应用重试；不按字符串模糊匹配所有 D1 错误后盲重放。
- 503 `retryable=true` 必须给出 `Retry-After` 和 `recovery=retry_after`；version/cursor/validation 冲突永不标为可原样重试。
- D1 quota/overload/storage 错误映射为 `QUOTA_EXCEEDED` 或通用 503，保留 request ID，不回传 Cloudflare 内部错误文本。

## 11. Soft delete、恢复与不可变历史

- Workspace、Project、Issue、Label、Relation、standard Comment 只写 tombstone 字段，不物理删除业务行。
- completion Comment、Event、Invitation redemption item 不允许 update/delete；通过应用层 allowlist、测试和审计保证 append-only。
- issue-label association 的 remove 是关系解除而不是删除 Label；允许在同一 transaction 中条件删除 association 并写 domain Event。Label soft delete 保留 association，恢复后重新可见。
- effective-deleted 查询必须 join 父 Workspace/Project；默认读取把父容器删除视为 404。
- `deleted=only` 只返回资源自身 tombstone，不把父容器暂停展开成子资源 tombstone。
- restore 使用 expected version，并再次验证父容器 active、名称/关系唯一约束和权限；不可恢复时返回结构化原因，不静默改名或创建新 ID。
- v0 没有业务 hard-delete endpoint；幂等过期记录的受控清理不属于业务资源 purge。

## 12. OpenAPI 组织与 Agent 可用性

最终 `/openapi.json` 至少满足：

- 每个 operation 有稳定 `operationId`，命名为 `verbResource`，例如 `listIssues`、`completeIssue`；
- tag 固定为 `meta`、`identity`、`workspaces`、`projects`、`issues`、`comments`、`labels`、`relations`、`invitations`、`admin`、`events`；
- description 只解释能力、权限、参数、后果和恢复，不规定上层 Agent 何时调用；
- 对每个写入明确 `Idempotency-Key`、`expected_version`、soft delete、Event 和可能错误；
- enum 同时给稳定 key 及中文解释，示例不使用真实 token/code；
- security scheme 只有 Bearer Credential；Invite redeem 的条件认证通过 operation 说明和 request schema 表达；
- 所有 list/cursor/error schema 复用公共 component，但不增加无意义通用响应外壳；
- OpenAPI 自身不包含 canonical Skill 安装指令、secret、本地路径或上层编排 prompt。

## 13. Migration 与本地/远端验证

- 初始 DDL 作为 `0001_initial` migration；后续 migration 只追加、不可改写已经发布的文件。
- migration 使用稳定 D1 database name，不只依赖可能变化的 binding 名；执行前后读回远端 database ID、instance ID 和 schema version。
- 外键默认开启；表重建 migration 必须使用 D1 支持的 `PRAGMA defer_foreign_keys`，并在 transaction 结束前消除全部违反项。
- 大规模 backfill 分成有界 migration/journal 步骤，不能用单条超大 UPDATE 占满 D1 队列。
- 每次 schema release 同时声明最小/最大兼容 service version；Worker rollback 不等于 schema rollback。
- 初始实现前必须在本地 D1 验证 migration、约束与主要 query plan；进入部署前再在一次隔离远端 D1 上验证平台实际行为。远端验证需要用户另行授权，本文不授予该权限。

## 14. 冻结前完成定义

本文从 Draft 变为 Frozen 前至少需要：

1. 逐项证明端点没有引入 Frozen Foundation 之外的业务角色、批量写入或权限继承。
2. 生成可解析的 OpenAPI 原型，并检查 operationId 唯一、所有写入前置条件和错误响应。
3. 生成 `0001_initial` DDL 原型，在本地 D1 应用并通过 foreign key、CHECK、unique 和 soft-delete/restore 验例。
4. 用 `EXPLAIN QUERY PLAN` 验证鉴权、Issue list/candidates、Event、Invitation、Comment 和 Grant 查询使用预期索引。
5. 验证 D1 `batch()` 对 complete、并发 assign-to-me、跨 Project Relation、Invite redeem 的 rollback 与 response-loss resume。
6. 用 Free profile 应用预算审查最坏 query 次数、bound parameters、SQL/row size 和 Worker CPU 风险。
7. 将真正改变业务体验、安全或恢复边界的差异集中提交用户确认；纯技术细节由本文按简单、可恢复、少写放大原则收敛。

## 15. 当前 Draft 结论

本轮没有发现必须修改两份 Frozen 上游 SPEC 的业务冲突。以下属于本文新增但可从现有原则推导的 Draft 技术合同，冻结前应重点复核：

- Workspace key 小写 slug、Project key 大写短 key；
- Invite 单次最多 20 个 Project grants；
- `q` 只做 identifier/title 搜索，不搜索 body/comment；
- v0 不使用 FTS5；后期检索增强优先采用 Vectorize 可重建派生索引；
- canceled blocker 不自动视为完成；
- 一个物理 Event 表通过 stream/权限形成参与者 Event 与 Owner Audit 两个逻辑读取面；
- D1 条件 SQL + operation commit + pending/committed idempotency state machine 代替传统 callback transaction。

这些选择没有增加新角色、权限或产品模块。若后续原型证明某项无法在 D1 上可靠实现，应先修订本文 Draft；不得通过引入 Durable Objects、KV 或隐藏批量 API绕过 Frozen Foundation。
