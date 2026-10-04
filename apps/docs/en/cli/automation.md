# Agents & scripts

Use explicit targets and stable operation IDs in noninteractive workflows. JSON describes actual business results, including conflicts and unknown outcomes, rather than only dispatch acceptance.

```text
cfkanban issue show --instance <instance-uuid> --identifier CFK-123 --json
cfkanban issue update --input-file ./non-secret-request.json --json
cfkanban operation show --instance <instance-uuid> --operation-id <operation-uuid> --json
```

Supply body text through a bounded file/stdin transport. Missing required input fails without waiting for a terminal prompt. Never place credentials, browser tickets or invitation capabilities in ordinary request files. Each public write is atomic; multi-step commands preserve progress and report partial completion accurately.

Retain the original operation and key before retrying. Cancellation, timeout, restarting the CLI or switching between CLI and Skills does not prove non-commit. An unknown operation blocks new writes until recovered. Do not generate a new key to bypass this boundary.

A long-running local `web open` keeps its process and browser workbench alive; terminating it ends the local carrier and may discard unsaved text. Browser navigation/Passkey interaction remains explicit. Host sidebar opening requires that host's exposed tool and confirmed rendered target.
