# 用 Agent 部署 cfKanban

[English](./deploy-guide.md) | 简体中文

这是专用的逐步部署指南。请把它的 HTTPS 地址作为只读说明交给 Coding Agent；不要执行本文，也不要把它通过管道送进 shell。

## 你需要准备什么

- 一个能在你授权后安装本地 Skills、运行命令的 Coding Agent。
- Node.js `>=22.12.0 <27`。cfKanban 不会替你安装 Node.js，也不会改 shell、PATH 或版本管理器。
- 一个可创建 1 个 Worker 和 1 个 D1 数据库的 Cloudflare 账号。Wrangler 登录可能打开 Cloudflare 官方浏览器或设备流程。
- 你希望使用的唯一 Deployment Owner 显示名称。Agent 必须询问，不能从电脑账号或 Git identity 猜。

你不需要预先创建 Worker、D1、Workspace、Project 或 Credential。

## 第一步：安装 Skills

当前测试发行版是 `0.1.0-alpha.35`。它仍是预发行版，因此 Agent 必须明确告诉你这一点，并在选用前取得你对测试版本的明确选择。

在 Codex 中，先让 Agent 展示这项宿主级安装计划：来源 `https://github.com/breakstring/cfKanban.git`、不可变 ref `0.1.0-alpha.35`、用户级安装范围，以及卸载 plugin 的回退方式。全新安装时使用：

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.35
codex plugin add cfkanban-agent-skills@cfkanban
```

如果已经存在其他 ref 的 `cfkanban` marketplace，不要静默覆盖或删除；让 Agent 先核对并展示准确的更新与回退。安装或更新 plugin 后，新建一个 Codex 任务，让三个 Skills 进入可发现列表。

在其他 Agent 宿主中，按该宿主正常的 Skill 安装方式，从已验证的 Skill bundle 安装 `cfkanban`、`cfkanban-admin`、`cfkanban-deploy` 三个目录。Agent 必须通过测试发行指针校验 immutable manifest 与 SHA-256，不能把本地 checkout、`main` 或 plugin cache 当作部署真相：

<https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.35/prerelease.json>

## 第二步：把部署意图交给 Agent

新建任务后说：

> 请使用 `$cfkanban-deploy` 和这份指南为我部署一个新的 cfKanban 实例。使用 `0.1.0-alpha.35` 测试发行版。先做只读检查；任何本地安装或 Cloudflare 写入前，先展示准确计划和所需授权。

这一句就够了。你不需要自己编资源名、migration 命令、digest 或 Wrangler 参数。

## 第三步：Agent 应该怎样推进

1. 运行 Skill 能力检查，只读核对现有 cfKanban 私有状态，不打印 Credential 或 Cloudflare token。
2. 校验 release pointer、immutable manifest、publisher、工件允许来源、Skill/Service bundle digest、Node/Wrangler/API 兼容范围和 schema version。
3. 优先复用兼容的 Node.js 与 Wrangler。Wrangler 缺失或不兼容时，先展示独立计划，再把固定版本安装到 `~/.cfkanban/tool-runtime/`；不得写入工作仓库或暴露成全局 PATH 命令。
4. 依次从既有部署 journal/receipt、环境 Token、用户明确给出的 profile、私有部署配置或 Wrangler 默认上下文解析 Cloudflare 身份。不得枚举 profile 猜账号、自动 activate，也不得输出原始鉴权结果。
5. 只在仍缺少时询问 Owner 显示名称。生成 strict-zero 计划：默认只创建一个 Worker 和一个 D1，先用 `workers.dev`；同时固定准确 account、资源名、碰撞检查、migration 分类、本地路径和恢复边界。
6. 等你批准这份冻结计划。DNS/自定义域名、付费服务、破坏性 migration、未知资源接管、账号变化或后续 plan drift 都要重新决定。
7. 按已授权 journal 执行。Owner Credential 直接生成到私有 pending 槽位，绝不能出现在聊天、命令参数、日志、Repo 或浏览器中。
8. 按 manifest 顺序应用 migration，同时读回 ledger 和真实 schema；部署 Worker 与 Web assets；建立同一个 Owner Principal；核对公开 discovery 与认证后的 `/meta`、`/me`。
9. 只有身份与 fingerprint 读回吻合才把 Credential 提升为 current，并写入脱敏 receipt。最终只报告实例地址、ID、版本和无秘密验证证据。

## 部署完成以后

用 `$cfkanban-admin` 明确创建 Workspace 和 Project。key 创建后不可改，显示名可以修改；部署过程不会偷偷创建这些容器。

随后用 `$cfkanban` 管理 Issues，并为明确 Project 创建 Browser Launch。需要邀请其他人或 Agent 时，使用 `$cfkanban-admin` 和[加入指南](./join.zh-CN.md)。浏览器永远不接收长期 Credential。

## 遇到这些情况就停下，别猜

发行版或 digest 无法校验、Cloudflare account 有歧义、同名资源无法证明属于本实例、本地 Credential 状态冲突、migration ledger 与 schema 漂移，或者操作新增了计划外 DNS、付费、破坏性或安全影响时，Agent 必须停下说明。

部署中断后，只在事实仍匹配时续做同一个 task/operation/plan journal；不能生成第二个 Owner 身份，也不能悄悄另起一套替代部署。
