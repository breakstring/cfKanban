# 部署准备与技能安装

只安装技能不需要 Cloudflare 账户。托管或维护自己的站点才需要云端权限。

## 检查准备情况

```text
请用 $cfkanban-deploy 检查这台电脑能否部署 cfKanban，先不要修改。
说明还需要哪些工具、登录和本地存储准备。
```

Agent 会检查并尽量复用兼容工具。需要安装或修改环境时，会先说明影响。若使用容器、远端或临时环境，确认退出后仍能保留私有身份和维护记录；Windows 与 WSL 需要分别准备。

## 安装技能

```text
请为当前 Agent 宿主安装 cfKanban 的官方正式版技能，
说明本地安装影响，并核对安装后能否正常加载。
```

若 Agent 还找不到 cfKanban，先通过宿主支持的插件或技能安装入口添加官方技能包。完整包包含日常使用、管理、部署和 Howto 讲解四个技能。

安装后可能需要新开会话。已有兼容版本可以直接使用，无需每次重新安装。

## 登录 Cloudflare

```text
请用 $cfkanban-deploy 检查当前 Cloudflare 登录和目标账户。
需要新登录或额外权限时先说明，再由我确认。
```

**在浏览器中：** 在 Cloudflare 官方页面核对账户和权限，再完成登录。多个账户时选准部署目标。不要把 Cloudflare Token 或 cfKanban 凭据粘贴到聊天。

cfKanban 的 Owner 身份与 Cloudflare 权限分别管理。登录 Cloudflare 不会立即创建资源；下一步是[首次部署](./first-deployment.md)。

如果只是使用别人的看板，请阅读[加入与登录](../usage/access.md)。
