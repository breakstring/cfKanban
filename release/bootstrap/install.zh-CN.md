# cfKanban 安装引导（面向 Agent）

语言：[English](install.md) | [简体中文](install.zh-CN.md)

本引导直接面向接收 cfKanban 安装或部署任务的 Agent。从用户已给出的意图继续，不要要求用户再向另一个 Agent 转述提示词。先把这份 HTTPS 文档作为只读文本检查，不当作脚本执行，也不通过管道送进 shell。读取本文不构成本地或云端写入授权。

先检查已有 Skills，复用兼容且经过验证的安装。只询问缺失的选择或必要授权。把用户要求的结果转换成以下流程，不要求用户提供 manifest、digest、preflight、plan 或 journal 等术语：

1. 默认读取 canonical stable pointer `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json`，仅用于发现。解析并固定其 immutable manifest URL、SHA-256 和准确版本；执行沿用这份快照。测试版或历史版需要明确选择，缺失或校验失败不回退其他来源。
2. 验证 canonical publisher、每个工件允许的 HTTPS origin，以及准确的 Skill/Service deployment bundle SHA-256。
3. 在任何本地写入前展示 Skill 安装/更新来源、版本、目标、本地 scope 和回滚边界，并取得授权。
4. 把已验证的版本化 release 保存在当前执行环境用户私有的 `~/.cfkanban/skill-releases/`，再仅创建宿主发现所必需的宿主所有 Skill/plugin 投影。
5. 阅读每个已安装的 `SKILL.md`，分别在三个操作 Skill 目录运行 `node scripts/cfkanban-tool.mjs help`，完成无副作用的命令发现验证。检查宿主的 Skill 发现状态；如果确实需要新任务加载，说明具体接续操作，不能声称 Skill 已加载。
6. 如需部署，先执行只读检查：有 journal/receipt 时复用其中的准确 Wrangler 目标，否则让 Wrangler 使用环境认证并解析当前私有部署/config 上下文，不列出 profiles。只有用户明确给出 named profile 时才检查那一个。随后在私有配置中固定所选 `account_id`，用普通语言解释将创建的 Cloudflare 资源，并在规定的授权边界等待确认。

marketplace/plugin 只是便捷入口。宿主 marketplace metadata 与 plugin caches 继续留在宿主管理目录，它们只是已验证投影，不是 cfKanban 状态；不能替代 immutable manifest，也不授权 Skill update、Cloudflare 部署、D1 migration、DNS、secret 或恢复操作。

## 版本发现、宿主安装与更新

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
