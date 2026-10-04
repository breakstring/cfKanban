# Scripts and Agents

Use the same task commands in a shell, CI job or Agent. CLI, Skill API and MCP share the Service's business results and permission rules. `--json` changes the output format; it does not add scheduling, triggers or bulk operations.

## Read tasks in a shell

A unique repository context or connection supplies ordinary targets. List the current Workspace's Projects and the recommended Projects' Issues:

```text
cfkanban project list
cfkanban issue list --status todo
```

Explicit UUID arguments are still useful for fixed automation targets. Supply real required business fields, such as the title and the description file when creating an Issue.

## Read repository scope in CI

A read-only scope inspection reports directory recommendations; it does not join Projects or grant access. JSON is useful when another program will inspect the stable IDs and result fields:

```text
cfkanban scope inspect --json --no-interactive
cfkanban issue list --status todo --json --no-interactive
```

CI must already have an approved trusted connection in private state if it reads Service data. Never put a Credential in argv, environment variables, logs or request files. A repository scope file contains only non-secret recommended targets.

## Let an Agent resolve a choice

Inspect the current context, then make an ordinary scoped read. If several targets match, the result supplies structured candidate IDs rather than waiting for input:

```text
cfkanban context show --json --no-interactive
cfkanban issue list --json --no-interactive
cfkanban issue list --instance <instance-uuid> --project <project-uuid> --json --no-interactive
```

The last command demonstrates an explicit target after a choice. Use the user's known intent to select a stable ID; ask only when that intent leaves a real ambiguity. Do not call `context use` unless the user requested a saved preference. Inspect `result.resolved_context` when returned, together with Service `resolved_scope`, to understand the applied targets. Fully explicit calls may keep their earlier result shape.

JSON, non-TTY execution, `--no-interactive`, and stdin occupied by body or secure input never prompt, even with `--interactive`. Ordinary body text supports file/stdin transport; secrets and one-time capabilities use dedicated safe channels. Missing business input or an unresolved write target fails before dispatch.

For a fixed single-Project write, an explicit automation example is:

```text
cfkanban issue create --instance <instance-uuid> --workspace-id <workspace-uuid> --project-id <project-uuid> --title "Fix login" --body-file ./issue.md --json --no-interactive
```

Machine results use `{schema_version:1, ok, result}`. stdout carries the result, stderr carries redacted diagnostics, and failures return nonzero. Exit codes are 0 success, 2 input, 3 authentication, 4 permission, 5 conflict, 6 unknown write result, 7 runtime/platform and 8 not found. Inspect the structured result as well as the exit code.

The CLI records an ordinary write's resolved target and recovery information before sending it. If a result is unknown, preserve that operation and follow [recovery](./recovery.md); changing cwd or retrying through another channel does not prove failure. Browser/Passkey steps remain interactive where required. A local browser workbench needs its CLI process to stay alive.
