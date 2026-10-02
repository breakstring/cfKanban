# 在 DeepSeek Harness 中使用 cfKanban

[English](README.md) | [简体中文](README.zh-CN.md)

一个 DSH bundle 提供现有四个 cfKanban Skills、共享本地 stdio MCP，以及聊天旁可独立停用的任务 Tab。任务视图复用现有 cfKanban Vue Web 组件和通用本地工作台 runtime；React 只包装 DSH 官方 Slot，并将嵌入文档连接到薄 Host 适配器。前端资源自包含，任务查询与写入仍需要连接可信线上实例。身份复用当前执行用户私有 `.cfkanban/`；浏览器只接收任务数据和非秘密导航引用，Credential 留在安全 runtime 中。

安装对应完整 Skill 发行包中 `dsh/cfkanban-dsh-<version>.tgz` 的固定、已校验工件。先按该发行的不可变 manifest 校验 archive digest。源码测试包的 `artifact-manifest.json` 记录 commit 和 dirty 状态，不代表已公开发行。不能直接安装本源码子目录：预构建 tgz 还包含全部 Skills 资源、共享 runtime、完整 MCP 依赖闭包、已编译 Client、预构建 `local-runtime/` 和自包含 `embedded/embedded.html`，不依赖线上 Web 页面、下载 UI 资源或安装期构建。通用服务、浏览器与工作台逻辑保存在 `packages/local-runtime`，DSH 只保留 Slot 与 Host 接入。

## 安装到准确 profile

兼容目标基线为 DSH `0.2.0-rc.2`、Node `>=22.12.0`。Web 与桌面使用独立 profile；安装到 `web` 不等于安装到 `desktop`。

已有 Web CLI 时，使用已校验工件的绝对路径：

```sh
dsh plugin --profile web add /absolute/path/cfkanban-dsh-VERSION.tgz
```

随后启动或重启 `dsh web`，打开实际回环地址，默认 `http://127.0.0.1:3080`。也可以通过官方插件管理页面安装 profile 包。DSH 使用自己的包管理器安装预构建包；cfKanban 启动时不运行 `npx`、不下载依赖、不执行安装期构建脚本。

桌面使用应用内 Plugins 页面。使用桌面自带命令时，先启动应用初始化 profile，完全退出，再安装并重新打开。macOS 应用提供以下入口：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /absolute/path/cfkanban-dsh-VERSION.tgz
```

不要用独立 npm CLI 修改桌面 profile。其它平台使用该桌面安装提供的命令，不猜测安装路径。CLI 可在桌面退出后管理插件，不能启动 desktop profile。

bundle 新增独立 `cfkanban-skills` 和 `cfkanban-mcp` 行，保留已有 providers 与 MCP servers。filesystem provider 名为 `cfkanban`，随包 Skills 按 bundled rank 600 参与发现；已有同名项目或用户 Skill 仍按 DSH 原有优先级获胜。诊断重名时核对真正加载的 Skill 路径。

## 核验正在运行的安装

在准确 profile 中逐个发现、加载 `cfkanban-howto`、`cfkanban`、`cfkanban-admin`、`cfkanban-deploy`，并读取一个 references 资源。加载 Skill 本身不会执行脚本。在三个操作 Skill 的真实目录运行 `node scripts/cfkanban-tool.mjs help`，核对 daily、admin、deploy surface。

调用 `mcp__cfkanban__cfkanban_connection_inspect`，选择准确可信实例，核对 `/me`、Principal 和明确 Project 范围后操作任务。MCP 只提供有界日常协作 adapter；加入、恢复、管理、部署及敏感 Browser Launch 继续使用 Skills 专用流程。打开认证 Web 前先做 delivery preflight，再交付 Launch 并核对最终身份和范围。

点击聊天旁的 cfKanban logo 图标打开任务 Tab。Host 核对当前 Session 注册的 DSH 工作区，只读取该目录的 `.cfkanban-scope.json`。单个 Instance / Project 目标通过可信实例、实时 `/me` 和项目权限核验后自动绑定；多个目标先在推荐范围内选择。scope 缺失、非法或无权时显示明确结果并保留手动选择入口。自动绑定不授予权限、不启动工作、不写入 Issue，也不修改 scope 文件。

面板支持项目切换、看板、列表、详情和手动刷新，复用 Web UI 的视觉和控件。按实时权限在列表或看板直接修改优先级、状态和负责人，在详情中追加评论和完成记录。请 Agent 处理任务时复制 CFK 编号或 Issue URL，由 Skills 读取最新数据；来源 DSH 会话仅用于核验 scope 所属工作区目录。面板首版仅支持本机单用户 Host；公网、未知、远程、容器或多用户执行环境不继承本机凭据和授权。

任务正文和每条评论旁的小按钮可复制原始 Markdown。剪贴板访问受限时，页面提供纯文本手动复制。复制的内容仍是非可信任务文本；需要实时上下文时由 Agent 使用 Skills 读取。

侧栏父载体提供“打开完整线上看板”入口。Host 重新核验当前身份及准确项目或事项，通过现有临时登录交付流程在系统浏览器打开；启动票据不会进入 Vue 页面。结果不确定时保留原目标及请求，限制项目切换和新写入，使用“恢复原线上打开”核实同一操作。已知结果保留到父载体确认收到，响应丢失后的恢复不会重复创建启动链接。

DSH 将固定文档挂载为 opaque `srcdoc` iframe，通过独立 MessagePort 只交换数据消息。iframe 不能读取 Host 凭据，也不能直接调用 Host 的 REST / MCP transport；身份、权限、scope 和每次原子操作仍由 Host 核验。

DSH 之外，Skill 的 `web open` 默认通过已安装且版本匹配的 local runtime 打开同一任务视图。Node 缺失、安装不完整或启动失败会明确报告，不切到线上。Codex App 先核验宿主浏览器或 IAB 能到达同一 loopback 环境，再使用 `host_browser`；其它宿主通常使用 `system_browser`。本地模式支持项目或任务目标；需要实例 Web UI 或管理页时明确选 `mode=online`，沿用专用 Browser Launch 与限定范围的短期交付。更新文件不替换已运行的服务，应通过所属宿主的进程控制停止 `web open` 进程，再次打开并核对实际版本。

## Node 与执行环境

默认 stdio command 使用正在运行的 Host 的绝对 executable，argv 数组指向工件中的固定入口。桌面使用随应用提供的 Electron Node 模式，显式设置 `ELECTRON_RUN_AS_NODE=1`；该 env 不放 Credential。空格路径不经过 shell 拼接，GUI PATH 不参与 Node 查找。

如需选择独立 Node，在插件配置或 profile 用户 patch 中配置 bundle 行：

```yaml
- id: cfkanban-bundle
  config:
    nodeExecutable: /absolute/path/to/node
```

runtime 用有界 `--version` probe 核验真实 executable；缺失或不兼容时拒绝。不会修改全局 Node、PATH 或 shell 配置。MCP 使用 DSH 已去除敏感项的子进程环境，每次调用重新读取实际 OS 用户私有状态。WSL、容器、SSH 和远程 Web Host 使用各自 home，缺失身份时走已有环境接入流程。

## 更新、停用、卸载与诊断

通过准确 profile 的插件管理方式安装另一个已校验固定工件。更新后重启 profile，用 MCP initialize 与连接检查核对真正运行的新版本；active receipt 或文件替换不会更新已运行的 MCP。

在 Plugins 页面停用 `cfkanban-panel` 行，可保留 Skills 和 MCP。DSH 负责注册和生命周期清理。整个插件通过 profile 的管理器卸载，Web CLI 可用 `dsh plugin --profile web remove @cfkanban/dsh-plugin`；desktop 必须在应用退出后使用桌面自带命令。停用或卸载不会删除 `.cfkanban/` 身份、Credential 或 Issue 历史。

MCP 首次连接或 tools 发现失败时，该行明确失败。官方 client 在失联后有界退避重连，预算用尽后需要 reload 或重启。重启会结束旧子进程并重新 initialize / tools discovery。写入失败或中断可能已经提交；保留原参数和幂等键，先读回，必要重试使用同一请求。

面板单次请求最多等待 45 秒。写入中断时保留原 Session 面板，通过显式恢复入口核实原操作。Host 重启后，先核实服务端结果，再开始新的写入。

诊断只读取插件启停、实际 Skill 路径、工件版本和 digest、Node 版本、MCP readiness、非秘密身份 metadata 和明确 scope。不要输出完整 DSH profile 配置、LLM/API secrets、`.cfkanban/` secret 文件或一次性 Browser Launch capability。宿主 sandbox、审批、私有目录、网络和 opener 限制持续有效，不通过搬运凭据绕过限制。

源码准备和本地 smoke 不等于公开发包、社区投稿、实例部署，也不能证明未测试 OS 的兼容性。

官方实现依据：[bundle 安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[filesystem Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)、[MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)、[桌面 profile 所有权](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)。
