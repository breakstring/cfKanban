# Commands, parameters & results

Root and group help list available public commands, effects and fields. Detailed help follows the same command catalog that is packaged in the immutable bundle.

```text
cfkanban help
cfkanban issue --help
cfkanban issue create --help
cfkanban issue show --instance <instance-uuid> --identifier CFK-123 --json
```

Use long options and explicit stable IDs. Repeated array options preserve server filters and cursors; never collect all history to filter locally. `--locale en|zh-CN` selects help language; `--json` selects the versioned machine envelope. Results go to stdout, diagnostics to stderr, and business failures return nonzero.

Exit codes: 0 success, 2 invalid input, 3 authentication, 4 authorization, 5 conflict, 6 unknown/unverified write result, 7 runtime/platform failure, and 8 not found. Inspect the structured error as well as the exit code.

Ordinary text supports `--body-file` or `--body-stdin`; structured non-secret fields support `--input-file` or `--input-stdin`. Unknown, conflicting, duplicated or missing inputs fail before writes. Help does not read stdin. Do not pass credentials, invitation capabilities or browser tickets through arguments, environment variables or ordinary input files. Use the dedicated secure flow.

The browser shares permission and completion semantics. `issue complete` records only actual evidence; reopening preserves prior records. Public command names and fields are compatibility contracts; the bundled help is the precise reference for the installed version.
