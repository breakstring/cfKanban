# DeepSeek Harness

DSH 插件一次接入 cfKanban 技能、MCP 和聊天旁的任务侧栏。**装好插件后，不需要再单独安装技能或配置 MCP。** 本页适用于本机运行的 DSH 桌面版和 Web 版；当前兼容基线是 DSH `0.2.0-rc.2`。

## 安装：交给当前 Agent

```text
请阅读 cfKanban 官方安装引导：
https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md
为这台电脑的 DeepSeek Harness 桌面版安装 cfKanban 插件，包含技能、MCP 和侧栏。
请使用包含 DSH 插件的兼容发行，保留已有身份和其他插件，完成后核对可用性。
不要部署或升级线上实例。
```

使用 Web 版时，把提示词中的“桌面版”改为“Web 版”。两者的插件安装位置独立；装好其中一个，不代表另一个也已安装。安装测试版时，在请求中写明准确版本。

Agent 会准备官方发行中的插件包，并安装到你指定的 DSH。需要你在 Plugins 页面启用或重新打开 DSH 时，会给出具体提示。安装后还没有 cfKanban 身份的用户，继续[加入与登录](../usage/access.md)；安装插件不等于加入项目。

## 能直接在 DSH 中填仓库地址安装吗？

**DSH 支持在线安装来源，但目前不能直接填 cfKanban 源码仓库地址。** DSH 可以安装 Git、npm 或压缩包 URL；cfKanban 当前的完整插件包随 Skills 发行包提供，没有独立的在线插件包入口。仓库根目录和 Skills ZIP 下载地址都不是可直接安装的 DSH 插件。

这不需要另建仓库：后续发行可以把同一个预构建插件包单独提供下载，再将固定版本的下载地址填进 DSH。当前请使用下面的本地文件方式，或交给 Agent 完成。

如果想自己操作桌面界面，先让 Agent 准备好经过校验的插件文件：

```text
请准备适用于我的 DSH 的官方 cfKanban 插件包，核验后给出本地文件路径。
我会在 DSH 的 Plugins 页面手动安装。
```

然后打开 **Plugins → Add plugin**，填入 Agent 给出的本地 `.tgz` 文件路径，点击 **Install**，完成后选择 **Enable now**；按 DSH 提示重启即可。无需解包源码或手动计算摘要。入口能力见 [DSH 官方插件界面说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-plugin-manager/README.md)。

## 打开项目侧栏

1. 在 DSH 中打开你正在工作的项目目录。
2. 点击聊天面板旁的 **cfKanban logo** 按钮。
3. 已有项目关联时，侧栏会核对身份和权限，自动打开唯一匹配项目；有多个目标时再选择。

没有关联时，可以先手动选择项目，或让 Agent 为当前目录[保存项目关联](../usage/profile.md)。关联只帮助选择，不会增加权限。插件使用 DSH 所在电脑的身份；远程或多人共享的 DSH 服务不属于当前侧栏的支持范围。

侧栏可切换项目、使用看板或列表、直接修改优先级、状态和负责人，也可查看详情、评论和完成任务。「打开完整线上看板」会打开当前项目或 Issue 的线上页面。需要工作区、成员或 Owner 管理时，让 Agent 打开[对应管理入口](../administration/index.md)，以取得匹配的管理会话。两种界面的范围见[打开看板](./webui.md)。

DSH Web 版也能使用侧栏；它由插件嵌入，无需浏览器另外打开本地工作台网页。

## 更新或遇到问题

```text
请检查并更新当前 DSH 中的 cfKanban 插件，保留身份和其他插件。
说明需要重启的应用或会话，完成后核验技能、MCP 和侧栏可用。
```

如果插件不出现，先确认装的是当前使用的桌面版还是 Web 版，并检查是否启用、是否需要重启。能打开侧栏但看不到项目时，核对[加入状态与权限](../usage/access.md)，不要重复安装插件来解决权限问题。
