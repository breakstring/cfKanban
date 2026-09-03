# 让你的 Agent 安装或部署 cfKanban

语言：[English](install.md) | [简体中文](install.zh-CN.md)

请把这份 HTTPS 文档作为只读引导交给 Coding Agent，不要执行它，也不要把它直接传给 shell。

然后只需要说：

> 请使用 `$cfkanban-deploy` 为我安装或部署一套 cfKanban。

这一句话就够了。用户不需要理解或主动要求 manifest、digest、preflight、deployment plan 或 journal；Skill 必须把请求转换为下面的内部流程：

1. 只把提供的 release pointer 用于发现：通常是 `stable.json`；只有用户明确选择测试版时才可使用 `prerelease.json`。随后解析 immutable manifest URL 和 SHA-256。
2. 验证 canonical publisher、每个工件允许的 HTTPS origin，以及准确的 Skill/Service deployment bundle SHA-256。
3. 在任何本地写入前展示 Skill 安装/更新目标、本地 scope 和回滚边界。
4. 把已验证的版本化 release 保存在当前执行环境用户私有的 `~/.cfkanban/skill-releases/`，再仅创建宿主发现所必需的宿主所有 Skill/plugin 投影。
5. 安装三个 portable Skills，并运行 `node scripts/cfkanban-tool.mjs help` 作为无副作用 discovery smoke。
6. 如需部署，先执行只读检查：有 journal/receipt 时复用其中的准确 Wrangler 目标，否则让 Wrangler 使用环境认证并解析当前私有部署/config 上下文，不列出 profiles。只有用户明确给出 named profile 时才检查那一个。随后在私有配置中固定所选 `account_id`，用普通语言解释将创建的 Cloudflare 资源，并在规定的授权边界等待确认。

marketplace/plugin 只是便捷入口。宿主 marketplace metadata 与 plugin caches 继续留在宿主管理目录，它们只是已验证投影，不是 cfKanban 状态；不能替代 immutable manifest，也不授权 Skill update、Cloudflare 部署、D1 migration、DNS、secret 或恢复操作。
