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

## 工作台协议参考

<span id="桌面工作台"></span>

Codex 的安装、全局 / 会话入口、项目记忆、显示模式和日常恢复见 [Codex App](./codex-app.md)。本节只提供自写客户端所需的协议参数；旧“桌面工作台”章节链接仍保留。普通用户无需按此手动配置。

完整、已验证的 bundle 包含 `mcp/workbench.html` 及 metadata，只注册一条 stdio 连接。宿主通过 `tools/list` 发现 `cfkanban_workbench_global_open({})` 的 `global` 入口和 `cfkanban_workbench_open` 的 `thread` 入口，读取 `ui://cfkanban/workbench/<release_version>/<html_sha256>/index.html`，MIME 为 `text/html;profile=mcp-app`。资源 URI 绑定版本与实际 HTML 摘要；同版本候选的 HTML 变化也产生新 URI。没有 UI 支持的客户端继续使用普通业务工具。本地连接不代表公共 universal 插件目录已发布。

| 工具 | 严格参数 |
| --- | --- |
| `cfkanban_workbench_global_open` | 空对象 `{}` |
| `cfkanban_workbench_open` | 可选 `target:{instance_id,workspace_id,project_id,identifier?}` 或 `recommended_targets`，二者互斥；推荐仅为 1–50 个唯一三 UUID 项目目标，不含 identifier；可选 `repository_key` |
| `cfkanban_workbench_snapshot` | `{view_id,action_id?}` |
| `cfkanban_workbench_action` | `{view_id,message}`，受控动作 schema 以发现结果为准 |
| `cfkanban_workbench_release` | `{view_id}`，没有运行或待恢复操作时才能释放 |

明确 target 的三个 ID 使用准确 UUID，可选 identifier 只用于用户明确要求的完整 `CFK-N` 编号，N 为不含前导零的正整数、最多 15 位；先核对其准确实例、工作区和所属项目。入口在返回初始快照前核验当前身份、实时权限及 Issue 归属，并加载准确详情。编号不存在、无权、归属不符或读取失败时返回具体错误，不改选看板或其他目标。推荐、已保存默认及最后项目偏好不含 identifier。此 schema 计划随 v1.9.3 RC 交付，调用前先发现实际安装的 schema。

`repository_key` 只能是同一已验证 bundle 的只读目录探测返回的 `workbench_context_key`（64 个小写十六进制字符），也可单独传入。Agent 使用当前会话的可信绝对目录执行 `context show --directory <绝对工作目录> --json --no-interactive`；优先从 Skill 目录用已验证 Node 运行 `../../cli/cfkanban.mjs`。旧 PATH CLI 缺 key 时，用同 bundle 的 `scope inspect-directory` 补齐并保留已有 scope / CLI 显式默认，不自动升级全局 CLI。不传目录、URL、Credential 或客户端 / 聊天 ID，不从 MCP cwd 或 Git remote 推断项目。global 不接收仓库上下文。

每次入口调用建立独立视图。非秘密 UUID `view_id` 经 UI 专用 tool-result `_meta["cfkanban/viewId"]` 交付，只在页面内存和后续工具的 arguments 中使用；不写入 URL、文件、widgetState 或日志。快照经 `_meta["cfkanban/snapshot"]` 交付，可选 `action_id` 核对该视图原动作 receipt。模型可见结果只是操作摘要，`ok` 或快照包含 Issue 不证明页面可见或业务目标已选定；准确初始任务数据不会强制侧栏，也不提供官方 URL deep link。两个 ID、资源 URI 和仓库 key 均不授予权限。

组件只请求 `inline` / `fullscreen`，以 HostContext 实际返回值为准。thread entrypoint 描述宿主会话面板位置，不是第三种 display mode。初始化顺序、受控动作及恢复应由兼容 MCP Apps 客户端处理；业务写入仍由 Service 核验身份、权限、CAS 与幂等。

下列错误需核对客户端、实际运行版本和连接；它们不证明身份尚未建立。原写入未知时先核对结果，再关闭重开。

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

### 编号引用参考

实际宿主支持且已安装相应发行时，通过 `tools/list` 发现 `cfkanban_mentions_search`；它接受严格 `{query}`，输入上限为 4,096 UTF-8 字节。有效输入为完整 `CFK-N`，或本地已保存可信 HTTPS origin 下的 `/app/issues/CFK-N` 链接；链接不含 query、fragment 或用户信息。空 / 无效输入返回空候选且不发起远端任务请求，标题查询不支持；多个未明确实例下的编号返回 scope 错误，不进行跨实例搜索。

本地组件与实例必须同时支持此能力。读取前核验可信 discovery 的 `capabilities.issue_reference === true`；旧实例未声明支持时返回 `MCP_ISSUE_REFERENCE_UNSUPPORTED`，不能把旧路由的 404 当作无匹配任务，也不自动升级实例。

`structuredContent.items` 返回至多一个 `resource_link`。客户端选中后使用 `resources/read` 读取进程内登记的 URI；每次读取重新核验原 Principal、项目访问权限和任务稳定 ID。MCP 重启、引用淘汰或未知 URI 时需重新选择，不从静态资源或 URI 恢复权限。候选和资源响应分别有 4,096 / 32,768 字节总预算；资源正文最多 8,192 UTF-8 字节，必要时为 JSON 总预算继续裁剪，以 `body_bytes` 与 `body_truncated` 表达完整长度和截断。

请求有有界并发、队列、频率及从排队开始的超时，不做后台预取。资源只提供当前主要任务字段及正文，评论与关系按需要使用普通业务工具；返回内容标记为非可信数据，引用不授权写入。日常使用见 [Codex App：引用任务](./codex-app.md#在会话中引用任务)。

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
