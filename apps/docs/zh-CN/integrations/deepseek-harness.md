# DeepSeek Harness

在 DeepSeek Harness 中，主要通过 **cfKanban 技能与 Agent 协作**：查询任务、更新进度、添加评论和记录完成。集成插件还提供聊天旁的侧栏，方便你同时浏览和操作看板，作为会话协作的增强体验。

本页适用于本机运行的 DSH 桌面版和 Web 版；当前兼容基线是 DSH `0.2.0-rc.2`。

## 安装与接入

```text
请阅读 cfKanban 官方安装引导：
https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md
为这台电脑的 DeepSeek Harness 桌面版安装 cfKanban。
请使用包含 DSH 插件的兼容发行，保留已有身份和其他插件，完成后核对可用性。
不要部署或升级线上实例。
```

使用 Web 版时，把提示词中的“桌面版”改为“Web 版”。两者的插件安装位置独立；装好其中一个，不代表另一个也已安装。安装测试版时，在请求中写明准确版本。

Agent 会安装官方插件，其中已包含 cfKanban 技能与侧栏，无需分别安装或手动配置连接。需要你在 Plugins 页面启用或重新打开 DSH 时，会给出具体提示。首次使用继续[加入与登录](../usage/access.md)，获得项目访问权限后即可开始协作。

想手动安装时，可以先让 Agent 准备经过校验的本地 `.tgz` 插件文件，再在 **Plugins → Add plugin** 中填入文件路径，点击 **Install → Enable now**，按提示重启。cfKanban 源码仓库地址和 Skills ZIP 地址目前不能直接填入这个安装入口。

## 通过技能与 Agent 协作

安装后，像在其他 Agent 中一样，直接说明你要做的事：

```text
请查看当前项目中分配给我的未完成任务，按优先级列出。
```

也可以让 Agent 创建任务、修改优先级或负责人、添加评论、记录完成情况。使用方法见[任务与看板](../usage/issues.md)；[通用 Agent 指南](./general.md)中的日常用法同样适用。经常在同一目录工作时，可以[关联项目](../usage/profile.md)，减少重复选择。

## 用侧栏增强浏览体验

想边聊边看任务时，让 Agent 打开侧栏：

```text
在侧边栏打开 CFK-123。
```

也可以指定项目。启用兼容插件后，Agent 会打开对应看板或任务详情；侧栏不可用时会说明当前限制。

[![DeepSeek Harness 左侧显示会话，右侧 cfKanban 侧栏显示 CFK-600 详情](../../assets/integrations/dsh-sidebar.png)](../../assets/integrations/dsh-sidebar.png)

*侧栏让你在会话旁查看任务和看板。图为桌面版布局，点击可查看原图。*

也可以在 DSH 中打开工作目录，点击聊天面板旁的 **cfKanban logo** 按钮。有项目关联时会打开匹配项目；有多个目标或没有关联时，按提示选择。

在侧栏中切换项目，使用「看板」或「列表」浏览任务，点击任务查看详情。有相应权限时，也能修改任务、添加评论和记录完成情况。「打开完整线上看板」可进入线上网页；账户和管理功能见[打开看板](./webui.md)。

DSH Web 版也支持侧栏。插件使用 DSH 所在电脑的身份；目前侧栏适用于本机单用户使用，远程或多人共享的 DSH 服务尚不支持。

写入结果不确定时，先在原视图使用**恢复**，再关闭侧栏或重启 DSH。

## 更新或遇到问题

```text
请将当前 DSH 中的 cfKanban 插件更新到兼容的最新正式版。
保留身份和其他插件，检查接入是否可用，告诉我哪些应用或会话需要重启。
```

本地更新与[线上实例升级](../deployment/updates.md)分别进行。技能或侧栏没有出现时，先检查是否安装到当前使用的桌面版或 Web 版、是否启用，以及是否需要重启；看不到项目时，检查[加入状态与权限](../usage/access.md)。
