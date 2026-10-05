# Agent 接入文档截图采集清单

供 CFK-603 的用户手册配图采集使用。正文与导航可独立交付；本文件不记录任务状态，不把截图当作全部宿主生命周期验收。每张截图收到后先核对真实客户端与画面，再放入对应公开页。

## 采集约定

- 使用演示实例、演示身份和任务，例如 `DemoWorkspace`、`DemoProject`、`CFK-123`；避免暴露真实任务内容、评论、其他聊天或私人项目名称。
- 每组附实际客户端名称、完整版本 / build、操作系统、桌面 / Web 形态、界面语言及 cfKanban 实际安装版本。源码候选额外附分支、commit 与 dirty 状态；不能将候选截图标成正式发行。
- 不必把版本号都放进画面，可单独给一张 About 画面或文字记录。每一项均必须能对应上述元数据；不能凭本文件推断版本。
- 不展示 Credential、Token、邀请 / 一次性交付链接、私有状态目录内容、个人邮箱、完整用户路径或敏感 URL。安装画面中的本地路径可采用演示目录或遮住用户名；保留文件名、格式和按钮。
- 优先提供原尺寸 PNG。截图保留必要上下文及当前选中入口，裁去无关窗口；系统缩放不低于可清晰读字的程度。P0 是优先配图，P1 可后补；不同语言不必重复整个操作，优先一套中文实图，若客户端允许再补对应英文。

## 需要的画面

| 优先级 / 文件建议 | 实际客户端与状态 | 画面要点 / 操作 | 目标页面 |
| --- | --- | --- | --- |
| P0 `codex-installed-plugin.png` | Codex App，实际版本 / build；cfKanban 已安装并启用，记录实际发行或候选来源 | 当前插件详情或 Installed 列表，cfKanban 名称、启用状态及可见版本；同屏能说明真实入口即可，不展示其他私有插件详情 | Codex App：安装与检查 |
| P0 `codex-global-workbench.png` | 同一 Codex App 版本；已有演示身份及一个有权项目，global 入口打开成功 | 保留全局侧栏及被选中的 cfKanban 入口，工作台项目名称、看板 / 列表与身份可辨认；不要只截孤立看板 | Codex App：选择入口 |
| P0 `codex-thread-workbench.png` | 同一 Codex App 版本；演示会话旁的 thread 面板已打开 | 同屏保留会话与工作台，标明实际用于打开的面板入口或选择器；聊天只保留演示话术，项目可辨认 | Codex App：选择入口 |
| P0 `codex-display-inline.png`、`codex-display-fullscreen.png`、`codex-display-return.png` | 支持本轮显示行为的真实 Codex App 与候选 / 发行版本；宿主确实返回 inline 时采集 | 先截内联工作台与“展开工作台”，点击后截全屏，再退出截原页面。保持同一项目；说明刷新或筛选变化后是否保持 inline。宿主不提供 inline 时只记录实际结果，不伪造回退图 | Codex App：展开与返回 |
| P0 `codex-project-selector.png` | 同一 Codex App 版本；演示身份至少有两个工作区内的可读项目 | 展开项目选择器，展示按工作区分组和当前项目，若有真实下一页则保留翻页入口；不创建或扩大真实权限只为截图 | Codex App：切换项目 |
| P0 `codex-repository-project-before.png`、`codex-repository-project-reopened.png` | 同一 Codex App 版本；Agent 使用可信演示仓库上下文打开，无未知写入 | 在该仓库工作台主动切到另一个有权演示项目，截当前项目；关闭后由 Agent 在同一仓库重开，再截恢复后的相同项目。附简短操作说明，分别核对 global 的独立记忆，不把草稿恢复混入此图 | Codex App：项目记忆与重开 |
| P1 `dsh-add-plugin.png`、`dsh-plugin-enabled.png` | DeepSeek Harness 桌面或 Web，必须记录实际版本；兼容基线为 `0.2.0-rc.2`，其他版本需实际验证 | Plugins → Add plugin 的本地 `.tgz` 输入与 Install 按钮；安装后 cfKanban 启用状态。采用已校验包，不展示完整个人路径。桌面 / Web 不互相代替，先给实际使用的那种 | DSH：安装 |
| P1 `dsh-sidebar-workbench.png` | 与上一项相同 DSH 版本 / 形态；插件启用、演示身份可读项目 | 聊天旁 cfKanban logo 入口、展开侧栏、当前项目与任务详情同屏；可见“打开完整线上看板”入口，不展示真实聊天 | DSH：侧栏 |
| P1 `codex-mention-search.png`、`codex-mention-selected.png` | 真实提供 Composer mentions 的桌面客户端，记录名称、版本 / build 及包含本轮能力的实际 cfKanban 版本 | 打开 cfKanban 引用来源并输入 `CFK-123`；截图只展示演示任务结果。再截选中的引用，不发送会产生业务变化的消息。若客户端没有该入口，记录缺口，不用普通输入 `@` 充当能力证据 | Codex App：引用任务 |

## 双语图注与 alt

| 画面 | 简体中文图注 / alt | English caption / alt |
| --- | --- | --- |
| Codex 安装结果 | 图注：Codex App 中已启用的 cfKanban 插件。alt：插件详情显示 cfKanban 安装和启用状态。 | Caption: cfKanban enabled in Codex App. Alt: Plugin details showing cfKanban installation and enabled status. |
| Codex global | 图注：从全局侧栏打开 cfKanban 工作台。alt：Codex 全局侧栏选中 cfKanban，并显示演示项目看板。 | Caption: Open cfKanban from the global sidebar. Alt: Codex global sidebar with cfKanban selected and a demo Project board visible. |
| Codex thread | 图注：在会话旁浏览当前项目。alt：演示会话旁的 cfKanban 面板显示当前项目。 | Caption: Browse a Project beside a conversation. Alt: A cfKanban panel showing the current Project beside a demo conversation. |
| Codex 显示切换 | 图注：展开工作台后可返回原页面。alt：同一 cfKanban 工作台的内联、全屏和返回页面状态。 | Caption: Expand the workbench and return to the original view. Alt: Inline, fullscreen, and returned states of the same cfKanban workbench. |
| Codex 项目选择 | 图注：按工作区切换有权访问的项目。alt：项目选择器按工作区分组显示演示项目。 | Caption: Switch among accessible Projects grouped by Workspace. Alt: The Project selector grouping demo Projects by Workspace. |
| Codex 项目记忆 | 图注：在同一仓库重开时重新核验上次项目。alt：关闭前和在同一仓库重开后显示相同演示项目。 | Caption: Reverify the last Project when reopening in the same repository. Alt: The same demo Project shown before closing and after reopening in one repository. |
| DSH 安装 | 图注：用已核验的本地插件包安装并启用 cfKanban。alt：DSH 本地插件安装表单及 cfKanban 启用状态。 | Caption: Install and enable cfKanban from a verified local plugin package. Alt: DSH local plugin installation form and cfKanban enabled status. |
| DSH 侧栏 | 图注：DSH 聊天旁的 cfKanban 侧栏。alt：DSH 的 cfKanban 入口和侧栏中显示演示任务。 | Caption: The cfKanban sidebar beside DSH chat. Alt: DSH’s cfKanban entry and sidebar showing a demo Issue. |
| Codex 引用任务 | 图注：通过完整编号查找并引用演示任务。alt：cfKanban 编号查询结果及选中的演示任务引用。 | Caption: Find and mention a demo Issue by its complete identifier. Alt: cfKanban identifier lookup results and the selected demo Issue mention. |

收到截图后，按真实画面删减或调整图注，并在图片附近注明采集的客户端版本；未核验入口不写成通用按钮路径。需要遮敏时先生成脱敏副本，再用于公开文档，原始敏感截图不进仓库。
