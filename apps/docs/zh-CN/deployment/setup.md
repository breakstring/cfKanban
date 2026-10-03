# 部署准备

你需要准备 Cloudflare 账户、Owner 显示名称，以及能够保留私有身份和维护记录的 Agent 环境。技能、兼容工具和登录状态由 Agent 在部署流程中检查，不要求你先独立安装一遍。

## 先检查，再决定

```text
请阅读 cfKanban 官方安装引导，检查这台电脑是否适合部署：
https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md
先只读检查，列出缺少的工具、登录或存储条件，不安装、不创建资源。
```

Agent 会尽量复用现有兼容技能和工具。真正开始[首次部署](./first-deployment.md)时，缺少的技能可一并准备；需要安装工具或修改环境时，会先说明影响。只有你想提前准备宿主，才需要阅读[安装与接入](../integrations/index.md)。

## 你需要确认的三件事

1. **使用哪个 Cloudflare 账户。** 多账户时明确目标；需要登录时，在浏览器的 Cloudflare 官方页面完成。不要把 Token 粘贴到聊天。
2. **Owner 显示名称。** 这是新实例中的身份名称；完成部署后由你管理站点。
3. **本地记录是否能保留。** 选择日后还可以访问的私有存储。临时容器、远程环境和 WSL 与本机不是同一个环境，需要分别核对。

登录 Cloudflare 不会立即创建资源。Agent 展示部署计划后，再由你确认资源、费用与权限影响。已有实例应走[接入已有部署](./attach.md)，避免重复初始化。

如果只是使用别人的项目，直接[加入与登录](../usage/access.md)，无需准备 Cloudflare。
