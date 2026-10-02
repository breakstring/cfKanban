# 部署准备

托管或维护自己的 cfKanban 实例，需要 Cloudflare 权限与持久私有维护记录。把 Agent 接入已有看板的步骤放在[代理集成](../integrations/index.md)。

## 检查准备情况

```text
请用 $cfkanban-deploy 检查这台电脑能否部署 cfKanban，先不要修改。
说明还需要哪些工具、登录和本地存储准备。
```

Agent 核对所选发行、工具、执行环境与存储，尽量复用兼容工具；需要安装或修改环境时先说明影响。若使用容器、远端或临时环境，确认退出后仍能保留私有身份和维护记录；Windows 原生与 WSL 需要分别准备。

## 安装技能

按[通用安装](../integrations/general.md#安装技能)安装完整四 Skill bundle 并核验 `cfkanban-deploy` 入口；使用 DSH 时阅读 [DeepSeek Harness 插件](../integrations/deepseek-harness.md)。本地安装和更新不需要 Cloudflare 账户，也不创建或升级实例。

## 登录 Cloudflare

```text
请用 $cfkanban-deploy 检查当前 Cloudflare 登录和目标账户。
需要新登录或额外权限时先说明，再由我确认。
```

**在浏览器中：** 在 Cloudflare 官方页面核对账户和权限，再完成登录。多个账户时选准部署目标，不把 Cloudflare Token 或 cfKanban 凭据粘贴到聊天。

cfKanban Owner 身份与 Cloudflare 权限分别核验。登录不会立即创建资源；下一步是[首次部署](./first-deployment.md)。

如果只是使用别人的看板，请阅读[加入与登录](../usage/access.md)。
