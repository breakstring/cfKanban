# Administration from the CLI

Management depends on live Service permissions. Owner, Workspace administrator and Project administrator are distinct scopes; a command group or local name does not grant authority.

```text
cfkanban workspace --help
cfkanban project --help
cfkanban grant --help
cfkanban invite create --help
cfkanban owner device --help
cfkanban admin --help
```

Use workspace/project commands for creation, settings, status names, archive and restoration. Grant, administrator and member commands preserve inherited and direct permissions separately. Purge requires an exact preview and the existing destructive confirmation; archive does not physically delete history.

Ordinary Workspace/Project commands resolve only their required level from the current context; multiple Projects in one Workspace do not make a Workspace command ambiguous. Check any returned `resolved_context` and live permissions before accepting the result. Permanent deletion retains its explicitly supplied exact target and preview confirmation. Owner security flows retain their required explicit instance/identity targets and confirmations; a saved default cannot supply destructive authorization.

Invite creation and recovery use dedicated safe delivery. Public Join settings explain role, independent quotas and closure effects. Owner device approval/revocation, identity switching and credential rotation retain the last-effective-credential protections. Never send capability URLs or tokens to logs or ordinary JSON output.

Homepage, notifications, capacity/limits, usage, origin and audit commands use the same API as the Web maintenance pages. Cloudflare resources, migrations and Owner total-loss recovery belong to deployment plans. For failures, use [recovery](./recovery.md) and preserve the original operation.
