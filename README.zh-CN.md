# cfKanban

[English](README.md) | 简体中文

cfKanban 是一套面向 Agent 协作方式的轻量自托管 Kanban。你让 Agent 部署和操作它；同一个 Cloudflare Worker 也会提供可供人类直接使用的中英双语 Web 看板。

核心只需要一个 Cloudflare Worker 和一个 D1 数据库；Issue 附件可选用私有 R2 存储。不需要独立服务器、Pages project、KV namespace，也不发布独立的 cfKanban CLI。

## 看看它如何工作

https://github.com/user-attachments/assets/94b3d30b-a1a7-4ad2-9924-838a8317d3bb

## 正式发行

首次安装和新部署默认使用最新正式发行。你不需要选择或填写版本号；Agent 从[官方稳定发行入口](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json)发现版本，校验并固定准确工件后，再准备安装或部署计划。已有可信且兼容的 Skills 可以继续复用，加入项目不会顺带升级服务器。

本地技能更新与云端实例升级是独立动作。测试版、历史版和源码开发仅在明确选择时使用；稳定发行不可用或校验失败时，Agent 会说明原因，不会改用开发快照。

发行压缩包不包含 Node.js 可执行程序。Skill bundle 包含四个 Skills 和共享 JavaScript helper modules，由用户已有的兼容 Node.js 运行；Service bundle 包含构建后的 Worker、Web assets、migrations、contracts 和 Wrangler 配置骨架。Agent 会根据获准计划生成私有配置，普通用户无需手动解压或修改工件。

## 你需要准备什么

在 Codex 中使用需要：

- 支持 plugin 的 Codex 桌面应用或 Codex CLI；
- 能够访问本仓库的 Git 环境；
- 安装 plugin 后新建一个 Codex 任务，让新 Skills 被加载。

自行部署到 Cloudflare 时还需要：

- 一个有权创建一个 Worker 和一个 D1 数据库的 Cloudflare 账户；
- 兼容的 Node.js 与 Wrangler 环境。`cfkanban-deploy` 会先检查已有工具；Wrangler 不可用时，只有在展示并获得独立安装计划授权后，才能把固定版本的 Wrangler package 安装到 `~/.cfkanban/tool-runtime/`。它不会内嵌或安装 Node.js；
- 你希望 cfKanban 使用的 Owner display name。Agent 不能从操作系统账号或 Git identity 猜测这个名称。

## 安装 Skills

把下面这句话交给你的 Agent：

> 请阅读 https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md，为我安装 cfKanban 最新正式发行的 Skills。

Agent 会检查已有安装、解释所需本地变更，并处理宿主安装。如果使用 Codex，Agent 会从已验证发行解析准确 tag，再内部使用 `--ref <resolved-version>` 安装；你不需要维护这个参数。若宿主需要新任务才能加载，Agent 会明确告知。安装本身不会部署或升级 Cloudflare 实例，也不授予应用权限。

cfKanban 包含四个 Skills：一个入门指南和三个操作技能：

| Skill | 适合交给它的任务 |
| --- | --- |
| `$cfkanban-howto` | 先了解日常使用、Owner 管理和部署分别能做什么，以及应该如何提问。 |
| `$cfkanban` | 加入 Project，并处理 Issue、Comment 和 Web 看板中的日常工作。 |
| `$cfkanban-admin` | 创建看板，以及管理 Project、邀请、访问权限和 Owner 设置。 |
| `$cfkanban-deploy` | 部署、更新、续做或恢复一套 cfKanban。 |

通常你只需用自然语言告诉 Skill 想做什么。内置 `.mjs` 命令是 Agent 使用的确定性工具，普通用户无需手工运行。

## 安装后：先用 Howto 了解怎么使用

在新任务里，建议先让只读使用指南带你入门：

> 请使用 `$cfkanban-howto` 介绍 cfKanban 怎么用、我的需求应该交给哪个技能，并给我几个可以直接使用的例子。

也可以问得更具体：“我已经加入一个项目，怎样查看我的任务、创建 Issue、修改状态和添加评论？”Howto 会解释可用操作并推荐下一步使用的技能；询问使用方法不会执行这些操作。

随后按自己的情况继续：

- **收到已有项目的邀请**：按[加入步骤](#加入别人已有的-cfkanban-project)操作，不需要自行部署 Cloudflare。
- **已经有项目访问权限**：让 `$cfkanban` 查看某个项目中自己未完成的任务，或打开看板。
- **希望自己托管实例**：按[部署步骤](#让-agent-帮你部署)操作，再以 Owner 身份创建第一个看板。

Howto 是推荐的入门入口，不是必经的初始化步骤；如果已经知道要做什么，可以直接使用对应操作技能。更多例子见 [Agent Skills 指南](docs/skills/README.zh-CN.md)。

## 让 Agent 帮你部署

新建任务后，只说这一句话就够了：

> 请使用 `$cfkanban-deploy` 为我部署一套 cfKanban。

你不需要理解或说出 manifest、digest、preflight、deployment plan、migration、rollback journal 这些术语。Skill 会自动完成这些工作：先做只读检查，用普通语言告诉你当前能做什么、还缺什么，只询问真正缺少的信息，并在安装或部署任何内容前展示准确影响。

如果需要登录 Cloudflare，Skill 会把它作为一份独立的小计划展示；获批后再打开对应的浏览器或 device flow。完成登录不会创建 Worker 或 D1 数据库，真正的部署计划仍会在后面单独请求确认。

Agent 默认发现最新正式发行，在计划中固定准确版本、来源和摘要；执行途中不会因出现新版而更换目标。

需要完整的逐步路径时，请把[部署指南](apps/web/public/deploy-guide.zh-CN.md)交给 Agent。它会明确说明 Skill 安装、环境检查、授权、部署、读回和恢复，不要求 Agent 从这份通用 README 自己猜流程。

## 部署 Skill 会替你处理什么

Skill 负责：

1. 确认准确的发行版本，并检查文件没有被替换；
2. 检查当前电脑，尽量复用已有的兼容 Node.js 与 Wrangler；
3. 优先复用 journal/receipt 中的准确认证目标，或让 Wrangler 解析当前私有部署/config 上下文；只有用户明确指定时才考虑其他 profile，并由私有配置固定准确 account；
4. 在请求确认前，说明会创建哪些资源、修改哪些本地内容、可能的费用和恢复边界；
5. 获得确认后才创建一个 Worker、一个 D1 数据库和内置 Web 应用；
6. 完成后读回验证，再报告部署成功。

默认计划只在 `workers.dev` 创建一个 Worker 和一个 D1。custom domain、付费服务、破坏性 migration、资源接管或替换，以及权限变化都必须生成新的明确计划并重新授权。

## 得到第一个真正可用的看板

部署验证完成后，可以新建任务或继续使用已安装的 Skills：

1. 让 `$cfkanban-admin` 验证 Owner identity，按你选择的显示名称创建一个 Workspace、一个 Project，读回两者，再创建 Owner Web launch。
2. 专用 launch 命令默认直接打开看板，不返回一次性 URL。长期 Credential 不会进入浏览器或 URL。
3. 让 `$cfkanban` 创建第一条 Issue，或直接通过 Agent 在这个 Project 中工作。
4. 需要其他人或 Agent 加入时，让 `$cfkanban-admin` 创建邀请，并明确目标 Project 和 `reader` 或 `writer` 权限；专用命令默认把一次性话术复制到剪贴板，不写普通 stdout。

给用户的提示词仍然可以很短：

> 请使用 `$cfkanban-admin` 创建我的第一个 cfKanban 看板。

Skill 会验证 Owner，询问还缺少的 Workspace 与 Project 显示名称，说明每次写入、读回结果，然后提供 Web 看板入口。

## 加入别人已有的 cfKanban Project

安装 plugin、新建任务，然后把一次性 Invite URL 交给你的 Agent：

[加入指南](apps/web/public/join.zh-CN.md)同时覆盖尚未安装 Skill 的接收方，并分别说明 Project Invite 与 Public Join 路径。

> 请使用 `$cfkanban` 加入这个 Project：`<邀请链接>`

Skill 会先检查邀请，说明要加入的 Project 和权限，并且只在缺少信息或需要确认时询问你。条件允许时，它会复用你在该实例已有的身份；否则只询问显示名称，把 pending Credential 直接写入私有本地状态，兑换 Invite，验证 `/api/v1/me`，并且只在读回匹配后提升 Credential。不要把长期 Credential 粘贴进聊天、环境变量、命令参数、代码仓库或浏览器存储。

## 本地数据与安全边界

cfKanban 自己拥有的持久本地数据统一使用当前执行环境用户的私有目录：

```text
~/.cfkanban/
  instances/       # trusted instance metadata、Credentials、journals、receipts
  service-releases/ # verified immutable Service deployment bundles
  skill-releases/  # verified immutable Skill releases 与 active pointer
  tool-runtime/    # 隔离的固定版本 Wrangler package；不包含 Node.js runtime
```

Codex marketplace 配置和 plugin cache 仍放在 Codex 自己管理的目录，因为 Codex 只能在那里发现它们。这些内容是可丢弃的宿主投影，不是 cfKanban 状态，也不是 canonical release 真相源。Windows 原生和 WSL2 使用各自独立的用户目录，绝不自动混用。

## 参与开发

### 源码开发与测试环境

开发时可显式注册准确 checkout：

```sh
cd /absolute/path/to/cfKanban
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

记录 commit 和未提交状态；源码 checkout、`main` 与本地修改不代表正式发行。测试版或历史版必须明确选择，已发布 tag 和工件不可覆盖。当前 Skill 不提供冻结源码事实的远端部署计划，源码评估应在 Cloudflare 写入前停止。

本项目采用本地隔离开发环境，并将 `cfkanban.dev` 作为持久的公开测试、演示和自用实例。网站可以运行测试版；GitHub stable 仍是用户自行部署的推荐发行。演示站中的真实数据继续遵循原有迁移、权限与恢复保护，仅创建测试 Project 不能隔离部署或迁移。维护者可以使用仅在本仓库提供的 [project-release 技能](.agents/skills/project-release/SKILL.md)准备发行，并在授权范围内升级网站。同一套兼容 Skills 可以操作多套明确选择的实例。

按准确 lockfile 安装依赖并运行完整仓库验证：

```sh
npm ci
npm run validate
```

`npm run validate` 包含 typecheck、单元与集成测试、OpenAPI/error 检查、生成物漂移检查、本地 D1 验证、无 Credential 的 CI policy 检查、Web build 和 Worker dry-run build。它不会登录 Cloudflare，也不会写入远端资源。

源码维护者发布 GitHub 附件时，使用[Release 发布与中断恢复流程](docs/release-publication.md)。该工具先验证 draft，再单独公开；它不是用户部署或 Skill 更新入口。

建议从[文档导航](docs/README.md)、[产品简报](docs/product/product-brief.md)、[用户 Storyboard](docs/product/user-storyboard.md)、[Agent Skills 指南](docs/skills/README.zh-CN.md)和[实施计划](docs/plans/2026-08-29-v0-implementation-plan.md)开始；冻结的技术合同位于 [`docs/specs/`](docs/specs/)。

## 友情链接

<p align="center">
  <a href="https://linux.do" alt="LINUX DO"><img src="https://shorturl.at/ggSqS" alt="LINUX DO" /></a>
</p>
