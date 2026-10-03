# 首次部署

在自己的 Cloudflare 账户中建立 cfKanban 站点。加入已有项目无需部署。

## 交给 Agent

```text
请阅读官方安装引导，为我准备所需技能并部署 cfKanban，使用最新正式版和默认基础配置：
https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md
Owner 显示名称为 <你的名称>。先检查准备情况，展示资源、费用和访问权限影响，等我确认后执行。
```

也可以使用 cfKanban 站点首页生成的部署提示词。两种入口都包含技能准备：复用已有兼容安装，缺少时由 Agent 按引导安装，无需你先单独操作。

需要支持 Skills 的 Agent、能持久保存私有数据的环境，以及 Cloudflare 账户控制权限。缺少工具或登录时，Agent 会说明下一步；前提见[部署准备](./setup.md)。

## 确认部署计划

默认配置使用一个 Cloudflare Worker、一个 D1 数据库和 `workers.dev` 地址，包含网页与文档。附件存储、自定义域名等需要另行选择。

执行前核对：

- 使用哪个 Cloudflare 账户、版本和资源名称。
- Owner 名称及部署后的访问地址。
- 需要安装什么，以及可能产生的费用或新增权限。

默认基础配置不代表费用担保，实际额度和费用以你的 Cloudflare 账户为准。已有实例应走[接入已有部署](./attach.md)，不要重复初始化。

## 部署完成后

Agent 会提供站点地址，并核对站点可用性和你的 Owner 身份。凭据安全保存在本机，不需要粘贴到聊天中。中断时保留维护记录，使用[中断与恢复](./recovery.md)。

接着创建第一个看板：

```text
请用 $cfkanban-admin 在 Product 工作区创建 DemoProject 项目；
如果工作区不存在，请先创建它。完成后打开我的第一个看板。
```

然后可以[创建任务](../usage/issues.md)或[邀请成员](../administration/members.md)。Cloudflare 登录可能需要浏览器配合；cfKanban 网页本身不提供部署按钮。
