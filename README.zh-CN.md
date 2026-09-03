# cfKanban

[English](README.md) | 简体中文

cfKanban 是一套面向 Coding Agents 协作方式的轻量自托管 Kanban。你让 Agent 部署和操作它；同一个 Cloudflare Worker 也会提供可供人类直接使用的中英双语 Web 看板。

整个系统只需要一个 Cloudflare Worker 和一个 D1 数据库，不需要独立服务器、Pages project、KV namespace，也不发布独立的 cfKanban CLI。

## 当前可用状态

cfKanban 目前是**公开测试预览版**，还不是面向普通用户的稳定发行版。

- Worker、D1 schema、Web UI 和三个 Agent Skills 已经在本仓库中实现。
- 你现在可以从这个公开仓库安装 Codex plugin，并检查或试用这些 Skills。
- [`0.1.0-alpha.8` GitHub 测试发行版](https://github.com/breakstring/cfKanban/releases/tag/0.1.0-alpha.8) 提供了不可变的 Skill 与 Service bundle；在提出新登录前，它会安全发现并复用已有 Wrangler profile/account 映射，可用于测试。
- 机器可读的测试入口是 [`prerelease.json`](https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.8/prerelease.json)。
- 稳定发行指针和真实多环境部署验收尚未发布。
- 不要把 `main`、本地 checkout 或 marketplace snapshot 当成 canonical stable release 或生产就绪部署。

这个区别很重要：plugin 只帮助 Codex 发现 Skills；未来的 canonical release manifest 才会固定并校验真正允许部署的 Skill bundle 与 Service bundle。

发行压缩包不包含 Node.js 可执行程序。Skill bundle 里是普通 `.mjs` helper modules，由用户电脑上已有的兼容 Node.js 运行。Service bundle 里是构建后的 Worker、Web assets、migrations、contracts，以及一份 `wrangler.template.json` 配置骨架；部署 Skill 不会直接使用其中的占位资源值，而是在部署前根据已批准计划生成一份私有的实际 Wrangler 配置。普通用户不需要手工解压这两个文件。

## 你需要准备什么

当前测试预览路径需要：

- 支持 plugin 的 Codex 桌面应用或 Codex CLI；
- 能够访问本仓库的 Git 环境；
- 安装 plugin 后新建一个 Codex 任务，让新 Skills 被加载。

未来部署到 Cloudflare 时还需要：

- 一个有权创建一个 Worker 和一个 D1 数据库的 Cloudflare 账户；
- 兼容的 Node.js 与 Wrangler 环境。`cfkanban-deploy` 会先检查已有工具；Wrangler 不可用时，只有在展示并获得独立安装计划授权后，才能把固定版本的 Wrangler package 安装到 `~/.cfkanban/tool-runtime/`。它不会内嵌或安装 Node.js；
- 你希望 cfKanban 使用的 Owner display name。Agent 不能从操作系统账号或 Git identity 猜测这个名称。

## 在 Codex 中安装测试预览 Skills

本仓库本身就是一个 Codex plugin marketplace。可以在命令行添加不可变的测试 tag，并安装其中的 plugin：

```sh
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.8
codex plugin add cfkanban-agent-skills@cfkanban
```

`--ref` 不是必填参数；上面特意使用它，只是为了把安装固定在不可变的测试 tag。只有在你明确想试用最新、可能变化的开发快照时，才省略 `--ref`；此时 Codex 会使用仓库的默认分支，当前为 `main`。

如果你已经有本地 checkout，也可以注册这个准确的 checkout：

```sh
cd /absolute/path/to/cfKanban
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

安装后请**新建一个 Codex 任务**。安装 plugin 不会修改 Cloudflare、创建 `~/.cfkanban/`、部署 Service，也不代表已经授权任何后续操作。

plugin 包含三个 Skills：

| Skill | 适合交给它的任务 |
| --- | --- |
| `$cfkanban-deploy` | 部署、更新、续做或恢复一套 cfKanban。 |
| `$cfkanban-admin` | 创建看板，以及管理 Project、邀请、访问权限和 Owner 设置。 |
| `$cfkanban` | 加入 Project，并处理 Issue、Comment 和 Web 看板中的日常工作。 |

通常你只需用自然语言告诉 Skill 想做什么。内置 `.mjs` 命令是 Agent 使用的确定性工具，普通用户无需手工运行。

## 让 Agent 帮你部署

新建任务后，只说这一句话就够了：

> 请使用 `$cfkanban-deploy` 为我部署一套 cfKanban。

你不需要理解或说出 manifest、digest、preflight、deployment plan、migration、rollback journal 这些术语。Skill 会自动完成这些工作：先做只读检查，用普通语言告诉你当前能做什么、还缺什么，只询问真正缺少的信息，并在安装或部署任何内容前展示准确影响。

如果需要登录 Cloudflare，Skill 会把它作为一份独立的小计划展示；获批后再打开对应的浏览器或 device flow。完成登录不会创建 Worker 或 D1 数据库，真正的部署计划仍会在后面单独请求确认。

当前测试预览阶段还没有稳定部署目标。Skill 应该直接说明这一点，并可以把 `0.1.0-alpha.8` 作为需要你明确选择的测试版本；它不能静默选择测试版、marketplace cache 或当前工作目录。

如果你明确想评估某个源码修订，请把这一点说清楚：

> 请使用 `$cfkanban-deploy` 评估当前源码能否用于部署 cfKanban。

源码评估属于工程路径，不是稳定安装路径。两者的区别和影响应该由 Skill 解释，不应该要求用户自己组织这段警告。

当前 Skill 还没有能够冻结上述全部事实的源码专用远端部署计划，因此正确的源码评估会在 Cloudflare 写入前停止。请使用已发布的 prerelease 执行下方受支持的测试流程。

## 部署 Skill 会替你处理什么

无论现在使用测试版，还是以后使用稳定版，入口都可以是上面同一句话。Skill 负责：

1. 确认准确的发行版本，并检查文件没有被替换；
2. 检查当前电脑，尽量复用已有的兼容 Node.js 与 Wrangler；
3. 先安全发现并复用已有 Wrangler profile/account 映射；只有无法解析既有登录时才生成 Cloudflare 登录计划，随后只询问 Owner 显示名称等真正缺少的选择；
4. 在请求确认前，说明会创建哪些资源、修改哪些本地内容、可能的费用和恢复边界；
5. 获得确认后才创建一个 Worker、一个 D1 数据库和内置 Web 应用；
6. 完成后读回验证，再报告部署成功。

默认计划只在 `workers.dev` 创建一个 Worker 和一个 D1。custom domain、付费服务、破坏性 migration、资源接管或替换，以及权限变化都必须生成新的明确计划并重新授权。

## 得到第一个真正可用的看板

部署验证完成后，可以新建任务或继续使用已安装的 Skills：

1. 让 `$cfkanban-admin` 验证 Owner identity，按你选择的 key 和名称创建一个 Workspace、一个 Project，读回两者，再创建 Owner Web launch。
2. 打开返回的一次性 URL。长期 Credential 不会进入浏览器或 URL。
3. 让 `$cfkanban` 创建第一条 Issue，或直接通过 Agent 在这个 Project 中工作。
4. 需要其他人或 Agent 加入时，让 `$cfkanban-admin` 创建邀请，并明确目标 Project 和 `reader` 或 `writer` 权限。

给用户的提示词仍然可以很短：

> 请使用 `$cfkanban-admin` 创建我的第一个 cfKanban 看板。

Skill 会验证 Owner，询问还缺少的 Workspace 与 Project 名称/key，说明每次写入、读回结果，然后提供 Web 看板入口。

## 加入别人已有的 cfKanban Project

安装 plugin、新建任务，然后把一次性 Invite URL 交给你的 Agent：

> 请使用 `$cfkanban` 加入这个 Project：`<邀请链接>`

Skill 会先检查邀请，说明要加入的 Project 和权限，并且只在缺少信息或需要确认时询问你。条件允许时，它会复用你在该实例已有的身份；否则只询问显示名称，把 pending Credential 直接写入私有本地状态，兑换 Invite，验证 `/api/v1/me`，并且只在读回匹配后提升 Credential。不要把长期 Credential 粘贴进聊天、环境变量、命令参数、代码仓库或浏览器存储。

## 本地数据与安全边界

cfKanban 自己拥有的持久本地数据统一使用当前执行环境用户的私有目录：

```text
~/.cfkanban/
  instances/       # trusted instance metadata、Credentials、journals、receipts
  skill-releases/  # verified immutable Skill releases 与 active pointer
  tool-runtime/    # 隔离的固定版本 Wrangler package；不包含 Node.js runtime
```

Codex marketplace 配置和 plugin cache 仍放在 Codex 自己管理的目录，因为 Codex 只能在那里发现它们。这些内容是可丢弃的宿主投影，不是 cfKanban 状态，也不是 canonical release 真相源。Windows 原生和 WSL2 使用各自独立的用户目录，绝不自动混用。

## 参与开发

按准确 lockfile 安装依赖并运行完整仓库验证：

```sh
npm ci
npm run validate
```

`npm run validate` 包含 typecheck、单元与集成测试、OpenAPI/error 检查、生成物漂移检查、本地 D1 验证、无 Credential 的 CI policy 检查、Web build 和 Worker dry-run build。它不会登录 Cloudflare，也不会写入远端资源。

建议从[文档导航](docs/README.md)、[产品简报](docs/product/product-brief.md)、[用户 Storyboard](docs/product/user-storyboard.md)、[Agent Skills 指南](docs/skills/README.zh-CN.md)和[实施计划](docs/plans/2026-08-29-v0-implementation-plan.md)开始；冻结的技术合同位于 [`docs/specs/`](docs/specs/)。
