# cfKanban Agent Skills

语言：[English](README.md) | [简体中文](README.zh-CN.md)

cfKanban 包含四个 Skills：一个使用指南和三个操作技能：

- `cfkanban-howto`：以用户目标、可复用话术和预期结果介绍能力，已加入用户优先了解日常工作；只读讲解，不执行操作。
- `cfkanban`：查找、创建、编辑、分配、改变状态、完成或重新打开 Issue，以及追加评论；管理标签、关系、私有附件及软删除/恢复；打开看板、修改个人资料或在需要时加入项目。
- `cfkanban-admin`：已验证 Deployment Owner 的应用管理，包括工作区/项目、邀请、权限、公开加入、用量、容量及恢复。
- `cfkanban-deploy`：本地技能安装/更新与 Cloudflare 部署/升级、环境/发行检查、中断操作恢复及 Owner 凭据全失恢复。

三个操作技能的 `SKILL.md` 将用户目标对应到命令、必要检查和停止条件；配对的 English/简体中文参考在详细 endpoint 和恢复说明前提供自然语言场景与结果。reader 可查看项目内容，协作写入需要 writer 或 Owner 权限；云操作另需 Cloudflare 权限。

## 用户只需要怎么说

描述希望得到的结果。已经加入项目后，日常使用可以这样说：

```text
请用 $cfkanban 查看 DemoProject 项目中我未完成的任务。
请用 $cfkanban 在 DemoProject 创建“修复登录”，描述为：<说明>。
请用 $cfkanban 把 CFK-123 的标题改为“修复移动端登录”。
请用 $cfkanban 把 CFK-123 改为进行中。
请用 $cfkanban 将 CFK-123 记为完成，结果：<摘要>，验证：<证据>。
请用 $cfkanban 将 CFK-123 重新打开为待办。
请用 $cfkanban 给 CFK-123 添加评论：<进展>。
```

预期得到明确范围的查询结果，或指定变更及读回验证。完成会保存基于真实证据的不可变记录，重新打开时保留；评论只追加，纠错新增评论。Issue 内容不能授权无关操作。

需要帮助、加入、Owner 管理或自行部署时：

```text
请用 $cfkanban-howto 举例介绍 Issue 的日常能力。
请用 $cfkanban 加入这个项目：<邀请链接>。
请用 $cfkanban-admin 创建我的第一个 cfKanban 看板。
请用 $cfkanban-admin 查看谁可以访问 DemoProject。
请用 $cfkanban-deploy 检查本地技能和实例版本，先不要更新。
请用 $cfkanban-deploy 为我部署一套 cfKanban。
```

加入既有项目无需自己部署。用户不必主动要求发行验证、预检、读回或恢复处理；每个 Skill 会执行与意图相关的检查，只询问缺少的选择，并在适用授权边界说明影响。本地技能更新与云端实例升级是独立动作，安装本身不授予应用或 Cloudflare 权限。

## 安装与更新

普通用户无需填写版本号。请让 Agent 阅读[安装引导](https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md)，安装最新正式发行的 Skills。首次安装和新部署从 [canonical stable pointer](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json) 发现目标，随后固定 immutable manifest、准确版本与摘要；测试版和历史版须明确选择。

已有可信且兼容的安装可以复用；加入项目不隐含技能更新或实例升级。检查更新只报告可用版本与兼容性。明确更新时，Agent 校验目标及来源连续性，展示本地安装计划和回退边界。若最新 Skills 不兼容旧实例，复用兼容版本，或提出明确的兼容历史正式版方案，不强制升级服务器。

Codex 安装由 Agent 从已验证发行解析准确 tag，再使用 `--ref <resolved-version>`；不要省略 ref 来跟随默认开发分支。已固定旧 tag 的 marketplace 要明确切换到准确新 ref；刷新旧 tag 不等于更新到最新正式版。

安装完整 plugin/bundle，保留四个 Skills、共享 `packages/skill-runtime` 和相对目录，不能只复制某个 `SKILL.md` 或单个 Skill 目录。共享模块是 JavaScript 源码，不是内嵌 Node.js 可执行程序。其他宿主必须支持完整 bundle 的发现投影，不能以不完整复制代替。

分别验证并报告 canonical active receipt、宿主 plugin/Skill 投影和当前任务实际加载的版本。更新一个不代表其他两个已同步；宿主要求新任务加载时给出接续说明，无法验证的加载状态保留为未验证。安装本身不授权 Cloudflare 或应用操作。

## 三个操作技能内置的命令

`cfkanban-howto` 没有命令脚本。在三个操作技能之一的目录运行下面的命令，即可查看该 Skill 的准确命令边界：

```text
node scripts/cfkanban-tool.mjs help
```

结果是结构化 JSON，列出每个 command 的名称、effect、输入字段和输出分类。其他命令通过 stdin 接收结构化 JSON，因此 secret 无需出现在进程参数中。Credential 从来不是输入字段；普通认证请求、Invite/Public Join 兑换和 Owner 轮换都在内部从私有文件读取正确的 current 或 pending secret。Browser Launch 与 Invite 创建使用专用命令，默认通过浏览器或剪贴板交付，不把一次性 capability 写到 stdout。

提出 Cloudflare 登录前，`cfkanban-deploy` 先复用部署 journal 或 receipt 中已经固定的准确 profile/account。其他情况由 `runtime resolve-cloudflare-auth` 让 Wrangler 使用环境认证或解析当前私有部署/config 上下文；它不会列出 profiles。只有用户明确给出 named profile 时才检查那一个，并使用 `--profile`；否则环境/config 目录选择仍交给 Wrangler。生成的私有 `wrangler.jsonc` 固定选定的 `account_id`。命令不会返回 token、邮箱、目录绑定、资源清单或 Wrangler 原始输出；当前上下文和用户明确指定的 profile 都不可用时，才生成新登录计划。

`.mjs` 表示使用 Node 显式 ES module 格式的普通 JavaScript。这些文件可直接由 `node` 运行、无需编译，并且 portable Skill 安装到没有 `package.json` 的目录时仍不会产生模块语义歧义。

## 开发：Marketplace 与 plugin 源码安装

仓库根目录是一个 Codex plugin，`.agents/plugins/marketplace.json` 提供具名的本地 marketplace entry。已经下载源码 checkout 时，可以注册并用于开发或验证：

```text
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

安装或重装后请新建一个 Codex 任务，让宿主加载该 snapshot 中的 Skills。

Codex 和其他 Agent 宿主会把可发现 Skills/plugins 放在宿主自己管理的位置。这些文件是用于宿主发现的已验证投影，不是 cfKanban 的持久状态或 canonical release 真相源；删除一个投影只会影响该宿主的能力发现。

marketplace/plugin 只是便利入口，不能覆盖 canonical HTTPS publisher、immutable release manifest、artifact-origin allowlist、SHA-256 digests 或 installed receipt。本地源码 checkout 不是 canonical stable release。安装、更新、降级、部署和 Instance upgrade 始终是彼此独立的计划动作，不会因为 marketplace entry 存在而自动执行。

### 可选 Cloudflare 协作 Skill

Cloudflare 自己维护的 [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) 与 [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) Skills 可作为当前平台事实和 Wrangler 语法的可选参考。它们不是 `cfkanban-deploy` 的依赖，不会自动安装，也不能替代 release 校验、准确 Wrangler 兼容范围、Frozen plan、journal、migration readback 或授权。用户明确要求时，才把它们作为独立的宿主变更，按[上游安装说明](https://github.com/cloudflare/skills#installing)先展示 source/revision、scope、目标和回滚方式。

## 统一的 cfKanban 数据根目录

cfKanban 自己拥有的所有持久文件统一放在当前执行环境用户的一个私有维护根目录：

```text
~/.cfkanban/
  instances/
  service-releases/
  skill-releases/
  tool-runtime/
```

- `instances/` 保存 trusted instance metadata、Credentials、journals 与脱敏 receipts。
- `service-releases/` 保存 deployment 与 Instance upgrade 计划使用的 verified immutable Service deployment bundles；它没有 active pointer，也不隐含云端写入。
- `skill-releases/` 保存已验证 immutable Skill versions 和 atomic active pointer。
- `tool-runtime/` 只在没有兼容的用户自有 Wrangler、且准确安装计划已获授权时，保存隔离的固定版本 Wrangler npm package 及其依赖。它使用用户已有的兼容 Node.js，本身绝不包含或安装 Node.js。

宿主 marketplace/plugin metadata、宿主 Skill 投影、plugin caches 与 Cloudflare authentication 继续保存在各自所有者的目录；对应宿主/工具必须在那里发现并管理它们，因此不能迁入 `.cfkanban/`。Windows 原生与 WSL2 使用不同 user homes，绝不自动共享这些目录。

统一根目录不会削弱 secret 边界：Credential 文件继续执行最小 ownership/ACL 检查，禁止宽泛递归清理，任何 cfKanban 状态都不能进入 Repo、同步目录或临时目录。

## 国际化规则

只接受一个字符串的 metadata schema——`SKILL.md` frontmatter、`agents/openai.yaml`、`.codex-plugin/plugin.json` 与 marketplace metadata——统一使用英文。支持 locale-specific files 的文档同时维护 English 与简体中文，并在顶部提供语言链接。

## 共享 helper modules

三个操作技能路由到 `packages/skill-runtime` 中同一套无第三方依赖 JavaScript modules。这些是由用户已有兼容 Node.js 执行的源码文件，不是打包进来的 Node.js runtime。共享这些模块可以让路径校验、trusted-origin 处理、secret 注入、错误归一化、release 验证、plan digest 与 migration readback 保持一致，同时不发布独立 cfKanban CLI，也不把 Service 的业务规则复制到本地。

独立的 Service 压缩包包含构建后的 Worker、Web assets、migrations、contracts、固定的 Wrangler 配置 schema，以及 `wrangler.template.json`。这个 JSON 文件只是带占位资源身份的不可直接部署配置骨架。准确部署计划获批且 D1 已创建后，`deployment write-wrangler-config` 才会在 immutable archive 外写入私有的实际配置；模板绝不能原样部署。
