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

## Desktop workbench

The source includes a workbench for current desktop hosts supporting official [Plugin Extensions](https://developers.openai.com/plugins/build/extensions). The plugin provides both a global entrypoint in the sidebar and a thread entrypoint in the conversation panel. They use the same local MCP connection and the same workbench as the local browser and DSH integration. Source builds are candidates until a release and actual desktop-host validation; updating source does not update an installed plugin.

The global sidebar opens your last successfully selected global project after checking the current identity and project access again. With no valid saved choice, it opens the first accessible project under the verified identity; project switching remains available. This preference is local to the Codex global workbench. It does not associate a repository or conversation with a cfKanban Project, and it does not restore earlier drafts or pending operations.

Your Agent reads the conversation's trusted working directory using the same complete verified plugin bundle's read-only `context show --directory <absolute-directory> --json --no-interactive`. From the Skill directory, use verified Node with `../../cli/cfkanban.mjs`; a PATH `cfkanban` may still run an older canonical bundle after a local plugin install. If its successful result lacks `workbench_context_key`, the Agent supplements it with the same bundle's read-only `scope inspect-directory`, reusing its scope and explicit CLI default without upgrading the global CLI. A confirmed Git repository supplies a non-secret `workbench_context_key`, passed to the conversation entry as `repository_key`; the panel does not discover the repository itself. An explicit Project or an explicit saved CLI directory Project takes precedence. Otherwise the workbench revalidates this repository's last successful Codex Project and the recorded Principal before restoring it. With no usable last Project, it verifies repository recommendations in order and opens the first accessible one. IDs and the repository key never grant access; the opener checks current identity, Project relationship and permissions again. Invalid associations or a stale explicit CLI default need correction or an explicit target, without silent global fallback. Only an automatic Codex last Project rejected with 403/404 under the same Principal can fall back to the recommendations.

Successful binding and Project switching automatically remember this repository's Codex last Project, including an accessible Project outside the initial recommendations. This private preference does not modify `.cfkanban-scope.json` or the CLI's explicitly saved directory context, and it is independent of the global sidebar preference. A thread with no repository context does not read or update global last-Project state: one verified connection opens an accessible default, while multiple unresolved connections require a connection choice. The Project switcher groups all accessible Projects in the verified instance by Workspace, with pagination; initial recommendations do not limit later switching. A Codex project does not grant cfKanban authorization. Verify the displayed identity and project before acting.

To request a conversation view, ask your Agent: “Open the cfKanban workbench beside this conversation.” The Agent discovers `cfkanban_workbench_open`, which declares the thread entrypoint and accepts either `target:{instance_id,workspace_id,project_id}` or `recommended_targets` with 1–50 unique three-UUID targets, plus optional `repository_key`. The key is the inspector's 64-character lowercase hexadecimal value and can be supplied alone: `{repository_key}` restores this repository's last Project even without repository recommendations, or opens and remembers a verified single connection's accessible default. `{}` opens without a trusted repository context. The Agent sends only these non-secret values, not a working directory, URL or Credential. The sidebar uses the separate `cfkanban_workbench_global_open({})` global entrypoint, which never receives repository context. A model tool call and the host's manual conversation-panel entry are different triggers; the host controls where the tool result renders. A successful entry call does not by itself confirm visible rendering or selection of the Project or Issue you intended.

Each opening has its own project, filters and selected task. Use board or list, read task details, create a task, edit its title or Markdown body, change priority, status, assignee or labels, add a comment, or explicitly complete with evidence when permission allows. Copy a task identifier, URL or original Markdown to ask an Agent to continue; the workbench does not automatically send chat messages. Business deep links and Composer At-Mentions are not implemented in the current integration.

If the initialized workbench confirms that there is no connected identity, follow the existing joining or device connection workflow in the same environment. If a write's result is uncertain, use **Recover** in its original view before another write or project switch. Keep that view and MCP process available until recovery is resolved. Remounting with the same view ID can resume its retained state; a fresh opening or MCP restart does not restore the original view or prove the remote write failed. Remembering a global project does not recover an earlier write.

For the following errors, close and reopen the workbench. If the error persists, share its code with your Agent so it can check the running MCP version and host connection. These errors do not mean that no identity is connected. If an earlier write was uncertain, verify its result before continuing.

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

Use the complete verified bundle, including `mcp/workbench.html` and metadata, with the configuration above. Register the connection once. A supporting host discovers global / thread entrypoints from `tools/list`, and reads `ui://cfkanban/workbench/<release_version>/<html_sha256>/index.html`. This resource address includes the release version and actual HTML content digest, so changed HTML receives a new address even when local candidates use the same version number. A client without UI support can continue using the ordinary business tools. Clipboard permission may be denied; selected text remains available for manual copying. Local stdio integration does not establish eligibility for the public universal plugin directory, whose publication requirements must be checked separately.

Workbench calls use a non-secret UUID `view_id` in tool arguments to locate their independent server-side view; an optional snapshot `action_id` checks that view's original action receipt. Neither ID grants business access. Initial view IDs, snapshots and receipts are returned in UI-only result metadata. Identity, project permissions and write recovery remain with the protected runtime and Service.

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
