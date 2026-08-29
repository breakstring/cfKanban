# Cloudflare 缓存、协调与限流能力快照

- 文档状态：Research Snapshot
- 核对日期：2026-08-29
- 用途：为 cfKanban 的 Public Join 成本控制、请求门控和“是否需要 Redis 类组件”提供易漂移的平台事实

## 1. 结论

Cloudflare 核心产品中没有必要为 cfKanban v0 引入一个 Redis 兼容服务：

- Workers KV 最接近全球分布式 key-value/cache，但它最终一致，且免费层写入额度很低，不适合权限撤销、精确 quota、CAS、幂等、锁或高频计数。
- Cache API 是 Worker 可控制的 HTTP response cache；内容按数据中心本地保存，不是持久共享 KV，更不是协调或计数服务。
- SQLite-backed Durable Objects 在 Free plan 可用，并能为单对象提供强一致协调与存储；它比 KV 更接近可靠 counter/coordination primitive，但不是 Redis 协议，并会给 strict-zero 架构增加一个运行组件。
- Workers Rate Limiting binding 适合以任意 key 做近似请求门控；它按 Cloudflare location 计数且最终一致，不适合精确配额或计费。

因此 v0 采用：D1 保存全部权威事实并原子强制 Project active quota；Workers Rate Limiting binding 抵御部分突发滥用；KV、Cache API 和 Durable Objects 不参与权限、quota 或核心并发判断。Owner Web 只读展示限流，修改通过部署配置完成。

## 2. Workers KV

官方免费层当前包含每天 100,000 次读取、1,000 次写入、1,000 次删除、1,000 次 list，以及 1 GB 存储。KV 读取面向全球低延迟，但写入传播是最终一致的，同一个 key 在其他位置看到变化可能需要 60 秒或更久；官方也明确建议需要原子操作时考虑 Durable Objects。

对 cfKanban 的含义：KV 可以以后缓存可重建、允许陈旧的公开说明或低风险读结果，但不能作为 Credential revoke、Project Grant、Public Join Principal 计数、Issue/Comment active usage、幂等结果或限流精确计数的唯一事实源。免费层每天 1,000 次写入也不适合作为 Agent 请求路径上的高频写缓存。

来源：

- [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## 3. Cache API

Cache API 允许 Worker 对 HTTP request/response 使用 `cache.match`、`cache.put` 和 `cache.delete`。缓存内容不会复制到创建它的数据中心之外，因此不同 Cloudflare location 可能有不同结果。它适合缓存公开网页或可重新计算的 HTTP 响应，不提供 Redis 风格的数据结构、原子 counter、锁或持久事实。

对 cfKanban 的含义：未来可以按测量结果缓存公开首页或稳定静态响应，但 v0 没有必要把它作为额外设计中心；认证后的权限结果、quota usage、Session 和写后立即读取路径不能依赖它。

来源：[Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)

## 4. Durable Objects

Durable Objects 当前可在 Workers Free plan 使用；Free plan 只支持 SQLite-backed Durable Objects，并提供独立的 request、duration、row read/write 与 storage 免费额度。每个对象的单线程执行模型与强一致存储适合协调、可靠 counter 或有序状态，但引入后必须明确 D1 与 Durable Object 的权威边界，避免双写同一业务事实。

对 cfKanban 的含义：它不是为了“有个 Redis”就应该加入。实例限流只需可见并可通过部署更新，因此 v0 采用原生 Rate Limiting binding，不为 Web 即时配置增加 Durable Object。

来源：[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## 5. Workers Rate Limiting binding

Rate Limiting binding 的阈值与 period 在 Worker/Wrangler 配置中声明；period 当前只支持 10 或 60 秒。运行时可以为 `limit()` 提供任意 key，因此可以分别表达 Principal、实例总请求或未认证/Public Join 路径。计数按 Cloudflare location 本地维护，更新宽松且最终一致；官方明确说明它不适合精确 accounting。

这意味着 Owner 可见性必须由 cfKanban 自己提供：管理面显示当前部署值、配置来源和安全的近期 429 摘要。修改阈值属于部署配置变化，由 `cfkanban-deploy` 生成明确 plan 并执行，而不是由 Web 假装即时保存。v0 首次部署档位为单 Principal 120/60 秒、实例动态 API 300/60 秒、未认证敏感操作 30/60 秒；这些是产品默认值，不是 Cloudflare 平台保证或严格全球总量。

来源：[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## 6. Cloudflare 配额与边缘错误

D1 日读/写额度或 storage limit 超出时，D1 binding 会向正在执行的 Worker 抛出可捕获错误。官方当前列出了日读、日写、account storage 和单库 storage 等不同错误，并说明免费日额度在午夜 UTC 重置。cfKanban 可以在 Worker 内把已识别类型安全映射为稳定的 `PLATFORM_QUOTA_EXCEEDED`，但不应把供应商完整错误文本下发给客户端，也不能把所有 D1 5xx/overload 都误判为 quota。

Workers Free 每日请求额度超出则不同：Cloudflare 可能在 Worker 执行前直接返回 Error 1027 页面，cfKanban 代码没有机会生成自己的 JSON envelope。类似的边缘 429 或平台 HTML 也不能由服务端统一。产品只能要求 Web/Skill 客户端按 HTTP、标准 header 和已知数字错误码生成明确标记为 client-normalized 的本地错误结果；如果首页本身也没有成功加载，则只能显示 Cloudflare 平台页面，不能承诺 cfKanban 自定义体验。

来源：

- [D1 errors](https://developers.cloudflare.com/d1/observability/debug-d1/)
- [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/)
- [Workers errors and Error 1027](https://developers.cloudflare.com/workers/observability/errors/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)

## 7. 易漂移提醒

免费额度、产品可用性、配置字段和 period 支持范围会变化。实现和发布前必须重新核对官方文档；稳定 SPEC 只固化产品语义，不把这里的具体免费额度写成永久合同。
