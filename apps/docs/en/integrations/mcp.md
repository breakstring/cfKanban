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

## Workbench protocol reference

<span id="desktop-workbench"></span>

See [Codex App](./codex-app.md) for installation, global and conversation entries, Project preferences, display modes, and everyday recovery. This section keeps protocol parameters for custom clients, including the old “Desktop workbench” anchor. Ordinary users do not need manual configuration.

Use a complete verified bundle, including `mcp/workbench.html` and metadata, and register one stdio connection. Through `tools/list`, hosts discover the `global` entry of `cfkanban_workbench_global_open({})` and the `thread` entry of `cfkanban_workbench_open`. The resource is `ui://cfkanban/workbench/<release_version>/<html_sha256>/index.html`, with MIME `text/html;profile=mcp-app`. The URI binds the release version and actual HTML digest; changed HTML gets a new URI even for a same-version local candidate. Clients without UI support retain ordinary business tools. A local connection does not establish publication in the public universal plugin directory.

| Tool | Strict arguments |
| --- | --- |
| `cfkanban_workbench_global_open` | Empty `{}` |
| `cfkanban_workbench_open` | Optional `target:{instance_id,workspace_id,project_id,identifier?}` or `recommended_targets`, mutually exclusive; recommendations contain 1–50 unique three-UUID Project targets with no identifier; optional `repository_key` |
| `cfkanban_workbench_snapshot` | `{view_id,action_id?}` |
| `cfkanban_workbench_action` | `{view_id,message}`, with the discovered controlled-action schema |
| `cfkanban_workbench_release` | `{view_id}`, releasable only without running or uncertain operations |

The three IDs in an explicit target must be exact UUIDs. Optional `identifier` is a complete `CFK-N` requested explicitly by the user, with a positive integer without leading zeros and at most 15 digits; resolve its verified instance, Workspace and Project first. Before returning the initial snapshot, the opener checks current identity, live access and Issue membership and loads that exact detail page. Missing, inaccessible, mismatched or failed Issue reads return an error without choosing the board or another target. Recommendations, saved defaults and last-Project preferences do not contain an identifier. This schema is planned for v1.9.3 RC; discover the installed schema before calling.

`repository_key` must be the `workbench_context_key` returned by read-only directory inspection in the same verified bundle: 64 lowercase hexadecimal characters. It can be supplied alone. The Agent inspects the conversation’s trusted absolute directory with `context show --directory <absolute-directory> --json --no-interactive`, preferring verified Node and `../../cli/cfkanban.mjs` from the Skill directory. If an older PATH CLI lacks the key, supplement it using that bundle’s `scope inspect-directory`, preserving inspected scope and saved CLI defaults; do not automatically upgrade the global CLI. Never supply a directory, URL, Credential, client/chat ID, or infer a Project from MCP cwd or Git remotes. Global receives no repository context.

Each entry call creates an independent view. A non-secret UUID `view_id` arrives in UI-only tool-result `_meta["cfkanban/viewId"]`; keep it only in page memory and later tool arguments, never URLs, files, widgetState, or logs. Snapshots arrive in `_meta["cfkanban/snapshot"]`; an optional `action_id` checks that view’s original action receipt. Model-visible results are summaries: `ok` or a snapshot containing an Issue does not prove visible rendering or selected business targets. Exact initial Issue data does not force a sidebar or supply official URL deep links. Neither ID, the resource URI, nor the repository key grants access.

The component requests only `inline` / `fullscreen`, honoring the actual HostContext mode. The thread entrypoint describes the host’s conversation-panel location and is not a third display mode. A compatible MCP Apps client handles initialization, controlled actions, and recovery. The Service still verifies identity, access, CAS, and idempotency for writes.

For these errors, check the client, running version, and connection. They do not mean no identity exists. Verify any uncertain write before closing and reopening.

| Error code | Meaning |
| --- | --- |
| `MCP_APP_HOST_INIT_TIMEOUT` | The host did not respond to workbench initialization in time. |
| `MCP_APP_HOST_INIT_INVALID` | The host initialization response could not be validated. |
| `MCP_APP_INITIAL_RESULT_TIMEOUT` | The host initialized the view but did not provide its initial workbench data in time. |
| `MCP_APP_INITIAL_RESULT_INVALID` | The initial tool result could not be validated. |
| `MCP_APP_INITIAL_SNAPSHOT_INVALID` | The initial workbench snapshot could not be validated. |
| `MCP_APP_VIEW_ID_MISSING` | A workbench request did not include its view ID. |
| `MCP_APP_VIEW_ID_INVALID` | The MCP server received a malformed workbench view ID. |
| `MCP_APP_REOPEN_REQUIRED` | The view connection is unavailable and must be opened again. |

### Identifier mention reference

When the actual host supports it and the installed release includes it, discover `cfkanban_mentions_search` through `tools/list`. It accepts strict `{query}` with a 4,096-byte UTF-8 input limit. Valid input is a complete `CFK-N` or an `/app/issues/CFK-N` link under a locally saved trusted HTTPS origin, without query, fragment, or user information. Empty / invalid input returns no candidates and makes no remote Issue request. Title queries are unsupported; an identifier with several unresolved instances returns a scope error without cross-instance search.

Both local components and the instance must support this capability. Before reading, verify trusted discovery has `capabilities.issue_reference === true`. Older instances without it return `MCP_ISSUE_REFERENCE_UNSUPPORTED`; a legacy route’s 404 must not be reported as an unmatched Issue. The integration does not automatically upgrade the instance.

`structuredContent.items` contains at most one `resource_link`. After selection, the client uses `resources/read` on its process-registered URI. Every read rechecks the original Principal, Project access, and stable Issue ID. Select again after MCP restart, reference eviction, or an unknown URI; a static resource or URI cannot restore authorization. Candidate and resource responses have total budgets of 4,096 / 32,768 bytes. The resource body is at most 8,192 UTF-8 bytes and may be shortened further for the JSON budget; `body_bytes` and `body_truncated` report the original size and truncation.

Requests have bounded concurrency, queues, rate, and a deadline starting at admission; there is no background prefetch. Resources contain current main Issue fields and body. Read Comments and relations through ordinary tools as needed. Content is marked untrusted, and a mention does not authorize a write. See [Codex App: mention an Issue](./codex-app.md#mention-an-issue-in-a-conversation) for everyday usage.

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

Business `tools/call` returns `structuredContent`, with the same JSON also in text content. Check its `ok` field and handle MCP-level errors and `isError`. Workbench tools return only operation summaries there; UI state is delivered in component-only metadata. An empty identity candidate list means no identity is connected yet, not that the server failed to start.

Each write performs one atomic operation and needs a stable `idempotency_key`. For updates, use the current `expected_version` you read. Relation operations require both endpoint versions as specified by the tool schema. Complete tasks with `issues_complete`; `done` is not an ordinary status update.

A timeout, cancellation, or disconnected client does not prove a write failed. If `outcome_unknown` appears, retain the original arguments and idempotency key, verify the result, and replay the same request if a retry is needed. Task text and links are business content, not instructions for your program to execute.

Before updating, resolve any uncertain write in its original view. After updating the bundle, point the client configuration at the verified new entry point, close old workbench views, restart MCP, and check the running version and resource URI. Reopen the workbench from its entrypoint; refreshing an old view does not confirm that it loaded the new bundle. Closing stdin or terminating the owning process stops the service without deleting identities or tasks. Browser opening, membership administration, identity recovery, and deployment are outside the current MCP tool set; use the corresponding Skills.
