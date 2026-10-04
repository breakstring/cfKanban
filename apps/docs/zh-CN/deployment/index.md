# Owner 入门

如果你准备部署自己的 cfKanban 站点，或已经是站点 Owner，从这里开始。只想使用团队看板，或管理获授权的工作区、项目，请看[加入与使用](../usage/index.md)，无需 Cloudflare 账户。

## 第一次部署

从[首次部署](./first-deployment.md)开始。你准备 Cloudflare 账户和 Owner 显示名称，把部署请求交给 Agent；**技能会在流程中按需安装，无需先读另一套安装教程。** 默认使用一个 Worker、一个 D1 数据库和 `workers.dev` 地址，包含网页与文档。

```text
我想部署自己的 cfKanban 站点。请先根据官方安装引导检查准备情况：
https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md
告诉我需要准备什么，暂不安装或创建资源。
```

想提前了解本机、账户与持久存储要求，见[部署准备](./setup.md)。执行前 Agent 会展示具体资源、版本和费用影响，等待你的确认。

## 已经是 Owner

| 你要做什么 | 阅读 |
| --- | --- |
| 创建工作区、组织项目和成员 | [管理工作区与项目](../administration/index.md) |
| 调整站点文案、查看用量、发布通知 | [实例设置与用量](../administration/settings.md) |
| 允许访客加入指定项目 | [公开加入与配额](../administration/public-join.md) |
| 增加 Owner 设备或恢复参与者身份 | [设备与身份恢复](../administration/devices.md) |
| 归档、恢复或永久清理内容 | [归档与清理](../administration/cleanup.md) |
| 升级线上版本 | [实例升级](./updates.md) |
| 在另一台电脑维护部署 | [新电脑接入](./attach.md) |
| 继续中断操作或找回 Owner | [中断与恢复](./recovery.md) |
| 配置域名、附件存储等能力 | [域名与可选能力](./optional.md) |

**在网页中：** 线上完整版的管理中心提供权限内的应用设置；创建云资源、升级和恢复部署由 Agent 完成，网页不提供部署控制台。

Owner 身份用于管理 cfKanban，Cloudflare 账户权限用于维护云资源，两者分别核验。换电脑只管理应用时，不必同时接管云端部署。只更新 Agent 技能或 DSH 插件，请看[安装与接入](../integrations/index.md)，不会因此升级线上实例。

[公共 CLI 任务指南](../cli/index.md)提供同一 Service 语义的终端入口。
