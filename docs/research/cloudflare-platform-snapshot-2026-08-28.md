# Cloudflare 平台能力快照

- 快照日期：2026-08-28
- 性质：易漂移研究事实，不是长期产品承诺
- 来源：Cloudflare 官方文档与定价页

本次已于 2026-08-28 在线读回下列官方页面。此文件名和日期表示本次复核时间；后续复核应新增或替换带日期的快照，不把这里的额度当作永久合同。

Cloudflare 会调整免费额度、计费模型、模型目录和产品限制。部署、发版或写成本承诺前必须重新核对官方页面。

## Workers 与 Static Assets

Workers Free 当前包括：

- 100,000 个动态请求/天；
- 每个 HTTP 请求 10 ms CPU；
- 128 MB 内存；
- 每次调用 50 个常规 subrequests；
- Worker bundle 3 MB。

Static Assets 请求免费且不限量；Free 每个 Worker version 最多 20,000 个文件，单文件 25 MiB。这个边界足以承载一个很小的维护页。

Cloudflare Free 账户允许的 HTTP 请求体上限远高于本项目的应用合同；cfKanban 仍主动把 JSON 请求限制为 128 KiB，避免 Agent 误传大日志并控制 D1 写放大。Static Assets 不是 v0 管理面的必需依赖；Invite bootstrap 可以由 Worker 动态返回，未来若采用静态资源也只是实现选择。

来源：

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Static Assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

架构含义：10 ms CPU 适合简洁 CRUD 和条件 SQL，不适合在同步请求里做大段文本分析、复杂 AI 编排或重计算。

## D1

D1 Free 当前包括：

- 5,000,000 rows read/天；
- 100,000 rows written/天；
- 500 MB/数据库；
- 10 个数据库；
- 5 GB/账户；
- 7 天 Time Travel。

与 v0 设计直接相关的其他 Free 限制包括：每次 Worker invocation 最多 50 次 D1 查询、单个 row/string/BLOB 最大 2 MB、单条 SQL 最大 100 KB、最多 100 个 bound parameters。cfKanban 的应用级正文、评论、分页和单操作请求上限会显著低于这些平台上限。

达到 Free 的每日读写或容量限制后，后续操作会失败；不会自动转为付费按量。D1 按扫描行而不是返回行计量，适当索引虽增加少量写行，通常会显著减少读取成本。

每个 D1 数据库串行处理查询。D1 `batch()` 中的语句按顺序执行并作为 SQL transaction；任一失败会回滚整批。

未开启 read replication 时，读写都走 primary。开启后 replica 异步复制，客户端需要 Sessions API/bookmark 才能获得 session 内 sequential consistency 和 read-your-own-writes。

来源：

- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 database batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 read replication and consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/)

## Workers KV

KV Free 当前包括：

- 100,000 reads/天；
- 1,000 writes/天；
- 1,000 deletes/天；
- 1,000 list operations/天；
- 1 GB 存储。

KV 是最终一致的。并发写同一 key 可能互相覆盖，其他地区最多约 60 秒或 `cacheTtl` 时间看到旧值。

来源：

- [Workers pricing — KV table](https://developers.cloudflare.com/workers/platform/pricing/#workers-kv)
- [KV FAQ and consistency](https://developers.cloudflare.com/kv/reference/faq/)
- [KV concurrent writes](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)

架构含义：KV 不适合 Issue 状态、assignment、权限撤销、幂等或需要 CAS 的协调事实。v0 不需要 KV。

## Durable Objects

SQLite-backed Durable Objects 当前同时支持 Free 与 Paid。Free 当前包括：

- 100,000 requests/天；
- 13,000 GB-s duration/天；
- 5,000,000 rows read/天；
- 100,000 rows written/天；
- 5 GB 总存储。

每个对象是单线程协调点，适合按 Project 切分的实时协调、WebSocket 和 alarm。

当前官方文档存在一个容量表述差异：Limits 页面写 Free 账户总计 5 GB，FAQ 仍提到 Free 单对象 1 GB。设计不应依赖 Free 单对象超过 1 GB，真正启用前应在控制台和最新文档复核。

来源：

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/)

架构含义：DO 已有免费层，但 D1 CAS 足以作为 v0 起点；不要建立 D1/DO 双事实源。

## Queues

Queues Free 当前包括 10,000 operations/天，消息固定保留 24 小时。正常消息通常产生 write、read、delete 三次 operation，因此免费额度大约对应 3,333 条一次成功消费的消息/天。

Queues 是至少一次投递，消息可能重复；消费者必须幂等。它适合异步派生，不适合核心状态账本。

来源：

- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)

## R2

R2 Standard 当前免费额度：

- 10 GB-month/月；
- 1,000,000 Class A operations/月；
- 10,000,000 Class B operations/月；
- 互联网 egress 免费。

R2 需要启用相应订阅，超出免费额度可能产生费用，因此不属于“严格零账单”核心。它适合附件、Agent 产物和导出。

来源：[R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Vectorize

“Vectorize 只有付费版”已经过时。当前 Workers Free 包括：

- 30,000,000 queried vector dimensions/月；
- 5,000,000 stored vector dimensions；
- 100 个 index；
- 最大 1,536 dimensions/vector。

Free 当前每个 index 最多 1,000 个 namespace。查询在返回 values 或 metadata 时 `topK` 上限为 50，不返回这些内容时上限为 100。

Vectorize mutation 是异步处理，通常需要等待后才能查询。它可以做免费可选实验，但不能参与刚写即读的 assignment、权限、CAS 或唯一约束。

来源：

- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)
- [Vectorize changelog — Free plan availability](https://developers.cloudflare.com/vectorize/platform/changelog/#2024-09-16)

## Workers AI

Workers Free 与 Paid 当前每天都有 10,000 Neurons 免费额度；Free 超限后请求失败，Paid 超过免费额度后按量计费。部分高资源模型要求 Paid 或预付 AI Gateway credits。

Embedding 模型也按 Neurons 计量，适合配合 Vectorize 做可选语义检索。

来源：[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## Rate Limiting API

Workers Rate Limiting binding 可以按 Credential、资源或路径做保护，但计数按 Cloudflare location 本地维护，更新是宽松且最终一致的。它适合抗滥用，不适合精确配额或账本。

来源：[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## Turnstile 与 Cloudflare Access

Turnstile Free 当前允许最多 20 个 widget，每个 widget 10 个 hostname，并提供不限量 challenge。它面向人类浏览器挑战，适合保护维护入口，不适合替代 Coding Agent 的长期 API Credential。

Cloudflare Access 官方已有 Coding Agent 认证指引：交互式场景可以通过 `cloudflared`/OAuth，headless Agent 可以使用独立 service token。Access 可以作为私有组织部署的外层防护，但它会增加 Zero Trust 配置，也不自动替代应用内 Project role 与业务授权。

来源：

- [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)
- [Authenticate coding agents with Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## Worker/D1 更新与恢复事实

截至 2026-08-28，Cloudflare Workers 的 version/deployment 记录 Worker code、configuration、assets、bindings 和 compatibility settings，但不会给 D1/KV/R2 等存储状态做同版本快照。Worker rollback 会让选定旧版本重新成为 active deployment；如果关联资源或 bindings 已变化，rollback 可能不可用，旧代码也可能因 D1 schema 已变化而失败。因此产品不能把 Worker rollback 描述为整个实例的数据库回滚。

D1 production backend 的 Time Travel 自动启用，可按 bookmark/timestamp 原地恢复。当前 Free profile 的 point-in-time retention 为 7 天，Paid 为 30 天；具体数字属于易漂移平台事实，upgrade plan 必须实时读回而不能依赖稳定 SPEC。D1 restore 会覆盖当前数据库并取消进行中的查询/事务，返回可用于撤销 restore 的 previous bookmark；它仍是破坏性动作，不能由普通健康检查失败自动触发。

D1 migrations 按顺序记录在 migration table 中。`wrangler d1 migrations apply` 执行某条 migration 出错时会回滚该条，但此前已经成功的 migration 保持已应用；因此多条 migration 加 Worker 部署不构成一个整体事务。官方建议迁移时使用稳定 database name 而不是可能变化的 binding name，以降低对错误数据库执行的风险。cfKanban 仍需额外提供 release 级 schema 兼容分类，因为 Cloudflare migration 工具本身不会证明旧 Worker 与新 schema 是否兼容。

来源：

- [Workers Versions & Deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Workers Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler D1 migration commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)

## 结论

| 层级 | 推荐服务 |
| --- | --- |
| 严格零账单核心 | Workers + D1 |
| 免费可选实验 | Vectorize、Workers AI、Queues、Turnstile |
| 非核心、启用前复核计费 | R2、Workers Paid、更高 AI/Vectorize 用量 |
| 有真实协调需求再评估 | Durable Objects |

最重要的成本控制不是多用 KV，而是避免全表扫描、限制 Agent 轮询、使用 cursor 增量读取、控制正文/评论大小，并让客户端在 quota error 后正确退避。
