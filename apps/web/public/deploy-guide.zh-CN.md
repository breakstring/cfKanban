# cfKanban 部署指南（面向 Agent）

[English](./deploy-guide.md) | 简体中文

本指南直接面向接收 cfKanban 部署任务的 Agent。请从用户交付本链接时的请求继续，不要让用户再向另一个 Agent 转述提示词。读取这份 HTTPS 文档不等于获得安装或云端写入授权；先按文本检查，禁止把获取的文档或脚本通过管道送进 shell。

## 第一步：检查任务与环境

- 检查当前宿主是否支持读取 HTTPS 文档、安装或加载本地 Skills、运行 Node.js 命令。缺少必要能力时，报告准确限制和需要用户完成的最小操作。
- 复用 Node.js `>=22.12.0 <27`。没有单独获准的环境变更计划，不得安装 Node.js 或修改 shell、PATH、版本管理器。
- 检查已有 cfKanban Skills 和私有部署状态。如果目标是已有实例或中断的操作，沿用已验证的 receipt/journal，不要另建替代实例。
- 通过 Skill 的只读鉴权流程解析可创建 1 个 Worker 和 1 个 D1 的 Cloudflare 账号。只有鉴权不可用时，才提出官方浏览器或设备登录计划。
- 使用用户明确提供的 Deployment Owner 显示名称；缺少时只询问这个名称，不能从 OS、Git、hostname 或 Agent 身份推断。

资源名和技术参数由你在规划时生成，不要要求用户预先创建 Worker、D1、Workspace、Project 或 Credential。

## 第二步：加载或安装已验证的 Skills

本指南链接的测试发行版是 `0.1.0-alpha.47`。明确说明它是预发行版，选用前确认用户已明确选择测试版本，不得静默替代 stable。已有兼容且经过验证的安装应优先复用；本地 Skill 安装或更新与云端实例部署或升级是不同操作。

如果当前宿主是 Codex 且确需安装，先展示宿主级计划：来源 `https://github.com/breakstring/cfKanban.git`、不可变 ref `0.1.0-alpha.47`、用户级范围，以及卸载本次新装 plugin 的回退方式。获得授权后，全新安装使用：

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.47
codex plugin add cfkanban-agent-skills@cfkanban
```

如果已经存在其他 ref 的 `cfkanban` marketplace，先核对并展示准确的更新与回退，不得静默覆盖或删除。安装后检查 Skill 发现状态；宿主确实要求新任务才能加载 plugin 时，说明这一具体接续操作、目标版本和剩余步骤，不能在尚不可发现时声称 Skills 已加载。

在其他 Agent 宿主中，按其支持的 Skill 机制，从已验证的 Skill bundle 安装 `cfkanban`、`cfkanban-admin`、`cfkanban-deploy` 三个目录。解析以下测试发行指针，校验不可变版本清单、工件允许来源和 SHA-256 摘要。本地 checkout、`main` 或 plugin cache 不能作为部署版本依据：

<https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.47/prerelease.json>

## 第三步：运行部署 Skill

完整读取已安装的 `cfkanban-deploy/SKILL.md` 及其部署流程参考。在该 Skill 目录运行真实命令目录：

```text
node scripts/cfkanban-tool.mjs help
```

按命令目录用 stdin 传入结构化 JSON，不猜参数，不在输入中携带秘密。用 `capabilities`、`release verify`、`runtime resolve-wrangler` 以及鉴权和读回命令完成预检；用 `plan strict-zero`、journal 命令和 `deploy wrangler-action` 执行获准部署。遵循 Skill 的完整阶段顺序，并检查以下节点：

1. 运行 Skill 能力检查，只读核对现有 cfKanban 私有状态，不打印 Credential 或 Cloudflare token。
2. 校验 release pointer、immutable manifest、publisher、工件允许来源、Skill/Service bundle digest、Node/Wrangler/API 兼容范围和 schema version。
3. 优先复用兼容的 Node.js 与 Wrangler。Wrangler 缺失或不兼容时，先展示独立计划，再把固定版本安装到 `~/.cfkanban/tool-runtime/`；不得写入工作仓库或暴露成全局 PATH 命令。
4. 依次从既有部署 journal/receipt、环境 Token、用户明确给出的 profile、私有部署配置或 Wrangler 默认上下文解析 Cloudflare 身份。不得枚举 profile 猜账号、自动 activate，也不得输出原始鉴权结果。
5. 只在仍缺少时询问 Owner 显示名称。生成 strict-zero 计划：默认只创建一个 Worker 和一个 D1，先用 `workers.dev`；同时固定准确 account、资源名、碰撞检查、migration 分类、本地路径和恢复边界。
6. 执行前取得用户对准确 task/operation/plan digest 的授权。在该授权内续做事实未变、journal 可证明的步骤，不逐命令重复确认。DNS/自定义域名、付费服务、破坏性 migration、未知资源接管、账号变化或后续计划漂移需要新授权。
7. 按已授权 journal 执行。Owner Credential 直接生成到私有 pending 槽位，绝不能出现在聊天、命令参数、日志、Repo 或浏览器中。
8. 按 manifest 顺序应用 migration，同时读回 ledger 和真实 schema；部署 Worker 与 Web assets；建立同一个 Owner Principal；核对公开 discovery 与认证后的 `/meta`、`/me`。
9. 只有身份与 fingerprint 读回吻合才把 Credential 提升为 current，并写入脱敏 receipt。最终只报告实例地址、ID、版本和无秘密验证证据。

## 第四步：验证并交付

报告已验证的实例地址与 ID、Owner Principal ID、Skill/Service 版本和脱敏 receipt/journal 引用。分别说明已完成、待续和失败的步骤；上传成功本身不代表部署完成。

如果用户任务包含初始化看板，继续用 `cfkanban-admin` 创建准确范围的 Workspace 和 Project，分别读回。否则只提出下一步，不擅自写入。key 创建后不可改，显示名可以修改；部署本身不创建这两个容器。

用 `cfkanban` 执行用户请求的 Issue 操作或明确 Project 范围的 `web launch`。邀请使用 `cfkanban-admin`，接收方入项参考[加入指南](./join.zh-CN.md)。长期 Credential 不得进入浏览器。

## 遇到这些情况就停下，别猜

发行版或 digest 无法校验、Cloudflare account 有歧义、同名资源无法证明属于本实例、本地 Credential 状态冲突、migration ledger 与 schema 漂移，或者操作新增了计划外 DNS、付费、破坏性或安全影响时，停下说明准确阻塞原因。

部署中断后，只在事实仍匹配时续做同一个 task/operation/plan journal；不能生成第二个 Owner 身份，也不能悄悄另起一套替代部署。
