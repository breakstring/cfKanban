# Work on tasks from the terminal

Run these commands from your actual working directory. The CLI resolves stable targets from repository recommendations, saved context or a unique connection, then checks live Service permissions. You can use explicit UUIDs whenever you need a fixed target.

## Choose or switch your Project

Use `context use` when you want to remember a Project for this worktree. In a terminal, it offers a choice when needed; `context show` shows the resulting scope. This saves private local state and does not join a Project or grant access.

```text
cfkanban context use
cfkanban context show
```

Subdirectories share the worktree's choice; separate worktrees and nested repositories keep their own directory context. Ordinary command selections are temporary unless you explicitly save them. `context clear` removes that saved choice without changing repository recommendations.

## Find work

Search by title or Issue identifier, or list work by status:

```text
cfkanban issue list --q "login"
cfkanban issue list --status todo --status in_progress
```

If this repository recommends two Projects in one instance, Issue lists cover both unless you select a narrower Project. A single-Project write needs one choice. Invalid or inaccessible scope stops the command instead of silently selecting another Project. Search and pagination remain bounded.

## Read or create an Issue

Use the identifier returned by the list. To create an Issue, provide its actual title and put its description in a text file:

```text
cfkanban issue show --identifier CFK-123
cfkanban issue create --title "Fix login" --body-file ./issue.md
```

For a compact read-only reference on an instance that supports this endpoint, choose a projection:

```text
cfkanban issue reference --identifier CFK-123 --projection mention
cfkanban issue reference --identifier CFK-123 --projection resource
```

`mention` returns the identifier, title, and Project/Workspace context without loading the body. `resource` adds current status, priority, version, update time, and a bounded body. Check `body_truncated` and `body_bytes` before treating it as the complete description. Use ordinary `issue show` when you need the full Issue response; its behavior is unchanged. References do not include Comments or relations: read those separately with `comment list` and `relation list` as needed. This read does not create a composer mention or authorize any change.

## Move work forward and comment

Change the status or add a progress Comment. The CLI checks the current permissions and version; a concurrent change requires review rather than overwriting newer work.

```text
cfkanban issue update --identifier CFK-123 --status-key in_progress
cfkanban comment create --identifier CFK-123 --body-file ./note.md
```

## Record completion

Write what you actually delivered in the completion note. Include only verification and artifacts that exist; completing an Issue does not perform its underlying work.

```text
cfkanban issue complete --identifier CFK-123 --body-file ./completion.md
```

Completion preserves an immutable record. Reopening and uncertain-write recovery are described by the installed help and [recovery guide](./recovery.md).

## Open the board

Open the current verified Project in a local browser workbench. If a Project is still ambiguous, the CLI uses the same terminal selection or structured noninteractive choices:

```text
cfkanban web open
```

Local mode is the default and needs its CLI process to keep running. Explicit online mode uses the existing safe Browser Launch flow; inspect installed help for the options. A host sidebar uses that host's exposed view tool. For first access, use the [join and sign-in guide](../usage/access.md); for extra parameters or context defaults, use the [reference](./reference.md). Administration and deployment are separate tasks.
