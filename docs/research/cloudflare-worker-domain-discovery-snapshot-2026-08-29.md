# Cloudflare Worker 域名与实例发现能力快照

- 文档状态：Research Snapshot
- 核对日期：2026-08-29
- 用途：区分 Cloudflare 控制面域名事实、Worker 运行时可见事实，以及 cfKanban 向已有用户传播新地址所需的应用合同

## 1. 当前结论

Cloudflare 可以在 Worker 首次以 `workers.dev` 部署后，再通过 Dashboard、Wrangler 或 API 添加一个或多个 Custom Domains。Cloudflare 为 Custom Domain 创建 DNS 记录并签发证书；`workers.dev` 是否继续启用是另一个独立设置。

但是“Cloudflare 已经把哪些域名绑定到这个 Worker”是控制面事实。官方提供需要 Cloudflare API Token 的账户级 `GET /accounts/{account_id}/workers/domains`，并可按 Worker service 过滤；当前没有文档化的 Worker runtime binding 能让业务请求直接枚举这份清单。Worker 在一次请求中可以解析当前 `request.url`，因此知道本次请求使用的 origin，但这不等于知道全部域名。

第三方反向代理、CDN 或其他系统创建的别名不会进入 Cloudflare Workers Domains 清单。源 Worker 只有在请求真正到达且代理保留了相应 Host/URL 信息时，才可能观察到这一次入口；它不能据此证明域名所有权、枚举其他别名或自动把别名提升为可信 API origin。

因此 cfKanban 需要把“域名可达”“实例身份”“Owner 推荐的新入口”和“本地 Credential 信任”分开处理。仅增加 Cloudflare Custom Domain 不会自动修改各用户 `.cfkanban/` 中的 `trusted_api_origin`。

## 2. Cloudflare 官方事实

### 2.1 Custom Domains

- Custom Domain 适用于 Worker 本身作为 origin 的场景。
- 可以从 Dashboard 的 Worker `Settings > Domains & Routes` 添加，也可以通过 Wrangler 或 API 添加。
- Cloudflare 自动创建 DNS 记录并签发证书。
- 同一个 Worker 可以添加多个 Custom Domains。
- 目标 hostname 必须位于使用者拥有的 active Cloudflare zone；已有冲突 CNAME 时不能直接创建 Custom Domain。

来源：[Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

### 2.2 `workers.dev` 生命周期

`workers.dev` 是独立的 Worker 路由，默认用于快速启动，可以单独禁用。添加 Custom Domain 本身不等于向旧客户端发布迁移通知，也不能假定旧地址已经关闭。

来源：[Cloudflare Workers `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

### 2.3 控制面域名清单

Cloudflare API 的 `GET /accounts/{account_id}/workers/domains` 返回账户下 Worker Domains，支持 `service`、`hostname`、`zone_id` 等过滤，并要求 `Workers Scripts Read` 或 `Workers Scripts Write` 权限。它适合由已经持有 Cloudflare 控制面身份的 `cfkanban-deploy` 做显式只读 reconcile，不适合把管理 Token 保存进业务 Worker。

来源：[Cloudflare API — List Domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/)

### 2.4 Dashboard 与 Wrangler 配置漂移

Cloudflare 文档明确说明：如果 Wrangler 配置声明了 routes，后续部署可能以配置文件覆盖 Dashboard 中的路由修改；如果希望 routes 由 Dashboard 管理，应从 Wrangler 配置移除 `route/routes` 键。cfKanban deployment bundle 必须明确域名配置由哪一侧拥有，不能在升级时静默删除 Owner 手工添加的域名。

来源：[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## 3. 对 cfKanban 的产品含义

### 3.1 运行时发现文档不等于发行 manifest

现有 immutable release manifest 负责 Skill/Service 工件版本和来源信任，不能混入某个部署实例会变化的域名。运行时发现使用单独的公开非秘密文档 `/.well-known/cfkanban-instance.json`，字段为：

- `discovery_version`；
- immutable `instance_id`；
- service version；
- 本次请求观察到的 `observed_origin`；
- Owner 已发布的单一 `preferred_api_origin`；
- `origin_version` 与 `updated_at`。

它不返回 Credential、Principal、Workspace/Project、Cloudflare account/resource ID 或全部历史域名。`observed_origin` 只描述调用者实际使用的入口，不自动获得信任。

### 3.2 Cloudflare-native 域名

`cfkanban-deploy` 可以在用户明确发起“检查/同步实例域名”时，以现有 Cloudflare 控制面身份只读列出绑定到目标 Worker 的 Custom Domains，并与本地 deployment receipt 比较。它不能把新发现的域名自动写入每个参与者设备，也不应把 Cloudflare Token 交给线上 Worker。

Owner 选定一个 preferred origin 后，再通过 Owner-only cfKanban 原子能力发布它。旧 origin 的运行时发现文档随后可以告诉已有客户端“Owner 推荐的新入口”。

### 3.3 第三方代理域名

第三方域名无法由 Cloudflare Workers Domains API 自动发现。Owner 必须显式提供候选 HTTPS origin；Agent 先无 Credential、不跟随 redirect 地探测 discovery 文档和 `instance_id`，再由 Owner 使用 Bearer Credential 发布 preferred origin。新站点自报相同 `instance_id` 不能单独触发自动信任；只有本地当前 trusted origin 返回更高版本迁移指示，并且目标 discovery 的 observed/preferred origin 与 version 全部交叉一致时，Agent 才能自动 rebind。其他情况仍需展示旧/新 origin 与影响并取得显式授权。

### 3.4 参与者如何感知和迁移

一个可行的最小流程是：

1. Owner 通过 deploy Skill 检测 Cloudflare-native candidate，或显式提供第三方 candidate。
2. Agent 在不发送 Credential 的情况下探测 candidate；Owner 选择一个 preferred origin，并授权发布实例级提示。
3. 仍访问旧 trusted origin 的参与者 Agent 在低频 metadata/discovery 检查中发现 preferred origin 变化。
4. 若旧 trusted origin 发布了更高 `origin_version`，Agent 对 preferred origin 执行不携带 Credential、不跟随 redirect 的探测，并验证 instance ID、observed/preferred origin 与 version 全部一致；满足时按 D-243 原子更新本地 `trusted_api_origin`，无需逐环境再次询问。
5. 邀请话术、Browser Launch 和 Web 链接从发布后优先使用 preferred origin；已经生成的旧 URL 不被后台改写。

迁移期间应保留旧 origin 可用。若 Owner 在参与者感知前关闭旧地址，cfKanban 没有中心注册服务可以隔空通知这些本地 Credential；只能通过新的 Invite/说明或其他离线渠道告知。认证 API 不应依赖跨 origin 自动 redirect，因为客户端可能错误转发 `Authorization`。

### 3.5 Passkey 影响

WebAuthn 标准在满足 RP ID 后缀关系和 origin 验证等条件时允许相关子域共享 credential，不能笼统表述为“任何域名变化都由标准强制重新登记”。cfKanban v0 为降低 origin allowlist、域名接管与迁移状态的复杂度，主动选择精确 hostname 边界：RP ID 等于发起登记/认证的当前请求 hostname，expected origin 等于当次规范化完整 HTTPS origin，不启用跨 hostname 共享或 Related Origin Requests。

因此在 cfKanban v0 中，把 preferred origin 从 `workers.dev` 改到 Custom Domain，或改成任何其他 hostname，都不会迁移旧地址上的 Passkeys；用户需要通过 Agent Browser Launch 在新地址重新登记。旧地址仍可达时，旧 Passkey 继续只服务旧地址。Web Session cookie 同样保持 origin-specific，但本地 Agent Credential 的 trusted origin 可以按 D-243 的独立规则安全 rebind。

## 4. 已确认的产品选择

v0 每个实例只发布一个 `preferred_api_origin`，而不是让每个参与者在多个等价域名中自行选择。Cloudflare/第三方 aliases 可以作为候选和迁移入口，但本地每个实例仍只有一个 trusted origin，符合 D-188 的简化与安全合同。

用户已于 2026-08-29 确认 D-243：公开 discovery document 动态生成；Owner 通过 Bearer-only 应用能力发布 preferred origin；可信旧 origin 的更高版本指示与无 Credential 目标探测共同允许自动 rebind。陌生入口、旧 origin 已失联或证据不一致时仍需显式授权。Foundation 与 Agent Skills 已完成 Frozen 修订，API/Schema 继续在 Draft 中冻结精确 wire/DDL。
