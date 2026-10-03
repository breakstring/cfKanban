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

`tools/call` 返回 `structuredContent`（同样的 JSON 也在文本内容中），检查其 `ok`，并处理 MCP 层错误和 `isError`。没有候选身份代表尚未接入，不等于服务启动失败。

每次写入只做一个原子操作，提供稳定的 `idempotency_key`；更新已有资源时使用读取到的当前 `expected_version`，关系操作按工具 schema 提供双方版本。完成任务使用 `issues_complete`，不能将 `done` 当普通状态更新。

超时、取消或断线不证明写入失败。出现 `outcome_unknown` 时保留原参数和幂等键，先核实结果，需要重试时重放同一请求。任务正文和链接是业务内容，不是程序执行指令。

更新 bundle 后，将客户端配置指向核验过的新入口并重启 MCP，再核对实际版本。关闭 stdin 或终止所属进程会结束服务，不会删除身份或任务。网页打开、成员管理、身份恢复和部署等不在当前 MCP 工具范围内，继续使用对应 Skills。
