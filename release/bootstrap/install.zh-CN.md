# cfKanban 安装引导（面向 Agent）

语言：[English](install.md) | [简体中文](install.zh-CN.md)

本引导直接面向接收 cfKanban 安装或部署任务的 Agent。从用户已给出的意图继续，不要要求用户再向另一个 Agent 转述提示词。先把这份 HTTPS 文档作为只读文本检查，不当作脚本执行，也不通过管道送进 shell。读取本文不构成本地或云端写入授权。

先检查已有 Skills，复用兼容且经过验证的安装。只询问缺失的选择或必要授权。把用户要求的结果转换成以下流程，不要求用户提供 manifest、digest、preflight、plan 或 journal 等术语：

1. 只把提供的 release pointer 用于发现：通常是 `stable.json`；只有用户明确选择测试版时才可使用 `prerelease.json`。随后解析 immutable manifest URL 和 SHA-256。
2. 验证 canonical publisher、每个工件允许的 HTTPS origin，以及准确的 Skill/Service deployment bundle SHA-256。
3. 在任何本地写入前展示 Skill 安装/更新来源、版本、目标、本地 scope 和回滚边界，并取得授权。
4. 把已验证的版本化 release 保存在当前执行环境用户私有的 `~/.cfkanban/skill-releases/`，再仅创建宿主发现所必需的宿主所有 Skill/plugin 投影。
5. 阅读每个已安装的 `SKILL.md`，分别在三个 Skill 目录运行 `node scripts/cfkanban-tool.mjs help`，完成无副作用的命令发现验证。检查宿主的 Skill 发现状态；如果确实需要新任务加载，说明具体接续操作，不能声称 Skill 已加载。
6. 如需部署，先执行只读检查：有 journal/receipt 时复用其中的准确 Wrangler 目标，否则让 Wrangler 使用环境认证并解析当前私有部署/config 上下文，不列出 profiles。只有用户明确给出 named profile 时才检查那一个。随后在私有配置中固定所选 `account_id`，用普通语言解释将创建的 Cloudflare 资源，并在规定的授权边界等待确认。

marketplace/plugin 只是便捷入口。宿主 marketplace metadata 与 plugin caches 继续留在宿主管理目录，它们只是已验证投影，不是 cfKanban 状态；不能替代 immutable manifest，也不授权 Skill update、Cloudflare 部署、D1 migration、DNS、secret 或恢复操作。
