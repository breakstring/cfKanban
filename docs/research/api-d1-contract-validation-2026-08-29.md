# API / D1 合同验证快照（2026-08-29）

- 文档状态：Validation snapshot
- 对应 SPEC：[cfKanban API & D1 Schema SPEC](../specs/2026-08-28-api-schema-spec.md)（Draft）
- 验证环境：Node.js 24.16.0、Wrangler 4.127.1、Redocly CLI 2.49.0、Wrangler local D1 / Miniflare
- 边界：这里只验证实现前合同假设，不是业务实现、生产 migration 或远端部署证据

## 1. 结论

当前 OpenAPI、初始 D1 schema、关键原子操作和 Web 安全骨架可以在“一个 Worker + 一个 D1”的 v0 拓扑内表达，没有发现必须引入 KV、Durable Objects、第二个数据库、公开批量 API 或新业务角色的理由。

原型发现并修复了一个真实的原子性风险：D1 `batch()` 中，末端 `INSERT ... SELECT ... WHERE` 返回零行本身不算 SQL 失败，因此不能作为回滚 guard。现在每个原子配方要求最终 primary subject 的预期 Event 全部存在，再把最后 Event sequence 写入 `operation_commits.last_event_sequence NOT NULL`；缺失时约束失败，整批回滚。这个行为已通过实际 Wrangler local D1 的 `env.DB.batch()` 验证。

D-252 已由用户确认：WebAuthn 非零 signature counter 未前进时拒绝本次登录、记录安全审计但不自动 revoke Passkey；用户可以通过 Agent Browser Launch 恢复访问。至此验证中发现的差异均已回写 Frozen 合同。

## 2. 已验证工件

| 工件 | 当前结果 |
| --- | --- |
| `contracts/openapi.json` | OpenAPI 3.1；91 operations / 91 unique operationIds；Redocly 无错误或警告 |
| operation 权限 | 每个 operation 有明确 `x-cfkanban-permission`；公开、当前身份、Project reader/writer、Owner 与短期 capability 分开 |
| 通用 HTTP | 所有声明响应含 `X-Request-ID`；JSON body 写入含 413；过期/撤销/已消费 Invite 与 Browser Launch capability 含 410；Cookie 写入显式 CSRF header |
| `migrations/0001_initial.sql` | 25 个应用表、28 个显式索引；manifest 固定 SHA-256、顺序、兼容范围、预期 artifacts |
| Schema 约束 | foreign key、CHECK、unique、soft-delete identity、completion/invitation 组合、Passkey algorithm/backup flags |
| 查询形状 | Credential、Issue list/candidate、Grant、Comment、Invitation、Event 共 7 类 `EXPLAIN QUERY PLAN` 命中预期索引 |
| 原子写入 | complete、并发 assign-to-me、跨 Project Relation、Invitation redeem、Project-local active quota、response-loss probe |
| Public Join quota | 降低 limit 到 usage 以下可保存；只阻止本 Project 增长；soft delete/revoke 释放；restore/regrant 重占；关闭后不约束且不影响其他 Project |
| Browser Launch / Session | GET 不消费、5 分钟一次性兑换、固定 8 小时 Session、源 Credential revoke 联动、同源 + double-submit CSRF |
| Passkey 基础 | 5 分钟单次 challenge；ES256/RS256 verify；无 attestation；D-252 已固定 counter 异常策略 |
| 错误归一化 | 5 类 Worker JSON 错误与 4 类 Worker 外/网络错误；客户端生成结果明确 `normalized_by=client` |

## 3. 运行过的验证

```text
npm run contracts:generate
npm run contracts:check
npm run migrations:generate
node scripts/validate-d1-schema.mjs
node scripts/validate-d1-operations.mjs
node scripts/validate-web-security.mjs
node scripts/validate-d1-wrangler.mjs
```

其中 Wrangler 验证把 `0001_initial` 应用到临时 local D1，并启动临时 Worker 调用真实 `env.DB.batch()`：一个 complete 成功提交；第二个 complete 因 Comment quota 失败后，Issue 状态、Comment、counter 与 commit sentinel 全部保持未写入。

Cloudflare 官方合同依据：D1 `batch()` 顺序执行并作为 transaction 回滚、Wrangler local 使用与生产 D1 相同版本、D1 migrations 按顺序应用；Workers Web Crypto 支持 ECDSA 与 RSA 签名验证。平台事实入口见 [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Local development](https://developers.cloudflare.com/d1/best-practices/local-development/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) 和 [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。

## 4. 尚未验证与边界

- 没有访问或修改任何远端 Cloudflare account/D1；远端隔离数据库验证仍需未来单独授权。
- 没有实现完整 WebAuthn CBOR/attestation/assertion parser；本快照只证明算法、持久化和状态机合同可行。完整 ceremony 的标准测试向量与浏览器端到端验证属于实现阶段验收。
- 没有在 Codex IAB 与普通浏览器运行成品页面，因为 Web 业务实现尚未开始。
- 没有把 prototype migration 当作已发布 migration；在首个 Service release 前仍可随 Frozen SPEC 一次性校准，发布后不得改写。
- 本快照只证明合同原型可行；真正完成状态以实施 PLAN、Linear Issues 和对应测试证据为准。
