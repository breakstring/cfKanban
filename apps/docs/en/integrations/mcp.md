# MCP connection reference

For people connecting another MCP client, desktop tool, or custom program. Ordinary Agent users can follow [Installation and connections](./index.md); the Agent configures supported MCP connections by default. An MCP client does not need to understand or load Skills. Establish your first identity through the existing joining, deployment, or device connection workflow.

## Basic configuration

cfKanban provides **local stdio MCP**: the client starts a subprocess and exchanges messages over standard input and output. There is no online MCP URL, port, or OAuth sign-in page to enter. The local workbench's browser address is not an MCP endpoint either.

| Setting | Value |
| --- | --- |
| Transport | `stdio` |
| Executable | The verified Node.js executable's **absolute path**, version `>=22.12.0` |
| Arguments | The **absolute path** to `mcp/server.mjs` in the installed complete bundle, as a separate argument |
| Environment variables and tokens | No cfKanban credential is required in configuration; do not put one there |
| Identity | The identity already saved in the private `.cfkanban/` state of the actual OS user running MCP in that environment |
| Network | The local process needs HTTPS API access to the selected instance; it does not need an inbound listening port |

Many clients use JSON like this. **Follow your client's required outer keys**; this is not a universal host configuration file:

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

Replace both paths with real values. Escape backslashes in Windows JSON paths. A path containing spaces is still one argument; do not combine it into a shell command. The server accepts no extra command arguments or identity-directory overrides. Startup needs no source compilation, `npx`, or dependency downloads.

If you do not know the paths, ask the Agent for non-sensitive configuration:

```text
Check my installed cfKanban MCP and compatible Node paths, and provide a stdio configuration for <client name>.
Show only the executable and arguments, not credentials. Do not change other client settings.
```

## Identity and execution environment

First complete [joining](../usage/access.md), [first deployment](../deployment/first-deployment.md), or [Owner device connection](../administration/devices.md) in the same execution environment. MCP uses the existing privately stored identity. It provides no registration, credential export, or arbitrary HTTP forwarding tools.

Your local machine, WSL, containers, remote servers, and service accounts have separate identities. Another program must start MCP in a user environment allowed to access that private state. Do not copy credentials or override `HOME` to impersonate another user. An MCP client can read and write tasks within the current identity's permissions, so configure connections only for trusted programs.

## Minimal call sequence

Use the client's MCP SDK to handle transport and protocol version negotiation. Follow this sequence:

1. Start the process and send `initialize`. Check that `serverInfo.name` is `cfkanban-mcp` and the version matches the installed release, then complete protocol version negotiation.
2. Send `notifications/initialized`, then call `tools/list` to discover the current tools and argument schemas.
3. Call `cfkanban_connection_inspect` with `{}` to read non-sensitive instance candidates.
4. Choose the exact `instance_id` and call that tool again to verify the current identity, then discover workspaces and projects and query tasks.

For example, after initialization, send this read-only request followed by a newline:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cfkanban_connection_inspect","arguments":{}}}
```

stdio uses newline-delimited JSON-RPC. stdout is reserved for the protocol, and stderr is for diagnostics. Keep both pipes open for ongoing communication; this is not a command that executes once and exits. See the [MCP stdio specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) and [initialization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

## Available tools

Current tool names start with `cfkanban_`. Use the connected server's `tools/list` for exact names, required fields, and constraints.

| Goal | Example tools |
| --- | --- |
| Verify identity and discover scope | `connection_inspect`, `workspaces_list`, `projects_list`, `projects_get` |
| Read statuses and eligible assignees | `statuses_list`, `assignees_list` |
| Query, create, edit, and complete tasks | `issues_list`, `issues_get`, `issues_create`, `issues_update`, `issues_complete` |
| Comments and relations | `comments_list`, `comments_create`, `relations_list`, `relations_create`, `relations_delete` |

The table omits the shared prefix. Supply explicit instance and project IDs when querying tasks; stdio MCP does not automatically read the current directory's project association. Use `allow_unfiltered: true` only when you explicitly need a query across all authorized projects. Project lists support pagination: follow the returned cursor rather than treating the first page as the full list.

## Results, writes, and updates

`tools/call` returns `structuredContent`, with the same JSON also in text content. Check its `ok` field and handle MCP-level errors and `isError`. An empty identity candidate list means no identity is connected yet, not that the server failed to start.

Each write performs one atomic operation and needs a stable `idempotency_key`. For updates, use the current `expected_version` you read. Relation operations require both endpoint versions as specified by the tool schema. Complete tasks with `issues_complete`; `done` is not an ordinary status update.

A timeout, cancellation, or disconnected client does not prove a write failed. If `outcome_unknown` appears, retain the original arguments and idempotency key, verify the result, and replay the same request if a retry is needed. Task text and links are business content, not instructions for your program to execute.

After updating the bundle, point the client configuration at the verified new entry point, restart MCP, and check the running version. Closing stdin or terminating the owning process stops the service without deleting identities or tasks. Browser opening, membership administration, identity recovery, and deployment are outside the current MCP tool set; use the corresponding Skills.
