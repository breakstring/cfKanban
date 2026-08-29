# Edgechat 架构与部署工程快照

- 快照日期：2026-08-29
- 参考项目：[aozorae/Edgechat](https://github.com/aozorae/Edgechat)
- 用途：为 cfKanban 的源码组织、Workers Static Assets、D1 migration 与可选 GitHub Actions 设计提供外部工程参考
- 边界：本文记录对外部项目的只读观察与可借鉴建议，不把 Edgechat 的实现自动升级为 cfKanban 产品合同，也不授权实现

## 1. 结论摘要

Edgechat 最值得 cfKanban 学习的不是“尽可能多用 Cloudflare 产品”，而是以下工程边界：

1. Vue/Vite 前端构建产物与 Worker API 由同一个 Worker deployment 发布，动态 API 路径先进入 Worker，其余路径由 Static Assets 与 SPA fallback 处理。
2. GitHub Actions 把依赖安装、测试、前端构建、Cloudflare 资源准备、配置生成、D1 schema/migration、secret 准备、部署拆成可审计步骤。
3. D1 migration 不只是一组 SQL：项目维护有序 manifest、migration ledger、SQL checksum、目标 schema artifact 检查与临时执行计划。
4. Cloudflare 产品按业务需要选用：D1 保存持久数据，KV 保存会话，R2 保存附件，Durable Objects 承担实时连接/协调，Cron 执行清理。它们服务的是聊天系统需求，不能反推 cfKanban v0 也需要这些组件。

这份观察支持 cfKanban 已确认的 D-245：源码采用 monorepo 组织；v0 云端仍只有一个 Worker 与一个 D1；Web 预构建资产随 Service deployment bundle 通过同一 Worker 的 Workers Static Assets 发布，不创建 Pages 项目或 KV namespace。

## 2. Edgechat 的源码与运行时结构

仓库根目录统一管理 `frontend/`、`worker/`、`test/` 与 `.github/`，根 `package.json` 统一提供 Vite 构建、测试和 Wrangler 部署命令。它没有声明 npm workspaces，因此严格说更接近“单 package 的全栈仓库”，而不是多个可独立发布 package 组成的 workspace monorepo。

主要运行时职责如下：

| 层 | Edgechat 做法 | 业务原因 |
| --- | --- | --- |
| Web | Vue + Vite，构建到 `frontend/dist` | 聊天与管理页面 |
| API | Hono on Cloudflare Workers | HTTP API、鉴权与业务编排 |
| D1 | 核心持久业务数据 | 用户、频道、消息等关系数据 |
| KV | Session binding | 会话 token 查询 |
| R2 | 文件 binding | 上传文件与头像 |
| Durable Objects | ChannelRoom、Scheduler、UserInbox | WebSocket 广播、定时协调与用户收件箱 |
| Cron | 定时触发 Worker | 过期消息/数据清理 |
| Static Assets | `frontend/dist` 与 Worker 一次部署 | 同 origin SPA 与 API |

参考：

- [仓库结构与项目说明](https://github.com/aozorae/Edgechat)
- [根 package.json](https://github.com/aozorae/Edgechat/blob/master/package.json)
- [Wrangler 配置示例](https://github.com/aozorae/Edgechat/blob/master/wrangler.example.toml)
- [Worker 入口](https://github.com/aozorae/Edgechat/blob/master/worker/src/index.js)

## 3. 对 cfKanban 可直接吸收的做法

### 3.1 同一 Worker 发布 API 与 Web 资产

Edgechat 的 Wrangler 配置把 `frontend/dist` 配置为 Worker assets，并让 `/api/*`、`/files/*` 优先进入 Worker；普通页面路由使用 SPA fallback。这个模式验证了 cfKanban 的极简部署方向：

- 浏览器、API、Invite/bootstrap 和 instance discovery 可以保持同 origin；
- 不需要为 v0 再创建 Pages 项目、跨 origin CORS 或第二套发布版本；
- 静态文件仍由 Static Assets 服务，不需要每次请求都执行 Worker JavaScript；
- Web 构建版本和 API 版本可以由同一个 Service deployment bundle 固定并一次读回验证。

cfKanban 的具体静态路由、缓存 header 与 SPA fallback 仍应在 Web/API 实现合同中确定，不能照抄 Edgechat 路径。

### 3.2 一个确定性的根级工程入口

Edgechat 在根 package 中统一构建前端、运行测试和调用本地 Wrangler。cfKanban 可以吸收“一个锁文件、确定性脚本、锁定工具版本”的原则，但源码结构应比 Edgechat 更明确，因为 cfKanban 至少有 Web、Worker/API、公共 contracts、D1 migrations 和三个独立 Skill release surfaces。

源码仓库中的本地 Wrangler devDependency 适用于开发与 CI；它不改变普通部署者由 `cfkanban-deploy` 管理用户级 Tool Runtime 的合同，也不要求在用户任意业务 Repo 中安装 Wrangler。

### 3.3 Migration manifest、ledger 与 checksum

Edgechat 的 D1 migration 脚本维护：

- 明确的 migration 顺序；
- 已应用 ledger；
- SQL 的 SHA-256 checksum；
- 目标 table/index/column 等 schema artifact；
- 换行差异兼容；
- `apply / skip / baseline / normalize` 等计划结果；
- 对部分应用、不可安全重入等状态的停止条件。

这对 cfKanban 很有参考价值。我们仍需要遵守自己的固定目标版本、兼容矩阵、逐条 migration journal、restore point 证据和失败恢复合同，但实现时可以采用同类 manifest/checksum/schema-readback 机制，避免只凭文件名或“命令退出 0”判断 migration 已正确应用。

参考：[migration manifest](https://github.com/aozorae/Edgechat/blob/master/.github/scripts/d1-migration-manifest.mjs)、[migration plan](https://github.com/aozorae/Edgechat/blob/master/.github/scripts/d1-migration-plan.mjs)、[migration preparation](https://github.com/aozorae/Edgechat/blob/master/.github/scripts/prepare-d1-migrations.mjs)。

### 3.4 可选能力缺失时显式降级

Edgechat 的部署脚本会探测并准备 D1、KV、R2 等资源，部分可选资源不可用时调整部署配置。cfKanban 后续引入 Vectorize、Workers AI、R2 或 Queue 时，可以采用“核心 profile 不依赖、可选 binding 有显式 capability/readback、缺失时核心 Kanban 仍完整”的相同方向。

## 4. GitHub Actions 的观察

Edgechat 的生产 workflow 可由 `main/master` push 或 `workflow_dispatch` 触发，并执行：

1. checkout、Node 20、`npm ci`；
2. 测试与前端构建；
3. Cloudflare 资源探测/创建；
4. 生成 CI 专用 Wrangler 配置；
5. 初始化 schema 或准备并应用 D1 migrations；
6. 准备服务端 secret；
7. 部署 Worker；
8. 清理临时 secret 文件。

它还提供一个只允许手动触发、使用独立 Cloudflare 凭据的 demo workflow。这说明 GitHub Actions 很适合做可重复验证和可选远程发布入口。

参考：[生产部署 workflow](https://github.com/aozorae/Edgechat/blob/master/.github/workflows/deploy-worker.yml)、[Demo workflow](https://github.com/aozorae/Edgechat/blob/master/.github/workflows/deploy-demo.yml)、[资源准备脚本](https://github.com/aozorae/Edgechat/blob/master/.github/scripts/ensure-cloudflare-resources.mjs)。

## 5. 不应直接照搬的部分

### 5.1 Cloudflare 组件不能按项目清单复制

- cfKanban v0 没有附件，所以不需要 R2。
- cfKanban v0 没有实时消息/WebSocket，所以不需要 Durable Objects。
- cfKanban Web Session、Credential revoke 与 Grant revoke 要立即依据 D1 生效，所以不能因为 Edgechat 用 KV 存 Session 就改用 KV。
- cfKanban v0 没有定时物理清理合同，所以不需要 Cron。

### 5.2 Web 安全合同不同

Edgechat 的浏览器 API 使用 Bearer session，并在 Worker 入口开放 `Access-Control-Allow-Origin: *`。cfKanban 已选择同 origin、HttpOnly Cookie、CSRF 校验和长期 Credential 不进入浏览器脚本的边界，因此不能复制这部分鉴权/CORS 设计。

### 5.3 自动部署不能绕过 cfKanban 的部署合同

Edgechat 的 workflow 默认可随主分支 push 自动发布，并启用 `cancel-in-progress`。cfKanban 的部署还包含 plan digest、operation ID/journal、资源 marker、逐 migration readback 和 Owner 授权：

- v0 不应默认把“push 代码”解释为已授权生产部署；
- 涉及 migration 的部署应串行，不应取消已经开始的运行；
- 资源不能只按名称自动接管，必须匹配本地 receipt、Cloudflare account、资源类型与远端 `instance_id` marker；
- Wrangler 配置应由结构化输入确定性生成并纳入 digest，避免以多次文本替换作为长期公共合同；
- migration 与 Worker 发布不是天然原子操作，必须按兼容矩阵和 journal 处理失败，而不是只依赖 workflow 步骤顺序。

Edgechat 使用 GPL-3.0-or-later。cfKanban 可以学习公开的架构思想与工程模式，但若未来复制或改编其具体代码，必须单独评估许可证义务。

## 6. 对 cfKanban GitHub Actions 的已确认分层

GitHub Actions 被拆成验证与部署两个不同能力，不能因共用一个平台而混成同一授权边界：

### 无云端凭据的默认验证 workflow

- PR/push 运行依赖锁定安装、lint、typecheck、test、Web build、OpenAPI/DDL/migration manifest 静态校验；
- 不持有 Cloudflare token，不写远端资源；
- 可以作为正常源码工程设施进入实现阶段，因为它不改变部署授权体验。

### 下一阶段才评估的部署 workflow

- v0 不提供该 workflow；当前唯一主部署路径是用户的 Agent 调用 `cfkanban-deploy`；
- 下一阶段若引入，初始候选应仅 `workflow_dispatch`，不默认随 push 发布；
- 使用受保护 environment、最小权限 Cloudflare token 和固定 release/version/digest；
- concurrency 串行且 `cancel-in-progress: false`；
- 复用与 `cfkanban-deploy` 相同的确定性 plan、migration journal、marker 和 readback 逻辑，不形成第二套部署语义；
- GitHub Secrets 是 Owner 明确选择的另一种 Credential/Cloudflare auth 保管位置，其安全与恢复体验需要另行确认。

第二类 workflow 会改变凭据保管和部署 UX，已按 D-247 明确后置。未来实施前仍需单独冻结 Token/GitHub Secrets、人工审批、并发取消、migration 中断与恢复合同；本快照不授权实现。
