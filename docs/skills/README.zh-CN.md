# cfKanban Agent Skills

语言：[English](README.md) | [简体中文](README.zh-CN.md)

cfKanban 交付三个 portable Skills：

- `cfkanban`：日常身份、scope、Issue 协作、Invite/Public Join 和 Project/Issue Web launch。
- `cfkanban-admin`：Deployment Owner 应用管理。
- `cfkanban-deploy`：canonical release 校验、本地 Skill 生命周期、Cloudflare 部署、续做、migration 与升级安全。

每个 `SKILL.md` 都先说明“能做什么”、何时应使用另一个 Skill、任务到命令对照、必须遵循的流程与停止条件；配对的 English/简体中文 reference 再提供详细 endpoint 和恢复说明。

## 每个 Skill 内置的命令

在任意 Skill 目录运行下面的命令，即可查看该 Skill 的准确命令边界：

```text
node scripts/cfkanban-tool.mjs help
```

结果是结构化 JSON，列出每个 command 的名称、effect 与输入字段。其他命令通过 stdin 接收结构化 JSON，因此 secret 无需出现在进程参数中。Credential 从来不是输入字段；普通认证请求、Invite/Public Join 兑换和 Owner 轮换都在内部从私有文件读取正确的 current 或 pending secret。

`.mjs` 表示使用 Node 显式 ES module 格式的普通 JavaScript。这些文件可直接由 `node` 运行、无需编译，并且 portable Skill 安装到没有 `package.json` 的目录时仍不会产生模块语义歧义。

## Marketplace 与 plugin 安装

仓库根目录是一个 Codex plugin，`.agents/plugins/marketplace.json` 提供具名的本地 marketplace entry。开发或验证时，可以注册并安装源码 checkout：

```text
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

Codex 和其他 Agent 宿主会把可发现 Skills/plugins 放在宿主自己管理的位置。这些文件是用于宿主发现的已验证投影，不是 cfKanban 的持久状态或 canonical release 真相源；删除一个投影只会影响该宿主的能力发现。

marketplace/plugin 只是便利入口，不能覆盖 canonical HTTPS publisher、immutable release manifest、artifact-origin allowlist、SHA-256 digests 或 installed receipt。本地源码 checkout 不是 canonical stable release。安装、更新、降级、部署和 Instance upgrade 始终是彼此独立的计划动作，不会因为 marketplace entry 存在而自动执行。

### 可选 Cloudflare 协作 Skill

Cloudflare 自己维护的 [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) 与 [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) Skills 可作为当前平台事实和 Wrangler 语法的可选参考。它们不是 `cfkanban-deploy` 的依赖，不会自动安装，也不能替代 release 校验、准确 Wrangler 兼容范围、Frozen plan、journal、migration readback 或授权。用户明确要求时，才把它们作为独立的宿主变更，按[上游安装说明](https://github.com/cloudflare/skills#installing)先展示 source/revision、scope、目标和回滚方式。

## 统一的 cfKanban 数据根目录

cfKanban 自己拥有的所有持久文件统一放在当前执行环境用户的一个私有维护根目录：

```text
~/.cfkanban/
  instances/
  skill-releases/
  tool-runtime/
```

- `instances/` 保存 trusted instance metadata、Credentials、journals 与脱敏 receipts。
- `skill-releases/` 保存已验证 immutable Skill versions 和 atomic active pointer。
- `tool-runtime/` 只在没有兼容的用户自有 Wrangler、且准确安装计划已获授权时，保存隔离的兼容 Wrangler。

宿主 marketplace/plugin metadata、宿主 Skill 投影、plugin caches 与 Cloudflare authentication 继续保存在各自所有者的目录；对应宿主/工具必须在那里发现并管理它们，因此不能迁入 `.cfkanban/`。Windows 原生与 WSL2 使用不同 user homes，绝不自动共享这些目录。

统一根目录不会削弱 secret 边界：Credential 文件继续执行最小 ownership/ACL 检查，禁止宽泛递归清理，任何 cfKanban 状态都不能进入 Repo、同步目录或临时目录。

## 国际化规则

只接受一个字符串的 metadata schema——`SKILL.md` frontmatter、`agents/openai.yaml`、`.codex-plugin/plugin.json` 与 marketplace metadata——统一使用英文。支持 locale-specific files 的文档同时维护 English 与简体中文，并在顶部提供语言链接。

## 共享 runtime

三个 Skills 都路由到 `packages/skill-runtime` 中同一套无第三方依赖 Node modules。这样路径校验、trusted-origin 处理、secret 注入、错误归一化、release 验证、plan digest 与 migration readback 保持一致，同时不发布独立 cfKanban CLI，也不把 Service 的业务规则复制到本地。
