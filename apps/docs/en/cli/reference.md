# Commands, parameters & results

Root and group help provide workflow navigation; command help highlights relevant parameters, effects and examples from the same catalog packaged in the immutable bundle. Help-only `--advanced` reveals advanced and compatibility commands, plus advanced options such as structured input; `--json` retains the complete machine catalog. `--advanced` is not a business-command flag or an independent installation path.

```text
cfkanban help
cfkanban issue --help
cfkanban issue create --help
cfkanban issue create --help --advanced
cfkanban help --advanced
cfkanban issue show --instance <instance-uuid> --identifier CFK-123 --json
```

Use long options and stable IDs. `--instance` and `--instance-id` are aliases; single-value Workspace/Project options also accept `--workspace` / `--workspace-id` and `--project` / `--project-id`. Repeated list filters retain their existing array semantics and cursors; never collect all history to filter locally. `--locale en|zh-CN` selects help language; `--json` selects the versioned machine envelope. Results go to stdout, diagnostics to stderr, and business failures return nonzero.

`issue reference --identifier CFK-123 --projection mention|resource` provides a compact authorized read with an optional bounded body. Choose one projection value, rather than typing the `|` separator. It is separate from the full `issue show` response; see [task reads](./daily.md#read-or-create-an-issue) for truncation and follow-up Comment/relation reads. Availability depends on the installed CLI and Service version.

`search-index status`, `search-index snapshot` and `search-index changes` expose the same read-only Issue number/title synchronization used by the Codex search cache. They return metadata and opaque cursors, not local search candidates or Issue bodies. Status uses explicit repeated `--project` filters or the current directory's associated Projects; without either, it requires `--allow-unfiltered true` to select all currently authorized Projects. This option never grants access. Snapshot and changes require one explicit Project and its returned cursor; each page is limited to 100 entries.

```text
cfkanban search-index status --instance <instance-uuid> --project <project-uuid> --json
cfkanban search-index snapshot --instance <instance-uuid> --project <project-uuid> --cursor STATUS_CURSOR --limit 100 --json
cfkanban search-index changes --instance <instance-uuid> --project <project-uuid> --after NEXT_CURSOR --limit 100 --json
```

Replace `STATUS_CURSOR` with the Project cursor returned by status. Follow snapshot `next_cursor` until `has_more` is false, then use that cursor as `--after` for changes. Follow change pages even when `items` is empty. A cursor reset or expiration requires a fresh complete snapshot of that Project.

## Context selection and saved defaults

Explicit IDs take precedence. Otherwise, the CLI resolves only the level the command needs from repository recommendations, a compatible saved directory choice, a global default or a unique registered connection/Service candidate. Repository recommendations override the global default. A directory choice may narrow repository candidates but cannot expand them. Repository scope remains a flat list of non-secret instance/Workspace/Project UUID tuples, with no preferred or last-used Project.

`context show/use/clear` default to the current directory; optional `--directory` selects another working directory. Git detection uses the current worktree root, including subdirectories, and the nearest root for a nested repository. Separate worktrees have separate choices; a confirmed non-Git directory uses itself. Git detection failure is reported and cannot silently bypass repository scope.

| Command | Effect |
| --- | --- |
| `context show` | Diagnose Git, repository targets, saved context and resolved IDs; multiple candidates can remain unselected, with a null Project. |
| `context use` | Explicitly save a private directory default, normally one Project; verify its Workspace and repository membership. |
| `context clear` | Remove the private directory choice; retain the repository scope file and connection. |
| `context use/show/clear --global true` | Operate on the explicit private global default; repository recommendations still win when commands run in a repository. |

With no IDs, `context use` selects from repository targets, or from bounded Service discovery when no repository targets exist. Explicit Workspace input without a Project saves the Workspace level; explicit instance-only input saves the instance level even when repository Project candidates exist. Narrower repository candidates are not thereby saved as a Project choice. Global show/use/clear do not depend on cwd Git detection or repository scope, so a damaged scope file or missing Git does not block them. An explicitly saved global target may be outside this repository. An ordinary command's terminal selection is temporary and does not call `context use` for you.

```text
cfkanban context show --json
cfkanban context use --instance-id <instance-uuid> --workspace-id <workspace-uuid>
cfkanban context use --instance <instance-uuid> --workspace-id <workspace-uuid> --project-id <project-uuid> --global true
cfkanban context show --global true --json
cfkanban context clear --global true
```

Actual TTY commands may offer a selection automatically. `--interactive` and `--no-interactive` are mutually exclusive. JSON, non-TTY execution, `--no-interactive`, or stdin occupied by body/secure input never prompt; `--interactive` cannot override those constraints. An invalid or inaccessible recommendation/default stops resolution instead of selecting another target or expanding to all authorized Issues.

Business commands that automatically fill at least one contextual field report stable target IDs and their sources in `result.resolved_context`. Fully explicit existing calls keep their compatible result shape, so this field is not required in every response. `context show/use` always include diagnostic metadata; `show` uses `result.data.resolved_context`, alongside `git`, `repo_targets` and `saved_context`, and `selection_required` may remain true. Sources are `explicit`, `repository`, `saved_directory`, `saved_global`, `local_connection` and `service_unique`. Check any returned context with the Service's `resolved_scope`; neither local object grants permission.

| Structured code | Next step |
| --- | --- |
| `CLI_CONTEXT_SELECTION_REQUIRED` | Select a candidate by stable ID; retry with explicit arguments, or explicitly save the requested preference. |
| `CLI_CONTEXT_CONFLICT` | Inspect the selected IDs and saved context; correct the mismatch. |
| `CLI_CONTEXT_STALE` | Inspect the unavailable target; explicitly choose a valid replacement or clear the obsolete saved choice. |
| `CLI_CONTEXT_UNAVAILABLE` | Inspect connection/Git/Service diagnostics or supply verified exact IDs. |

Exit codes: 0 success, 2 invalid input, 3 authentication, 4 authorization, 5 conflict, 6 unknown/unverified write result, 7 runtime/platform failure, and 8 not found. Inspect the structured error as well as the exit code.

Ordinary text supports `--body-file` or `--body-stdin`; structured non-secret fields support `--input-file` or `--input-stdin`. Unknown, conflicting, duplicated or missing business inputs fail before writes; omitted contextual IDs must resolve first. Help does not read stdin. Do not pass credentials, invitation capabilities or browser tickets through arguments, environment variables or ordinary input files. Use the dedicated secure flow.

The browser shares permission and completion semantics. `issue complete` records only actual evidence; reopening preserves prior records. Public command names and fields are compatibility contracts; the bundled help is the precise reference for the installed version.
