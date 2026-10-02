# DeepSeek Harness

cfKanban DSH 插件提供四个 Skills、本地 stdio MCP，以及聊天旁可选任务侧栏。桌面与 Web 共用适配器，但使用独立 profile。兼容基线为 DSH `0.2.0-rc.2` 与 Node `>=22.12.0`；安装到其他版本前，核对所选包的兼容元数据。

侧栏复用 cfKanban 自包含 Vue 工作台，私有身份与获准操作由 DSH Host 处理；嵌入页通过专属消息通道接收任务数据，不要求浏览器访问另外的 localhost 网页，也不会接收长期 Credential。详见[本地与线上 Web UI 对照](./index.md#本地与线上-web-ui)。

## 获取并校验压缩包

```text
请用 $cfkanban-deploy 检查适用于当前 DSH 的已公开 cfKanban 发行。
准备已校验 Skill bundle，指出 DSH 压缩包、准确版本、来源和 SHA-256 证据。
安装前说明目标 DSH profile 与本地变化，不部署或升级实例。
```

从[官方正式版安装引导](https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md)与 [stable pointer](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json)开始。Agent 核验不可变发行 manifest、发布者连续性、允许的来源及 `cfkanban-skills-VERSION.zip` 的 SHA-256，再安全解包完整 bundle。固定 DSH 压缩包位于已校验 ZIP 内：

```text
cfkanban-skills-VERSION/
  dsh/cfkanban-dsh-VERSION.tgz
```

发行 manifest 发布 Skill 和 Service 两个 ZIP 的摘要，不提供独立公开 DSH tgz 下载地址或摘要；已校验的外层 Skill ZIP 建立内层 DSH 包的来源信任链。在 macOS/Linux 可记录解出的 tgz 摘要：

```sh
shasum -a 256 /absolute/path/cfkanban-skills-VERSION/dsh/cfkanban-dsh-VERSION.tgz
```

Windows 使用：

```powershell
Get-FileHash -Algorithm SHA256 'C:\absolute\path\cfkanban-dsh-VERSION.tgz'
```

新计算的摘要只标识本地这些字节，不能独立证明发布者。保留 ZIP/manifest 校验证据，并核对包内 `artifact-manifest.json` 的版本、组件与文件摘要。所选公开发行没有 `dsh/` 时，该发行无法安装此插件；只有明确验收时才选择准确已发布测试版。源码候选包记录 checkout 与 dirty 状态，不属于 canonical release。

安装固定预构建包，不直接安装源码子目录或未经校验的 registry 包。包中已包含完整 Skills 资源、共享 runtime、预构建 MCP、本地 runtime 与侧栏产物；安装和启动不需要构建 cfKanban 或下载前端依赖。

## 安装到 Web

使用已安装的官方 DSH Web CLI，把已校验压缩包的绝对路径传入：

```sh
dsh plugin --profile web add /absolute/path/cfkanban-skills-VERSION/dsh/cfkanban-dsh-VERSION.tgz
```

启动或重启 `dsh web`，打开它实际报告的回环地址。装入 `web` 不代表已装入 `desktop`。使用其他已有 Web profile 时，按 DSH 文档明确选择那个 profile。[官方 bundle 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)说明通过插件管理器在 profile 安装预构建 tgz 和移除包的方式。

## 安装到桌面

先启动桌面一次，初始化它的 profile，再**完全退出应用**。只关闭窗口可能仍保留 Host。使用该桌面应用随附的命令安装，完成后重新打开桌面。macOS 应用位于 `/Applications` 时：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /absolute/path/cfkanban-skills-VERSION/dsh/cfkanban-dsh-VERSION.tgz
```

装在其他位置时使用应用实际路径；其他平台使用该安装提供的命令，不猜目录，也不使用另外安装的 npm CLI 修改 `desktop`。桌面的「Manage dsh Command…」可提供应用自己的命令，「Plugins」页管理插件行。随应用 CLI 可以在桌面退出时维护插件，不用于启动桌面。见[官方桌面所有权说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime)。

## 核验 Skills、MCP 与侧栏

在目标 profile 的 Plugins 页核对 `cfkanban-bundle`、`cfkanban-skills`、`cfkanban-mcp` 已激活；需要侧栏时保持 `cfkanban-panel` 激活。该 bundle 添加独立 filesystem provider 和 MCP entry，保留已有 providers 与 servers。

核对 `cfkanban-howto`、`cfkanban`、`cfkanban-admin`、`cfkanban-deploy` 的发现与加载，包含引用资源。从每个实际操作技能目录运行 `node scripts/cfkanban-tool.mjs help` 查看准确命令表面。bundle 的 provider 名为 `cfkanban`、rank 为 600；同名项目或用户 Skill 可能优先，加载旧技能时核对实际路径。该规则来自[官方 filesystem provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)。

```text
请调用 mcp__cfkanban__cfkanban_connection_inspect 检查本地 cfKanban 连接。
核验我在 <实例> 的身份和项目 <UUID> 的权限，显示返回身份与范围，不修改任务。
```

DSH 的[官方 MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)在 `mcp__cfkanban__` 命名空间发现有界日常工具。连接检查使用 Host 实际 OS 用户已有的私有身份；加入、恢复、管理、部署和敏感浏览器交付继续走 Skills。缺少身份时走[加入](../usage/access.md)或 [Owner 设备接入](../administration/devices.md)，不把凭据粘贴到聊天或插件设置。

点击聊天旁的 cfKanban logo 按钮打开任务 Tab。将当前 DSH Session 的工作区设为真实项目目录；Host 只读该目录的 `.cfkanban-scope.json`，可按[目录关联](../usage/profile.md)准备。单个有效实例/项目目标在实时身份与权限核验后自动绑定；多个目标在推荐范围内选择。缺失、非法或无权目标会说明原因并保留手动入口；过滤不授予权限，也不会自动开始工作。

通过侧栏切换项目，使用看板/列表、详情和手动刷新。行内优先级、状态、负责人，以及评论、完成操作按权限开放。把 CFK 编号或 Issue URL 交给 Agent，由 Skills 读取当前任务；正文和评论复制按钮提供原始 Markdown，并保留手动复制回退。来源 DSH Session 提供工作目录，切换其他聊天不会重绑已有 Tab。

侧栏的「打开完整线上看板」核验绑定身份与准确目标，再通过现有临时 Browser Launch 打开系统浏览器。结果不确定时使用「恢复原线上打开」，不另建启动；Host 保留原请求，解决前阻止项目切换与新写入。

侧栏支持监听回环的本机单用户 Host，不支持公网、未知、远程或多用户 Host。WSL、容器、SSH 和远程机器不会继承这台电脑的私有身份。

## Node 与 profile 设置

默认用运行中 Host 的绝对可执行文件启动 stdio MCP；桌面使用随附 Electron 的 Node 模式，不依赖 GUI PATH。要使用已核验独立 Node，可在插件设置或 profile 自有 patch 层配置 bundle 行：

```yaml
- id: cfkanban-bundle
  config:
    nodeExecutable: /absolute/path/to/node
```

runtime 以有界版本探测核验该文件。Node 缺失或不兼容时明确报告，不修改全局 Node、PATH 或 shell 设置；配置与环境变量中不放凭据。

## 更新、停用和卸载

在同一目标 profile 用相同 `add` 命令安装另一个已校验固定包。重启 Web Host，或完全退出并重开桌面，再核对 MCP initialize 版本、实际 Skill 路径、连接身份及范围与该包一致。更新文件或 active receipt 不会替换运行中的 MCP；本地插件更新不升级 Cloudflare 实例。版本选择与恢复规则见[通用](./general.md#更新本地技能)。

在 Plugins 页停用 `cfkanban-panel`，即可保留 Skills 和 MCP。Web 完整卸载命令：

```sh
dsh plugin --profile web remove @cfkanban/dsh-plugin
```

桌面完全退出后，使用随附命令和 `--profile desktop` 卸载。DSH 移除包及其配置层；停用或卸载接入会保留 `.cfkanban/`、凭据、部署记录和任务历史。

## 常见问题

| 现象 | 核对事项 |
| --- | --- |
| Web 有插件，桌面没有 | 两者是独立 profile；安装并重启准确目标。 |
| 技能缺失或仍是旧版 | 核对插件激活、实际加载路径、同名项目/用户 Skill 与所选包版本。 |
| MCP 工具未出现 | 核对 `cfkanban-mcp` 激活、已校验 Node、固定入口、启动失败与实际发现；重连耗尽后重载该行或重启。 |
| 没有身份或项目权限 | 核对 Host OS 用户/环境、可信实例、实时身份与当前权限，使用对应接入流程。 |
| 项目推荐缺失或不对 | 核对来源 Session 注册的工作目录及其 scope 文件，明确选择目标，不扩大查询。 |
| 冲突、超时或写入中断 | 读取当前状态，保留原参数和幂等键；使用原视图恢复入口，Host 重启后先核实 Service 结果再写入。 |
| 宿主、沙盒、网络或浏览器限制 | 报告受阻边界，不复制凭据、不放宽权限、不静默改换环境。 |

只检查激活状态、加载路径、版本/摘要、Node 版本、MCP 就绪情况、非秘密身份信息与明确范围；不输出完整 DSH 配置、LLM/API 秘密、私有凭据文件或一次性浏览器能力。
