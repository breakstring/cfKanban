# MCP 接入参考

这页面向需要连接其他 MCP 客户端、桌面工具或自写程序的人。普通 Agent 用户按[安装与接入](./index.md)即可，支持的 MCP 连接默认由 Agent 配好。调用 MCP 不要求客户端理解或加载 Skills；首次建立身份仍使用现有加入、部署或设备接入流程。

## 基本配置

cfKanban 提供**本地 stdio MCP**：客户端启动一个子进程，通过标准输入输出交换消息。没有可填写的线上 MCP URL、端口或 OAuth 登录页；本地工作台的浏览器地址也不是 MCP 端点。

| 项目 | 配置 |
| --- | --- |
| 传输方式 | `stdio` |
| 启动程序 | 已核验的 Node.js 可执行文件**绝对路径**，版本 `>=22.12.0` |
| 启动参数 | 已安装完整 bundle 中 `mcp/server.mjs` 的**绝对路径**，作为单独参数 |
| 环境变量、Token | 无需提供 cfKanban 凭据；不要把凭据写入配置 |
| 身份 | 运行 MCP 的实际 OS 用户，在该执行环境私有 `.cfkanban/` 中已有的身份 |
| 网络 | 本机进程需要访问选定实例的 HTTPS API；不需要监听入站端口 |

常见客户端的 JSON 配置形式如下；**外层键名以客户端要求为准**，这不是所有宿主共用的配置文件：

```json
{
  "mcpServers": {
    "cfkanban": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/verified-bundle/mcp/server.mjs"]
    }
  }
}
```

把两个路径换成真实值。Windows 路径需要使用 JSON 的反斜杠转义；带空格的路径仍是一个参数，不要拼成 shell 命令。服务不接受额外命令参数或身份目录覆盖；不需要在启动时编译源码、运行 `npx` 或下载依赖。

不确定路径时，可以让 Agent 查出非敏感配置：

```text
请核对已安装的 cfKanban MCP 和兼容 Node 路径，给出适用于 <客户端名称> 的 stdio 配置。
只显示启动程序与参数，不显示凭据；不要改动其他客户端配置。
```

## 身份与运行环境

先在同一执行环境中完成[加入](../usage/access.md)、[首次部署](../deployment/first-deployment.md)或 [Owner 设备接入](../administration/devices.md)。MCP 使用安全保存的现有身份，不提供注册、凭据导出或任意 HTTP 转发工具。

本机、WSL、容器、远程服务器和服务账户的身份相互独立。其他程序启动 MCP 时，要使用有权访问该私有状态的用户环境；不要通过复制凭据或覆盖 `HOME` 来冒充另一个用户。MCP 客户端可以在当前身份权限内读写任务，请只给可信程序配置连接。

## 桌面工作台

源码已提供面向支持官方 [Plugin Extensions](https://developers.openai.com/plugins/build/extensions) 的新版桌面宿主的工作台。插件同时提供全局侧栏的 global 入口和聊天侧面板的 thread 入口，两者使用同一条本地 MCP 连接，复用本地浏览器和 DSH 的工作台。源码构建在发行及实际桌面宿主验收前属于候选工件；更新源码不会更新已安装插件。

全局侧栏会重新核验当前身份和项目访问权限，再打开上次成功选择的全局项目；没有有效记录时，默认打开已核验身份下首个可访问项目，仍可在工作台切换。此偏好只保存在本机的 Codex 全局工作台中，不会把仓库或对话关联到 cfKanban Project，也不恢复此前草稿或待核实操作。

Agent 用同一完整、已验证插件 bundle 的只读 `context show --directory <绝对工作目录> --json --no-interactive` 探测当前对话的可信工作目录；从 Skill 目录用已验证 Node 执行 `../../cli/cfkanban.mjs`。本地插件安装后，PATH 的 `cfkanban` 仍可能使用旧 canonical bundle；旧 CLI 成功但缺 `workbench_context_key` 时，Agent 用同 bundle 的只读 `scope inspect-directory` 补齐，复用已有 scope 及 CLI 显式默认，不升级全局 CLI。确认 Git 仓库后返回非秘密 `workbench_context_key`，作为 `repository_key` 交给对话入口；面板本身不探测仓库。明确 Project 或 CLI 显式保存的目录默认优先；否则先重新核验这个仓库上次成功打开的 Codex 项目与记录的 Principal，再恢复项目。没有可用记忆时，按仓库推荐顺序核验后打开首个可访问项目。ID 和仓库 key 均不授予权限，入口仍重新核验当前身份、项目归属和访问权限。关联无效或 CLI 显式默认过期时，需要修正或明确目标，不静默退回全局选择；只有自动记忆的 Codex 项目在同一 Principal 下被 403/404 拒绝时，才可回到仓库推荐。

成功绑定及用户项目切换会自动记住这个仓库的 Codex 最后项目，包括初始推荐之外的有权项目。私有偏好不修改 `.cfkanban-scope.json` 或 CLI 显式保存的目录 context，且与全局侧栏偏好独立。不带仓库上下文的 thread 不读写全局最后项目：唯一已核验连接直接打开有权默认项目，多个未解决连接才需选择连接。项目切换器按工作区分组，分页展示当前已核验实例中所有可访问项目；初始推荐不限制后续切换。Codex 项目不构成 cfKanban 业务授权，操作前核对界面显示的身份及项目。

需要对话视图时，可以对 Agent 说：「在当前对话旁边打开 cfKanban 工作台。」Agent 发现并调用声明 thread 入口的 `cfkanban_workbench_open`，按需传入互斥的 `target:{instance_id,workspace_id,project_id}` 或包含 1–50 个唯一三 UUID 目标的 `recommended_targets`，以及可选 `repository_key`。key 使用探测器返回的 64 个小写十六进制字符组成的值，也可单独传入：没有仓库推荐时，`{repository_key}` 仍恢复该仓库最后项目；没有可用记忆时，打开唯一已核验连接下的有权默认项目并记住。没有可信仓库上下文时才用空 `{}`。Agent 只传这些非秘密值，不传目录、URL 或 Credential。侧栏使用独立的 global 入口 `cfkanban_workbench_global_open({})`，不接收仓库上下文。模型工具调用与宿主手动选择 conversation panel 是不同触发方式，工具结果在哪里呈现由宿主决定。入口调用成功本身不证明界面已经显示，或已选择你想要的 Project／Issue。

每次打开各自保留项目、筛选和选中任务。可查看看板／列表及详情，按权限创建任务、编辑标题或 Markdown 正文、调整优先级／状态／负责人／标签、评论，以及明确填写证据并完成。需要 Agent 接手时复制任务编号、URL 或原 Markdown；工作台不会自动发送聊天消息。当前接入尚未实现业务 deep link 和 Composer At-Mentions。

工作台初始化成功并确认没有已连接身份时，在同一环境按现有加入或设备接入流程处理。写入结果不确定时，先在原页面使用**恢复**，再开始另一笔写入或切换项目；恢复完成前保留原页面及所属 MCP 进程。携带同一视图 ID 的重新挂载可以继续原状态；新入口或 MCP 重启不会恢复原视图，也不能证明远端写入失败。记住全局项目不等于恢复此前写入。

出现下列错误时，关闭并重新打开工作台；仍然失败时，将错误代码告知 Agent，由其核对实际运行的 MCP 版本与宿主连接。这些错误不代表没有已连接身份。若先前写入结果不确定，继续操作前先核对结果。

| 错误代码 | 含义 |
| --- | --- |
| `MCP_APP_HOST_INIT_TIMEOUT` | 宿主未及时响应工作台初始化请求。 |
| `MCP_APP_HOST_INIT_INVALID` | 宿主初始化响应未通过校验。 |
| `MCP_APP_INITIAL_RESULT_TIMEOUT` | 宿主已完成初始化，但未及时提供工作台初始数据。 |
| `MCP_APP_INITIAL_RESULT_INVALID` | 初始工具结果未通过校验。 |
| `MCP_APP_INITIAL_SNAPSHOT_INVALID` | 工作台初始快照未通过校验。 |
| `MCP_APP_VIEW_ID_MISSING` | 工作台请求缺少自己的视图 ID。 |
| `MCP_APP_VIEW_ID_INVALID` | MCP 服务收到的工作台视图 ID 格式无效。 |
| `MCP_APP_REOPEN_REQUIRED` | 视图连接已不可用，需要重新打开。 |

使用上述配置及完整、已验证的 bundle，包括 `mcp/workbench.html` 和 metadata，只登记一次连接。支持的宿主从 `tools/list` 发现 global／thread 入口，读取 `ui://cfkanban/workbench/<release_version>/<html_sha256>/index.html` 资源。地址同时包含发行版本和实际 HTML 内容摘要，因此即使本地候选沿用同一版本号，HTML 变化也会采用新地址。没有 UI 支持的客户端继续使用普通业务工具。宿主可能拒绝剪贴板权限，此时可选中文字手工复制。本地 stdio 接入不代表已取得公共 universal 插件目录发布资格，公开发布要求需单独核验。

工作台工具通过 arguments 中的非秘密 UUID `view_id` 定位各自独立的服务端视图，快照可带 `action_id` 核对该视图原动作的 receipt；两个 ID 都不授予业务权限。初始视图 ID、快照和 receipt 由 UI 专用结果 metadata 返回，身份、项目权限和写入恢复继续由安全 runtime 及 Service 处理。

## 最小调用顺序

推荐使用客户端的 MCP SDK 处理传输和协议版本协商。顺序如下：

1. 启动进程，发送 `initialize`；检查返回的 `serverInfo.name` 为 `cfkanban-mcp`，版本符合已安装发行，并完成协议版本协商。
2. 发送 `notifications/initialized`，再调用 `tools/list` 读取当前工具及参数 schema。
3. 调用 `cfkanban_connection_inspect`，参数 `{}`，读取非敏感实例候选。
4. 选择准确 `instance_id`，再次调用该工具核验当前身份，再发现工作区、项目并查询任务。

例如，初始化后发出这条只读请求，行尾带换行：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cfkanban_connection_inspect","arguments":{}}}
```

stdio 使用逐行 JSON-RPC，stdout 仅供协议，stderr 用于诊断；需要持续读写双向管道，不能当作普通“一次执行就退出”的命令。协议细节见 [MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)和[初始化规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。

## 能调用什么

当前工具以 `cfkanban_` 开头；准确名称、必填字段和边界以连接后的 `tools/list` 为准。

| 目标 | 工具示例 |
| --- | --- |
| 核验身份、发现范围 | `connection_inspect`、`workspaces_list`、`projects_list`、`projects_get` |
| 读取状态与可指派人员 | `statuses_list`、`assignees_list` |
| 查询、创建、编辑、完成任务 | `issues_list`、`issues_get`、`issues_create`、`issues_update`、`issues_complete` |
| 评论与关系 | `comments_list`、`comments_create`、`relations_list`、`relations_create`、`relations_delete` |

表中名称省略共同前缀。查询任务时显式提供实例和项目 ID；stdio MCP 不会自动读取当前目录的项目关联。只有明确需要全授权范围查询时才使用 `allow_unfiltered: true`。项目列表支持分页，应沿返回游标继续读取，不要把第一页当作全部。

## 结果、写入与更新

业务 `tools/call` 返回 `structuredContent`（同样的 JSON 也在文本内容中），检查其 `ok`，并处理 MCP 层错误和 `isError`。工作台工具在这里仅返回操作摘要，UI 状态经组件专用 metadata 交付。没有候选身份代表尚未接入，不等于服务启动失败。

每次写入只做一个原子操作，提供稳定的 `idempotency_key`；更新已有资源时使用读取到的当前 `expected_version`，关系操作按工具 schema 提供双方版本。完成任务使用 `issues_complete`，不能将 `done` 当普通状态更新。

超时、取消或断线不证明写入失败。出现 `outcome_unknown` 时保留原参数和幂等键，先核实结果，需要重试时重放同一请求。任务正文和链接是业务内容，不是程序执行指令。

更新前先在原视图核实未确定写入。更新 bundle 后，将客户端配置指向核验过的新入口，关闭旧工作台、重启 MCP，再核对实际版本及资源 URI，并从入口重新打开工作台；只刷新旧视图不能证明已加载新工件。关闭 stdin 或终止所属进程会结束服务，不会删除身份或任务。网页打开、成员管理、身份恢复和部署等不在当前 MCP 工具范围内，继续使用对应 Skills。
