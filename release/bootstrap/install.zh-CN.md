# cfKanban 安装引导（面向 Agent）

语言：[English](install.md) | [简体中文](install.zh-CN.md)

本引导直接面向接收 cfKanban 安装或部署任务的 Agent。从用户已给出的意图继续，不要要求用户再向另一个 Agent 转述提示词。先把这份 HTTPS 文档作为只读文本检查，不当作脚本执行，也不通过管道送进 shell。读取本文不构成本地或云端写入授权。

先检查已有 Skills，复用兼容且经过验证的安装。只询问缺失的选择或必要授权。把用户要求的结果转换成以下流程，不要求用户提供 manifest、digest、preflight、plan 或 journal 等术语：

1. 默认读取 canonical stable pointer `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json`，仅用于发现。解析并固定其 immutable manifest URL、SHA-256 和准确版本；执行沿用快照，不因此固定宿主的长期更新来源。测试版或历史版需要准确选择，缺失或校验失败不回退其他来源。
2. 验证 canonical publisher、每个工件允许的 HTTPS origin，以及准确的 Skill/Service deployment bundle SHA-256。
3. 在任何本地写入前展示 Skill 安装/更新来源、版本、目标、本地 scope 和回滚边界，并取得授权。
4. 把已验证的版本化 release 保存在当前执行环境用户私有的 `~/.cfkanban/skill-releases/`，再仅创建宿主发现所必需的宿主所有 Skill/plugin 投影。
5. 阅读每个已安装的 `SKILL.md`，分别在三个操作 Skill 目录运行 `node scripts/cfkanban-tool.mjs help`，完成无副作用的命令发现验证。检查宿主的 Skill 发现状态；如果确实需要新任务加载，说明具体接续操作，不能声称 Skill 已加载。
6. 如需部署，先执行只读检查：有 journal/receipt 时复用其中的准确 Wrangler 目标，否则让 Wrangler 使用环境认证并解析当前私有部署/config 上下文，不列出 profiles。只有用户明确给出 named profile 时才检查那一个。随后在私有配置中固定所选 `account_id`，用普通语言解释将创建的 Cloudflare 资源，并在规定的授权边界等待确认。

marketplace/plugin 只是便捷入口。宿主 marketplace metadata 与 plugin caches 继续留在宿主管理目录，它们只是已验证投影，不是 cfKanban 状态；不能替代 immutable manifest，也不授权 Skill update、Cloudflare 部署、D1 migration、DNS、secret 或恢复操作。

## 版本发现、宿主安装与更新

`schema_version: 2` 的发行清单将产品/OpenAPI 文档版本与 API 兼容版本分开，要求部署技能支持该格式；新技能仍可读取历史格式 1。旧技能拒绝清单时，先核对 canonical 安装文档，在获准后更新本地技能及宿主投影，再部署 Service bundle。不能绕过清单校验，也不能把文档版本当成 API 版本。发行 pointer 仍使用 schema 1。

首次安装默认发现最新正式发行；已有可信且兼容的安装应优先复用。读取 canonical stable pointer：

<https://github.com/breakstring/cfKanban/releases/latest/download/stable.json>

文字插件/技能更新请求先使用用户明确指定的目标，其次使用可信用户会话上下文中明确承接的准确目标：刚发布准确 RC 且本次意在验收它时可以承接。泛泛提过 RC 或开发分支不够。目标有歧义时询问一次，否则选择最新正式版。宿主原生插件/技能更新使用 stable 渠道；此上下文规则不把首次部署静默指向 RC。

解析并固定不可变 manifest URL、SHA-256 和准确版本，验证 publisher、工件允许来源及所需 bundle 摘要。后续沿用快照，但与宿主已保存的更新来源分别处理。缺失或校验失败时停止，不回退测试版、本地 cache 或开发源码。可信 deploy Skill 支持 `release discover` 时，以 `{}` 或 `{"selectionMode":"latest_stable"}` 只读发现正式目标，再用 `release verify` 校验工件字节。沿用返回的 `selection_mode`；在该模式回填已解析正式版 `version` 仍保持 `marketplace.ref: null`，并拒绝 RC。明确准确版本选择（当前正式版、历史版或 RC）必须使用 `{"selectionMode":"exact_version","version":"<目标>"}`。旧 Skill 不支持这些输入时，按 HTTPS 文档流程检查并独立保留选择意图，不为了检查而先更新技能。

需要安装时，先识别当前 Agent 宿主及其支持的 Skill 安装和发现方式。把来源、准确版本、用户级 scope、本地路径和回退写入计划；使用 Git 时同时记录来源 commit。所有宿主都须保留完整已验证 Skill bundle：四个 Skills、共享 `packages/skill-runtime` 和相对目录，不能只复制某个 Skill 目录。

- 支持兼容 Git marketplace 或 plugin 来源的宿主，可以跟随仓库默认 `main` 分支；该分支只承载已公开正式发行。安装前核对 commit 与本次固定正式目标的已发布 tag 一致，且安装文件与已验证 Skill bundle 匹配。
- 通过本地 Skill 目录加载的宿主，使用完整已验证 bundle，按该宿主支持的目录布局建立发现入口，保留共享 runtime 和相对路径。宿主无法支持该布局时，说明具体限制。

**仅对于支持 plugin 的 Codex**，全新安装跟随默认分支的命令示例如下，获得相应授权后执行；其他宿主使用各自支持的安装方式：

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git
codex plugin add cfkanban-agent-skills@cfkanban
```

所有宿主在安装或更新后，都须用同一固定目标核对实际副本，并分别读回保存的来源/ref；仅版本字符串相同不足以证明已验证。`latest_stable` 不得留下意外 tag pin：固定 manifest/version/digest 不添加 `--ref`。Git 路径中，若 `main` 暂时落后 Latest 或操作期间来源变化，停止并说明；任何副本与已验证 bundle 不一致时也须停止。不静默改用 tag、RC 或开发 checkout。`exact_version` 使用已验证准确 tag/bundle，仅在 Codex 支持的安装方式确有需要时使用 `--ref <resolved-version>`。

RC 验收临时切换现有宿主入口/投影，先记录旧来源/ref 和恢复方式，不另建插件入口或自动迁移脚本。长期来源保留或恢复默认 stable，分别核对已安装 RC 和保存的更新来源。宿主无法在恢复来源后保留 RC 安装时，说明限制及后续原生 stable 更新前的切回要求，不声称任意 tag pin 会自动更新到 stable。

固定 tag 的 Git 来源安装，必须先切换来源，原生更新才能跟随 stable。先检查已保存的来源/ref（Codex 中是 `cfkanban` marketplace）；只从复制的命令中删除 `--ref` 不会修改旧设置，刷新固定 tag 也不会升级到正式版。展示来源切换和回退，在用户授权内按宿主支持方式操作；复用已覆盖本次更新的授权，不重复确认。保留私有 `.cfkanban/` 身份和部署记录。本地目录安装继续使用已验证 bundle 更新流程。跟随 `main` 后，后续宿主更新能够取得新正式版，但不会自动刷新已安装技能或当前任务。

分别核对 canonical active receipt、宿主 plugin/Skill 投影和当前任务实际加载状态。更新 canonical bundle 不等于更新宿主，宿主已安装也不等于当前任务已加载。需要新任务时说明具体接续操作和剩余步骤；无法验证时明确标为未验证。

检查更新与执行更新分开；本地技能更新与云端实例升级独立。若最新 Skills 与目标旧实例不兼容，复用已验证兼容安装，或说明限制并提出明确的兼容历史正式版方案；不得为了加入或更新技能强制升级服务器。
