# 代理集成

把当前 Agent 宿主接入已有 cfKanban 实例。本章说明 Skills、本地 MCP 和宿主插件的安装与更新、身份和项目选择，以及任务视图的打开方式。使用别人的看板不需要 Cloudflare 账户。

| 宿主或目标 | 阅读 |
| --- | --- |
| 在支持 Skills 发现的宿主使用四个技能 | [通用](./general.md) |
| 配置本地 stdio MCP 或打开本地工作台 | [通用：MCP 与工作台](./general.md#本地-mcp-与工作台) |
| 在 DeepSeek Harness 桌面或 Web 安装插件 | [DeepSeek Harness](./deepseek-harness.md) |
| 创建、升级或恢复 Cloudflare 实例本身 | [部署](../deployment/index.md) |

Skills 提供使用指导、加入、恢复、管理与部署流程；本地 MCP 为日常任务操作提供有界工具。DeepSeek Harness 提供专用安装适配和可选任务侧栏，复用相同本地 runtime 与 Vue 任务视图。安装接入本身不授予应用或 Cloudflare 权限。

## 从宿主和实例开始

```text
请检查当前 Agent 宿主支持哪种 cfKanban 接入，以及已有安装是否兼容 <实例地址>。
先只读核对，说明下一步需要安装还是连接身份。
```

已有可信且兼容的安装可以复用。尚未加入时阅读[加入与登录](../usage/access.md)；Owner 为新电脑接入身份时阅读[Owner 设备](../administration/devices.md)。开始工作前核对实际身份和明确项目范围；日常任务操作继续阅读[使用](../usage/index.md)。

## 发行可用性

默认选择已公开正式版 Skills；历史版和测试版需要明确目标。MCP、本地工作台与 DSH 插件要求所选发行的已校验 Skill bundle 包含对应工件。旧正式版可能没有这些工件；源码候选和本地测试包不代表它们已经正式发行。缺少工件或无法校验时，应停止安装并说明限制。

在浏览器中仍可使用已有权限访问实例 Web UI。安装或更新宿主接入与[升级实例](../deployment/updates.md)是独立动作。

## 本地与线上 Web UI

两种视图读写同一可信线上实例，权限、CAS 与业务历史相同。本地视图不是离线副本。

| 视图 | 入口与范围 | 适用工作 |
| --- | --- | --- |
| 本地工作台 | `web open` 默认以本地模式打开项目或 Issue，由匹配本地进程提供自包含 Vue 视图。 | 项目切换、看板/列表、行内优先级/状态/负责人、任务详情、评论、完成，以及复制编号、链接和原始 Markdown。 |
| DSH 侧栏 | DSH Host 通过嵌入文档与消息通道承载相同 Vue 视图，浏览器无需访问另外的 localhost 网页。 | 在聊天旁处理同样的日常任务，使用 Session 已核验工作目录的范围。 |
| 线上完整版 Web UI | 明确线上模式，或本地视图的「打开完整线上看板」，通过现有临时 Browser Launch 打开已核验目标。 | 完整看板、账户、项目/工作区管理、成员、权限和权限内的设置；云端部署仍使用[部署流程](../deployment/index.md)。 |

本地资源依赖已安装 runtime 与所属进程，更新后需要重启；缺少工件或启动失败时明确报告，不静默切到线上。本地打开见[通用](./general.md#本地-mcp-与工作台)，侧栏见 [DeepSeek Harness](./deepseek-harness.md)。
