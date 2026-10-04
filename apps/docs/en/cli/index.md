# CLI overview

The public `cfkanban` command is delivered with the verified complete Skills bundle. It uses the same protected identity and Service rules as Skills and MCP. You need Node.js >=22.12.0 in the current environment. The CLI is being prepared in source; these pages do not mean it has been released to the stable channel.

```text
cfkanban
cfkanban --locale zh-CN
cfkanban issue --help
cfkanban --version --json
```

Start with [installation](./installation.md), then [daily work](./daily.md), [administration](./administration.md), or [deployment](./deployment.md). [Reference](./reference.md) describes input/output, [automation](./automation.md) covers agents, and [recovery](./recovery.md) explains uncertain results.

The Web UI remains a browser interface to the same Service. The CLI cannot control a host sidebar; use that host's exposed view tool or `web open` for a browser. Commands never infer authority from a local name or directory.
