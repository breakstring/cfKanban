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

Owner Cloudflare settings use the same fixed-target Service API as the Web. Read connection capabilities, notification policies/recipients and WAF status; plan and apply one rate-limit group or the supported usage settings. USD budget policies are read-only: an unknown amount is not zero, and a generic policy limit is not a confirmed dollar threshold.

```text
cfkanban admin cloudflare --help
cfkanban admin rate-limits plan --help
cfkanban admin rate-limits apply --help
cfkanban admin usage history --help
cfkanban admin usage collect --help
```

Keep the plan's exact version for apply. A pending or unknown Cloudflare result requires the original operation and `admin cloudflare verify-operation`; verification only reads Cloudflare and never repeats a settings write. History reads 1–90 complete UTC days from local D1, preserving gaps; explicit collection accepts one of the last seven complete UTC dates and does not replace unknown values with zero.

Cloudflare Tokens are a browser-only input exception. Use the existing `web open` flow for the Owner management page, then open **Cloudflare settings**. Enter credentials only in that protected transient form; they are stored as ordinary Worker Secrets. There is no Token argument, input-file or ordinary API command that writes these secrets to a CLI recovery journal. See [connection and permissions](../deployment/optional.md).
