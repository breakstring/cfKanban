# cfKanban

[English](README.md) | 简体中文

cfKanban 是一套面向 Agent 协作方式的轻量自托管 Kanban。你让 Agent 部署和操作它；同一个 Cloudflare Worker 也会提供可供人类直接使用的中英双语 Web 看板。

核心只需要一个 Cloudflare Worker 和一个 D1 数据库；Issue 附件可选用私有 R2 存储。不需要独立服务器、Pages project、KV namespace，也不发布独立的 cfKanban CLI。

## 看看它如何工作

https://github.com/user-attachments/assets/94b3d30b-a1a7-4ad2-9924-838a8317d3bb

## 当前可用状态

cfKanban 目前是**公开测试预览版**，还不是面向普通用户的稳定发行版。

- Worker、D1 schema、Web UI 和四个 Agent Skills 已经在本仓库中实现。
- 你现在可以从这个公开仓库安装 Codex plugin，并检查或试用这些 Skills。
- [`1.0.0-rc.7` GitHub 测试发行版](https://github.com/breakstring/cfKanban/releases/tag/1.0.0-rc.7) 提供用于跨系统候选版验收的不可变 Skill 与 Service bundle，新增可搜索的管理员下拉选择和中英文产品介绍视频，继续使用 schema 10。
- 升级后 Owner 需明确设置附件容量才能新增上传，已有文件保持可访问；Cloudflare 统计需单独配置只读 Token。
- 机器可读的测试入口是 [`prerelease.json`](https://github.com/breakstring/cfKanban/releases/download/1.0.0-rc.7/prerelease.json)。
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
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 1.0.0-rc.7
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

`1.0.0-rc.7` 包含四个 Skills：一个入门指南和三个操作技能：

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

当前测试预览阶段还没有稳定部署目标。Skill 应该直接说明这一点，并可以把 `1.0.0-rc.7` 作为需要你明确选择的测试版本；它不能静默选择测试版、marketplace cache 或当前工作目录。

需要完整的逐步路径时，请把[部署指南](apps/web/public/deploy-guide.zh-CN.md)交给 Agent。它会明确说明 Skill 安装、环境检查、授权、部署、读回和恢复，不要求 Agent 从这份通用 README 自己猜流程。

如果你明确想评估某个源码修订，请把这一点说清楚：

> 请使用 `$cfkanban-deploy` 评估当前源码能否用于部署 cfKanban。

源码评估属于工程路径，不是稳定安装路径。两者的区别和影响应该由 Skill 解释，不应该要求用户自己组织这段警告。

当前 Skill 还没有能够冻结上述全部事实的源码专用远端部署计划，因此正确的源码评估会在 Cloudflare 写入前停止。请使用已发布的 prerelease 执行下方受支持的测试流程。

## 部署 Skill 会替你处理什么

无论现在使用测试版，还是以后使用稳定版，入口都可以是上面同一句话。Skill 负责：

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

按准确 lockfile 安装依赖并运行完整仓库验证：

```sh
npm ci
npm run validate
```

`npm run validate` 包含 typecheck、单元与集成测试、OpenAPI/error 检查、生成物漂移检查、本地 D1 验证、无 Credential 的 CI policy 检查、Web build 和 Worker dry-run build。它不会登录 Cloudflare，也不会写入远端资源。

源码维护者发布 GitHub 附件时，使用[Release 发布与中断恢复流程](docs/release-publication.md)。该工具先验证 draft，再单独公开；它不是用户部署或 Skill 更新入口。

建议从[文档导航](docs/README.md)、[产品简报](docs/product/product-brief.md)、[用户 Storyboard](docs/product/user-storyboard.md)、[Agent Skills 指南](docs/skills/README.zh-CN.md)和[实施计划](docs/plans/2026-08-29-v0-implementation-plan.md)开始；冻结的技术合同位于 [`docs/specs/`](docs/specs/)。
