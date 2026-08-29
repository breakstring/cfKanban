# Agent Skill 与本地部署环境能力快照

- 快照日期：2026-08-28
- 性质：易漂移研究事实，不是长期产品承诺
- 来源：Agent Skills、OpenAI、Anthropic 与 Cloudflare 官方资料

Agent 宿主、Skill 安装路径、权限模型、Wrangler 版本和操作系统支持会变化。实现 Skill、内置 scripts、安装器或发布新版本前必须重新核对当前官方资料。

## Agent Skills 共同格式

Agent Skills 开放规范当前定义：Skill 至少是一个包含 `SKILL.md` 的目录；可以附带 `scripts/`、`references/` 和 `assets/`。`SKILL.md` 使用 YAML frontmatter 加 Markdown，必需字段为 `name` 与 `description`；`compatibility` 可以描述宿主、系统包和网络等环境要求。`allowed-tools` 仍是实验字段，Agent 实现之间可能不一致。

规范明确指出脚本支持的语言取决于 Agent 实现，常见但非保证的选择包括 Python、Bash 和 JavaScript。因此 cfKanban 不能只因一种脚本在某个 Agent 上可运行，就把它当成跨宿主合同。

规范同时推荐渐进加载：启动时只暴露元数据，触发后加载 `SKILL.md`，references/scripts/assets 按需使用；主 `SKILL.md` 建议保持在 500 行以内，文件引用避免深层链式跳转。

来源：

- [Agent Skills specification](https://agentskills.io/specification)
- [OpenAI Skills catalog](https://github.com/openai/skills)
- [Anthropic Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

## Codex 与 Claude Code 差异

两者都能使用以 `SKILL.md` 为核心的技能，但发行与宿主集成不是同一个合同。

- OpenAI 当前把 Skills 描述为可由 Agent 发现并使用的 instructions、scripts 和 resources 目录，并通过 Codex 的 Skill/Plugin 分发机制安装；OpenAI Skills API 还提供服务端 Skill 与 immutable versions，但这不等同于本地 Codex Skill 安装路径。
- Claude Code 当前支持 personal、project、plugin 和 enterprise 等来源；个人目录为 `~/.claude/skills/`，项目目录为 `.claude/skills/`，并有自己的优先级、动态发现、云会话和 plugin 行为。
- 宿主特有的 UI metadata、安装位置、命名空间、权限策略和 reload 行为不能写入 portable core；应由 bootstrap 安装规则或 bundle 内宿主兼容脚本处理。它们是实现细节，不需要成为独立产品角色。

来源：

- [OpenAI Skills API](https://developers.openai.com/api/reference/go/resources/skills)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)

## Wrangler 与跨平台部署事实

Cloudflare 当前建议在项目内安装固定 Wrangler 版本，而不是依赖全局安装或每次通过 `npx` 获取不受控的最新版。Wrangler 需要 Node.js/npm；Cloudflare 建议优先使用 Node version manager，以减少权限问题并允许切换版本。Wrangler 支持 Node.js Current、Active 和 Maintenance 版本；当前支持 macOS 13.5+、Windows 11 和具备 glibc 2.35 的 Linux 发行版。

Node.js 的具体 LTS、Current 和 EOL 版本会持续变化。因此稳定产品文档不应写死“安装 Node X”；每个 cfKanban Skill release 应根据当时的 Wrangler 与验证矩阵声明机器可读 semver range，并优先接受用户现有的兼容版本。

Wrangler 的交互式登录默认使用 OAuth 浏览器流程；远程、容器或无本地 callback 场景可以使用 device authorization。非交互 CI 使用 API token。Wrangler 还提供 `--use-keyring`：macOS 使用 Keychain，Linux 使用 libsecret，Windows 使用 Credential Manager；这只保存 Cloudflare 登录凭据，不自动解决 cfKanban Owner Credential 的本地保存。

来源：

- [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Wrangler general commands and authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)

## 对 cfKanban 的当前含义

1. Portable Skill 只依赖 Agent Skills 的共同最小格式，不依赖实验 `allowed-tools` 或某个宿主的隐式授权语义。
2. Codex、Claude Code 和未来 Agent 的路径、更新与宿主提示差异由 bootstrap 安装规则和 Skill bundle 内兼容脚本处理，不复制部署和领域逻辑，也不建模为独立 Host Adapter 角色。
3. v0 不发布独立 cfKanban CLI。部署、迁移、凭据调用与业务 API 重试等确定性行为由 Skill bundle 内少量共享 Node scripts 完成；Skill 说明能力、参数、结果和恢复。只有部署、迁移、凭据与恢复等产品安全协议会规定必要的 preflight/授权门槛；日常 Issue 调用时机与组合由上层 Agent 决定。
4. Node.js/TypeScript 已选为内置 scripts 的统一语言，因为 Wrangler 已要求 Node.js 且覆盖目标三大桌面系统；Bash/PowerShell 不承载核心逻辑。
5. “支持 macOS/Windows/Linux”必须通过实际矩阵验证，而不是仅凭使用跨平台语言宣称。
6. cfKanban Credential 必须有独立的跨平台本地存储合同，不能直接复用或读取 Wrangler 的 Cloudflare token。产品随后确认 v0 使用用户 home 下依赖 ownership/ACL 保护的受限文件，不依赖 OS secure store。
7. Node 是用户拥有的开发环境：Skill 只探测兼容性和引导选择，不替用户决定 version manager、安装路径或全局默认版本。
8. Cloudflare 的“项目本地 Wrangler”解决的是版本固定与回滚。cfKanban 已确认采用以下适配：兼容的用户现有 Wrangler 可以复用；否则使用独立于 Agent 宿主和任意工作 Repo 的用户级 cfKanban Tool Runtime。后者是 cfKanban 的产品设计推论，不是 Cloudflare 官方定义。
