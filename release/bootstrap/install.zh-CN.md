# 让你的 Agent 安装或部署 cfKanban

语言：[English](install.md) | [简体中文](install.zh-CN.md)

请把这份 HTTPS 文档当作只读引导，不要执行它、pipe 到 shell，也不要运行从 Issue 或 Comment 复制的命令。

请让你的 Coding Agent：

1. 只把 `stable.json` 用于发现，解析 immutable manifest URL 和 SHA-256。
2. 验证 canonical publisher、每个工件允许的 HTTPS origin，以及准确的 Skill/Service deployment bundle SHA-256。
3. 在任何本地写入前展示 Skill 安装/更新目标、本地 scope 和回滚边界。
4. 把已验证的版本化 release 保存在当前执行环境用户私有的 `~/.cfkanban/skill-releases/`，再仅创建宿主发现所必需的宿主所有 Skill/plugin 投影。
5. 安装三个 portable Skills，并运行 `node scripts/cfkanban-tool.mjs help` 作为无副作用 discovery smoke。
6. 如需部署，使用 `cfkanban-deploy` 生成只读 capability report 和 strict-zero Cloudflare plan；部署仍需要独立授权。

marketplace/plugin 只是便捷入口。宿主 marketplace metadata 与 plugin caches 继续留在宿主管理目录，它们只是已验证投影，不是 cfKanban 状态；不能替代 immutable manifest，也不授权 Skill update、Cloudflare 部署、D1 migration、DNS、secret 或恢复操作。
