# DeepSeek Harness

DSH 插件把 cfKanban 放在聊天旁边：让 Agent 打开任务后，就能一边讨论，一边查看详情或操作看板。插件一次接入技能、MCP 和任务侧栏，**装好后不需要再单独安装技能或配置 MCP。** 本页适用于本机运行的 DSH 桌面版和 Web 版；当前兼容基线是 DSH `0.2.0-rc.2`。

## 安装：交给当前 Agent

```text
请阅读 cfKanban 官方安装引导：
https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md
为这台电脑的 DeepSeek Harness 桌面版安装 cfKanban 插件。
请使用包含 DSH 插件的兼容发行，保留已有身份和其他插件，完成后核对可用性。
不要部署或升级线上实例。
```

使用 Web 版时，把提示词中的“桌面版”改为“Web 版”。两者的插件安装位置独立；装好其中一个，不代表另一个也已安装。安装测试版时，在请求中写明准确版本。

Agent 会准备官方发行中的插件包，并安装到你指定的 DSH。需要你在 Plugins 页面启用或重新打开 DSH 时，会给出具体提示。安装后还没有 cfKanban 身份的用户，继续[加入与登录](../usage/access.md)；安装插件不等于加入项目。

## 能直接在 DSH 中填仓库地址安装吗？

**DSH 支持在线安装来源，但目前不能直接填 cfKanban 源码仓库地址。** DSH 可以安装 Git、npm 或压缩包 URL；cfKanban 当前的完整插件包随 Skills 发行包提供，没有独立的在线插件包入口。仓库根目录和 Skills ZIP 下载地址都不是可直接安装的 DSH 插件。

请使用下面的本地文件方式，或交给 Agent 完成。

如果想自己操作桌面界面，先让 Agent 准备好经过校验的插件文件：

```text
请准备适用于我的 DSH 的官方 cfKanban 插件包，核验后给出本地文件路径。
我会在 DSH 的 Plugins 页面手动安装。
```

然后打开 **Plugins → Add plugin**，填入 Agent 给出的本地 `.tgz` 文件路径，点击 **Install**，完成后选择 **Enable now**；按 DSH 提示重启即可。无需解包源码或手动计算摘要。入口能力见 [DSH 官方插件界面说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-plugin-manager/README.md)。

## 打开项目侧栏

启用兼容插件后，直接告诉 Agent：

```text
在侧边栏打开 CFK-123。
```

也可以指定项目。Agent 会核对访问权限、打开侧栏，并确认已定位到请求的页面。侧栏能力不可用时，会说明限制，不另开浏览器；打开视图的请求不会安装或启用插件。

[![DeepSeek Harness 左侧显示会话，右侧 cfKanban 侧栏显示 CFK-600 详情](../../assets/integrations/dsh-sidebar.png)](../../assets/integrations/dsh-sidebar.png)

*cfKanban 侧栏与当前会话并排，点击图片可查看原图。这张图展示桌面版布局；示例任务、语言及可用按钮可能与你的安装不同。*

也可以手动打开：

1. 在 DSH 中打开你正在工作的项目目录。
2. 点击聊天面板旁的 **cfKanban logo** 按钮。
3. 已有项目关联时，侧栏会核对身份和权限，自动打开唯一匹配项目；有多个目标时再选择。

没有关联时，可以先手动选择项目，或让 Agent 为当前目录[保存项目关联](../usage/profile.md)。关联只帮助选择，不会增加权限。插件使用 DSH 所在电脑的身份；远程或多人共享的 DSH 服务不属于当前侧栏的支持范围。

在侧栏中，点击当前项目可切换项目，通过「看板」或「列表」浏览任务，再点击任务查看详情。有相应权限时，可以修改优先级、状态和负责人，添加评论及记录完成情况。「打开完整线上看板」会打开当前项目或任务的线上页面。需要工作区、成员或 Owner 管理时，让 Agent 打开[对应管理页面](../administration/index.md)。两种界面的范围见[打开看板](./webui.md)。

DSH Web 版也能使用侧栏；它由插件嵌入，无需浏览器另外打开本地工作台网页。

写入结果不确定时，先在原视图使用**恢复**，再关闭侧栏或重启 DSH；重新打开不会自动重试此前的操作。

## 更新或遇到问题

```text
请将当前 DSH 中的 cfKanban 插件更新到兼容的最新正式版。
保留身份和其他插件，检查接入是否可用，告诉我哪些应用或会话需要重启。
```

如果插件不出现，先确认装的是当前使用的桌面版还是 Web 版，并检查是否启用、是否需要重启。能打开侧栏但看不到项目时，核对[加入状态与权限](../usage/access.md)，不要重复安装插件来解决权限问题。
