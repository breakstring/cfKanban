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

首次安装默认发现最新正式发行；已有可信且兼容的安装应优先复用。读取 canonical stable pointer：

<https://github.com/breakstring/cfKanban/releases/latest/download/stable.json>

解析并固定不可变 manifest URL、SHA-256 和准确版本，验证 publisher、工件允许来源及所需 bundle 摘要。指针仅用于发现，后续操作沿用同一快照；缺失或校验失败时停止，不回退测试版、本地 cache 或开发源码。测试版和历史版只有在用户明确选择时才可使用。若已有可信 deploy Skill 支持 `release discover`，以 stdin `{}` 只读发现正式目标，再用 `release verify` 校验下载工件；没有该命令时按上述 HTTPS 文档流程检查，不为了检查而先更新技能。

需要安装时，把来源、准确版本、用户级 scope、本地路径和回退写入计划。Codex 全新安装由 Agent 把下方 `<resolved-version>` 替换为已验证版本对应的准确 tag，获得相应授权后执行；不要把占位符交给用户填写或原样执行，也不要省略 `--ref`：

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref <resolved-version>
codex plugin add cfkanban-agent-skills@cfkanban
```

已存在 `cfkanban` marketplace 时，先检查旧来源/ref，展示准确切换和回退；刷新旧 tag 不会自动切换到新 tag，不得静默删除或覆盖。安装完整 Skill bundle，保留四个 Skills、共享 `packages/skill-runtime` 和相对目录；其他宿主也须保留完整已验证 layout，不能只复制某个 Skill 目录。宿主不支持所需投影时说明限制。

分别核对 canonical active receipt、宿主 plugin/Skill 投影和当前任务实际加载状态。更新 canonical bundle 不等于更新宿主，宿主已安装也不等于当前任务已加载。需要新任务时说明具体接续操作和剩余步骤；无法验证时明确标为未验证。

检查更新与执行更新分开；本地技能更新与云端实例升级独立。若最新 Skills 与目标旧实例不兼容，复用已验证兼容安装，或说明限制并提出明确的兼容历史正式版方案；不得为了加入或更新技能强制升级服务器。

## 第三步：运行部署 Skill

完整读取已安装的 `cfkanban-deploy/SKILL.md` 及其部署流程参考。在该 Skill 目录运行真实命令目录：

```text
node scripts/cfkanban-tool.mjs help
```

按命令目录用 stdin 传入结构化 JSON，不猜参数，不在输入中携带秘密。用 `capabilities`、`release discover`、`release verify`、`runtime resolve-wrangler` 以及鉴权和读回命令完成预检；用 `plan strict-zero`、journal 命令和 `deploy wrangler-action` 执行获准部署。遵循 Skill 的完整阶段顺序，并检查以下节点：

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

如果用户任务包含初始化看板，继续用 `cfkanban-admin` 创建准确范围的 Workspace 和 Project，分别读回。否则只提出下一步，不擅自写入。服务端生成不可变 UUID，用户只需提供显示名称，之后可以改名；部署本身不创建这两个容器。

用 `cfkanban` 执行用户请求的 Issue 操作或明确 Project 范围的 `web launch`。邀请使用 `cfkanban-admin`，接收方入项参考[加入指南](./join.zh-CN.md)。长期 Credential 不得进入浏览器。

## 遇到这些情况就停下，别猜

发行版或 digest 无法校验、Cloudflare account 有歧义、同名资源无法证明属于本实例、本地 Credential 状态冲突、migration ledger 与 schema 漂移，或者操作新增了计划外 DNS、付费、破坏性或安全影响时，停下说明准确阻塞原因。

部署中断后，只在事实仍匹配时续做同一个 task/operation/plan journal；不能生成第二个 Owner 身份，也不能悄悄另起一套替代部署。
