# 部署与更新工作流

语言：[English](deployment-workflows.md) | [简体中文](deployment-workflows.zh-CN.md)

制定计划前，先在 Skill 目录运行 `node scripts/cfkanban-tool.mjs help`。catalog 会列出当前 release 的全部 deploy commands、effect 与输入字段。

## 存储归属

cfKanban 自己拥有的持久数据统一放在当前执行环境用户的一个根目录：

```text
~/.cfkanban/
  instances/<instance_id>/
    credentials/
    journals/
    receipts/
  skill-releases/
  tool-runtime/
```

- `instances/` 保存 trusted-origin metadata、私有 Credentials、operation journals 与脱敏 receipts。
- `skill-releases/` 保存已验证的 immutable Skill bundle versions、atomic active pointer 与上一 known-good version。
- `tool-runtime/` 在没有兼容的用户自有 Wrangler 时保存准确的 cfKanban-managed Wrangler npm package 及其依赖；它使用当前环境中用户已有的兼容 Node.js，绝不包含或安装 Node.js，也不会加入 PATH。

Windows 原生把 `.cfkanban` 放在当前 Windows profile home 下；WSL2 使用当前 Linux home。两者是独立执行环境，不自动发现、调用、复制或共享这些目录。

统一根目录只是维护边界，不表示权限摊平：secret 文件继续做更严格检查，禁止对根目录做宽泛递归清理，各子目录仍保持独立 receipt/version 生命周期。

## 为什么宿主目录里仍会出现文件

Agent 宿主只会从自己规定的位置发现 Skills/plugins。例如 Codex 在自己的目录管理 marketplace 配置和 plugin/cache 投影；其他宿主可能要求 personal 或 project Skill 目录。

这些宿主文件是 canonical Skill release 的已验证发现投影，不是 cfKanban 的持久真相源，也不包含 cfKanban Credential。安装流程只有在明确 source/version/digest plan 后才可创建或更新投影。删除宿主投影会让该宿主无法发现 Skill，但不会删除 `~/.cfkanban/` 状态或已验证 release copy。

marketplace/plugin 是受支持的便利安装入口，但不能覆盖 canonical HTTPS publisher、immutable manifest、artifact origin allowlist、SHA-256 digest 或已安装 receipt。marketplace 更新不自动授权安装、更新 Skill、部署或升级 Instance。

## 首个 canonical release 发布前

项目发布首个 canonical release 前，repository marketplace 可以让宿主发现本 Skill；这**不代表**已经存在 stable deployment target。

只读检查时，应明确报告缺少 canonical bootstrap/manifest 并停止。不得编造 release URL、向 `release verify` 提供伪造的 HTTPS manifest、把 plugin cache 当作 Service bundle，也不能静默退回当前 working tree。

明确的源码评估属于另一种工程模式。生成任何计划前，记录 repository URL、准确 commit、仅作人类辅助说明的 branch/tag、dirty/untracked 状态、lockfile 状态、验证命令/结果，以及不具备 publisher continuity 和 canonical release 保证这一事实。只有可变 branch name 不构成可复现来源。如果当前 Skill release 没有能够冻结这些事实的源码专用计划，必须在本地安装、Credential 生成或 Cloudflare 写入前停止。不得把源码试验作为无标记的既有 Instance upgrade。

## 与 Cloudflare 上游对齐

Cloudflare 在自己的仓库维护了两个有用的可选协作 Skill：

- [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) 用于广泛的平台问题路由，并要求从最新 Cloudflare 文档检索事实。
- [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) 覆盖当前 CLI 语法、配置、D1 migration、dry run 与 secret handling。

已经安装时可以使用；只有用户要求这项独立的宿主变更后，才按照[上游安装说明](https://github.com/cloudflare/skills#installing)引导安装，并记录选定的仓库 revision/version、安装 scope、宿主发现目标和回滚方式。不能自动安装，不能在 cfKanban 操作里隐式调用 Wrangler 的 `--install-skills`，也不能把这些宿主投影放入 `~/.cfkanban/`。

这些协作 Skill 是当前平台参考，不是 cfKanban 编排依赖。诸如在当前项目安装 `wrangler@latest`、使用裸 `npx wrangler`、改选 Pages/自动资源供应或直接部署等通用建议，在这里由 verified release 的兼容 Wrangler range、已解析的绝对 executable、一个 Worker + 一个 D1 + Static Assets 拓扑、Frozen plan、journal 与 readback 规则覆盖。若当前 Cloudflare 文档或固定的 config schema 表明 Service bundle 已失效，必须停止并发布修正后的 immutable release，不能现场修改已验证 bundle。

## Cloudflare 认证

认证是 Tool Runtime 准备与 strict-zero 部署计划之间的一道独立计划边界。用户只需提出简单的部署请求，下面这些细节由 Agent 负责：

1. 本地交互环境选择一个无冲突 profile 名称；device flow 环境使用 `default`。用已解析的 Wrangler 绝对路径和该名称运行 `runtime inspect-cloudflare-auth`。它会检查准确版本、命令支持、keyring 偏好、profile 是否存在、所需 scope catalog 与环境变量遮蔽，但不返回 token、Credential 路径、完整 profile 清单或 Wrangler 原始输出。
2. 如果 `safe_to_plan` 为 false，报告 blocker codes 并停止。不能改用裸 `npx`、其他 profile、明文存储或更宽 scope 集合绕过问题。
3. 用当前 Agent task ID、选定 mode 和未经修改的 preflight 结果运行 `runtime plan-cloudflare-auth`。默认遇到既有 profile 就停止；只有明确说明会替换原登录并设置 `allowExistingProfile: true`，才能计划重新认证。
4. 展示 plan digest 与每个 action。只有用户授权这份准确计划后，才按顺序调用 `runtime cloudflare-auth-action`。每个 action 都会重新校验 digest，并通过非 shell 进程参数执行。wrapper 会关闭这些认证动作的 Wrangler 磁盘日志，且不返回原始认证输出或 OAuth token。
5. 再次运行认证检查，然后对一个准确 account ID 和选定 named profile 运行 `runtime wrangler-account-readback`；default 登录则不传 profile。只有读回成功后才能进入部署计划。

支持的 mode 如下：

| 环境 | `mode` | 准确 Wrangler 行为 | 重要边界 |
| --- | --- | --- | --- |
| 本地交互电脑 | `named_profile_browser` | 使用 localhost 浏览器 callback 执行 `auth create <name>` | Wrangler 4.127.1 的 named profile 仍是 experimental；`login --profile` 无效，也不会创建目录绑定。 |
| 本地交互 default profile | `default_profile_browser` | 使用 localhost 浏览器 callback 执行 `login` | profile 已存在时会替换/重新认证 default profile。 |
| 远程 SSH 或容器 | `default_profile_device` | 执行 `login --device --browser=false` | Wrangler 4.127.1 的 `auth create` 没有 device flow，因此只能使用 default profile，也不能带 callback host/port。 |
| 非交互/headless | 已有环境 API token | 不计划 OAuth action | token 由用户或宿主在 Skill 输入之外提供；不能请求、回显、持久化或复制。它会遮蔽 profile。 |

OAuth 计划只请求下面四个 scope，并在单个 `--scopes` 后把每个 scope 作为独立进程参数传递：

| Scope | cfKanban 使用原因 |
| --- | --- |
| `account:read` | 解析并验证选定 account membership。 |
| `user:read` | 完成 Wrangler 身份/account discovery。 |
| `workers_scripts:write` | 上传 verified Service bundle 的 Worker、内置 Static Assets、bindings、subdomain 与 triggers。 |
| `d1:write` | 创建、迁移、查询并绑定唯一 D1 数据库。 |

Cloudflare 会自动增加 `offline_access`，供 Wrangler 刷新 OAuth 登录。计划明确不申请宽泛的 `workers:write`，也不申请 KV、routes、Pages、zone、AI、Queue、R2、DNS 或其他产品 scope。如果 Wrangler 不再提供上述四项中的任意一项，或者 Cloudflare consent 页面要求未预期的 scope，必须停止并等待修正后的发行版，不能现场扩大权限。

Wrangler keyring 设置作用于当前 OS 用户拥有的所有 Wrangler profiles。持久偏好关闭时，计划会把启用动作单独列出；既有明文 profile 在后继访问时可能迁移为加密文件。macOS 使用 Keychain，Linux 需要可用的 secret-service backend，Windows 可能会一次性下载 Wrangler 固定版本的 keyring binding。这些变化都发生在 `~/.cfkanban/` 之外。不能把关闭 keyring 当作自动回滚，因为 Wrangler 可能删除其他 profile 的加密 Credential；删除 profile/logout 与任何 keyring 修改都必须作为新的独立清理动作授权。

不要使用 `wrangler auth activate`。它会写入目录绑定，使行为依赖当前 Repo。cfKanban 的后继命令总是显式携带选定 `--profile`，并在生成的私有 Wrangler config 中固定 `account_id`。Cloudflare 登录本身不会创建 Worker、D1、deployment、cfKanban Credential 或 Repo 文件。

## 命令对照

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| 宿主 preflight | `capabilities` | 只读环境与 PATH 报告；其中的 Wrangler 观察不是最终 resolver 结果。 |
| Release trust | `release verify`、`release continuity` | 已验证 immutable manifest/artifacts 与 publisher continuity 决策。 |
| Canonical Skill 安装 | `plan skill-update`、`release install-skill-bundle` | 准确的首次安装/更新计划、immutable version 目录、atomic active pointer 与 `.cfkanban/skill-releases` 读回。 |
| Wrangler 选择 | `runtime resolve-wrangler` | 在显式、PATH 与 active Tool Runtime candidates 中作出必须执行的兼容性判断。 |
| Cloudflare auth 检查 | `runtime inspect-cloudflare-auth` | 脱敏的命令/profile/keyring/scope 事实与 blockers；不返回 token 或原始输出。 |
| Cloudflare auth 计划/动作 | `runtime plan-cloudflare-auth`、`runtime cloudflare-auth-action` | 绑定 task 的 digest、非 shell 参数数组、明确的全局 keyring 影响、OAuth consent 与必需读回。 |
| Cloudflare 账户 | `runtime wrangler-account-readback` | 对准确 account/profile 验证只读 D1 访问；丢弃数据库清单。 |
| Tool Runtime 计划/安装 | `runtime plan-install`、`runtime install` | 准确 local-only plan 与 `.cfkanban/tool-runtime` 下的授权安装。 |
| 首次部署计划 | `plan strict-zero` | Frozen plan 与 normalized digest。 |
| Plan 漂移 | `plan compare` | 准确 delta 与是否需要新授权。 |
| Journal | `journal create`、`journal authorize` | 绑定 task、operation ID、digest 的可恢复操作。 |
| Portable config | `deployment write-wrangler-config` | 绑定 verified bundle、Frozen account/Worker 与已创建 D1 的私有配置。 |
| Cloudflare 步骤 | `deploy wrangler-action` | 一个 allowlisted Wrangler action 与脱敏结果摘要。 |
| Worker 验证 | `deploy wrangler-action`，且 `action=validate_worker_bundle` | 使用正式部署同一 config/executable 执行 `wrangler deploy --dry-run`。 |
| Owner bootstrap | `credential prepare`、`bootstrap write-owner-sql`、`credential verify-and-promote` | pending secret、hash-only SQL 与内部 `/me` 验证；都不暴露 token。 |
| Migration 证明 | `migrations reconcile`、`migrations write-ledger-record-sql` | ledger/schema 一致性与 insert-only checksum record。 |
| Skill update | `plan skill-update`、`release install-skill-bundle` | 新的已验证本地版本与 atomic active pointer。 |
| Instance upgrade | `plan instance-upgrade` 加 journal/deploy/migration commands | 独立的 pinned Cloudflare upgrade。 |
| 本地读回 | `state inspect`、`origin rebind-check`、`api request` | 脱敏状态、trusted origin 连续性、认证后的 health/identity 检查。 |

命令通过 stdin 接收结构化 JSON；Credential 生成与读取留在内部。`.mjs` 是采用显式 ES module 格式的普通 Node JavaScript，可直接由 `node` 运行，无需编译，并且安装到缺少 `package.json` 的 portable Skill 目录时仍不会产生模块语义歧义。

## 首次部署

1. 把 canonical bootstrap 当作文档读取，将 stable pointer 解析为一个 immutable release manifest；只有用户明确选择测试版时才可改用 prerelease pointer。
2. 对 Skill 与 Service deployment bundles 运行 `release verify`，再与既有 receipt 比较 publisher/origin continuity。
3. 运行 `capabilities`。把已验证的 Skill artifact 与 `installed_skill_bundle` 比较；首次安装时，`plan skill-update` 必须使用 `current: null`，更新时只使用脱敏后的 current receipt。即使 plugin 或 marketplace cache 完全匹配，它也只是宿主投影，绝不能跳过本步骤。`capabilities.tools.wrangler` 只探测 PATH，`installed_tool_runtime` 也只是未经验证的提示。必须使用 manifest 的准确兼容范围调用 `runtime resolve-wrangler`；它会依次检查显式 candidate、PATH 与 active cfKanban Tool Runtime。任何兼容结果都应直接复用。只有 resolver 明确返回 unavailable/incompatible 时才能生成 `runtime plan-install`。
4. 展示 Skill 计划的 canonical source/version/digest、`.cfkanban/skill-releases` 目标、atomic switch 与 rollback。若两项本地前置条件都缺失，必须把 Skill 与 Tool Runtime 两份计划及其 digest 一起展示，再请求一次只覆盖这些准确写入的用户决定。授权后先安装 canonical Skill bundle，从返回的 installed path 运行 `help`，并核对 active receipt；只有此前 resolver 已证明确有必要时才安装 Wrangler。安装完成后必须再次 resolve，并要求兼容读回。
5. Cloudflare auth 尚不可用时，先检查并生成绑定 task 的 OAuth 计划。展示 profile operation、四个请求 scopes、全局 keyring 影响、browser/device 交互、本地存储归属和准确 digest。只执行已授权的 `runtime cloudflare-auth-action`，完成后再次检查。禁止使用 `login --profile`、把全部 scopes 引用成一个参数、把 profile 绑定到 Repo 或增加宽泛产品 scopes。
6. 使用准确 account ID 与可选 named profile 运行 `runtime wrangler-account-readback`；禁止使用裸 `npx`，因为它可能下载未固定的最新 Wrangler。Wrangler 的 `whoami` 不支持 `--profile`，因此该命令改用只读 `d1 list --json`，通过 `CLOUDFLARE_ACCOUNT_ID` 固定账户、丢弃数据库清单，并在环境 Credential 会遮蔽所选 profile 时停止。
7. 运行 `plan strict-zero`。默认候选包含一个 Worker、一个 D1、bundled Static Assets、`workers.dev`、不包含可选 Cloudflare 产品，并使用每 60 秒 120/300/30 request gates。冻结所选 Cloudflare profile/account，并在冻结 digest 前解决缺少的 Owner display name。
8. 创建 journal 并展示完整 plan。`journal authorize` 只记录 current Agent task、operation ID 与 digest 的授权。
9. 只执行 allowlisted `deploy wrangler-action`。显式创建 D1，不使用自动资源供应。未知同名资源绝不接管；冲突时另提名称。
10. 使用已创建 D1 的 ID 运行 `deployment write-wrangler-config`。bundle 内的 `wrangler.template.json` 只是带占位资源身份、经过 schema 校验的配置骨架，绝不能原样部署。该命令会在 immutable bundle 外写入私有的实际 config，指向 bundle 内已构建 Worker/Static Assets/migrations，并固定 account、名称、bindings、compatibility date 与 rate gates。
11. 数据 bootstrap 前创建 pending Owner Credential 与 hash-only bootstrap SQL。明文 token 不进入 plan、SQL、stdout、命令参数、环境、日志或 receipt。
12. 初始化 checksum ledger，并使用 Cloudflare 标准的 `wrangler d1 migrations apply --remote` 行为。该命令按序应用 pending files；命令结束或响应不确定后，都要核对 cfKanban checksum ledger 与实际 schema。
13. 用准确生成的 config 与已解析 Wrangler 运行 `validate_worker_bundle`。dry run 成功是必要验证，但不等于部署授权或远端写入证明。
14. 部署后验证 Worker health、public instance discovery、bindings、migration/schema state 与 `/api/v1/me`；之后才提升 pending Owner Credential 并写入脱敏 receipt。

### 交接到真正可用的看板

首次部署只创建基础设施和 Deployment Owner，按设计不会创建 Workspace、Project、Label、Grant 或 Issue。最终报告必须提供一条简单的下一步提示词：“请使用 `$cfkanban-admin` 创建我的第一个 cfKanban 看板。”Owner 验证、缺失名称询问、两个独立创建与读回以及 Browser Launch 流程都由 Admin Skill 负责；不能要求用户把这些步骤写进提示词，也不能把这些应用写入隐藏在 Cloudflare deployment authorization 里面。

## 中断与续做

一个 Agent task、normalized plan digest 与 operation ID 共同定义一次授权。同一任务可以续做无漂移的计划内步骤；新任务或任何 plan delta 都需要新授权。

遇到 timeout、response loss、Agent restart 或部分执行后：

1. 加载 journal，不能只从上一条命令 exit code 推断进度。
2. 读回 Cloudflare resource markers，验证 account/type/`instance_id` 所有权。
3. 使用 Service bundle 固定只读 SQL 读取 migration checksum ledger 与有界 `sqlite_master` artifacts。
4. 比较 Frozen plan 与 current state；只有无漂移时才继续一个 allowlisted 未完成步骤。

Wrangler 原始输出必须先脱敏，不能直接记日志。前一次 create 是否提交不确定时，不能用新 identifiers 重试。

## Skill update

Skill update 只修改本地：

1. 验证 target manifest、bundle digest、compatibility 与 publisher continuity。
2. 创建 `plan skill-update`，结果必须明确没有 Cloudflare writes。
3. 安装到 `.cfkanban/skill-releases` 下新的 immutable version 目录。
4. 运行无副作用 discovery/help smoke。
5. 原子切换 active pointer，并保留上一 known-good version。
6. 只有作为明确安装步骤时才更新宿主管理的 marketplace/plugin/Skill 投影。

pointer 切换前失败时 active version 不变。该操作绝不升级已部署 Instance。

## Instance upgrade

Instance upgrade 是独立 Cloudflare plan：

1. 固定 Service deployment bundle 与 compatibility matrix；检查当前 Worker/D1 markers 和 bindings。
2. 需要时取得 Cloudflare restore point/bookmark 作为证据；Skill 不执行 Time Travel restore。
3. 创建 `plan instance-upgrade`，列出准确 Worker、binding、ordered migration deltas。
4. 授权并 journal 准确 digest；每次只 apply 一个 migration，并在前后读回 ledger 与 schema。
5. 最后验证已部署 Service；不隐式更新本地 Skills。

destructive migration、缺少 restore evidence、unknown baseline、partial schema artifacts、checksum drift、资源删除/替换、DNS/domain 变化或费用/权限变化都会退出常规 upgrade 路径，并要求新的明确 plan。

Worker rollback 不会回滚 D1。D1 restore 是破坏性操作，绝不自动执行，并且总是需要新授权。deploy Skill 不提供完整 D1 export/import、one-click restore、本地灾难恢复演练或自动 Time Travel restore。

## 停止条件

canonical origin/digest mismatch、publisher discontinuity、存储不可验证、未授权的 Node/Wrangler 不兼容、Windows/WSL 混用、auth preflight blockers、未明确批准重新认证的既有 profile 冲突、未预期 OAuth scope、account 歧义、Owner display name 缺失、未知资源所有权、plan drift、migration checksum/schema drift、部分应用或 restore evidence 不可用时必须停止。加载 Skill 或安装 marketplace/plugin 入口从来不等于获得部署授权。
