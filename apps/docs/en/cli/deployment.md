# Deployment plans & recovery

The CLI uses the same immutable artifacts and explicit plan authorization as the deployment Skill. Reading help or preparing source does not authorize Cloudflare changes.

```text
cfkanban deploy capabilities --json
cfkanban deploy release discover --json
cfkanban deploy plan --help
cfkanban deploy apply --help
cfkanban deploy resume --help
cfkanban deploy upgrade --help
cfkanban deploy attach --help
cfkanban deploy recovery --help
cfkanban deploy trends inspect --help
cfkanban deploy trends plan --help
cfkanban deploy trends run --help
```

Preparation checks compatible Node/Wrangler, exact Cloudflare account, trustworthy release and artifact digests. Plan output binds resources, migrations, optional capabilities and costs. Apply requires matching authorization material for that exact plan; a blanket yes does not authorize drift. Multi-step deployment is not one atomic transaction.

Resume keeps the same plan, operation and journal. Unknown resources, identity changes, partial migrations or schema/readback mismatches stop new writes. Same-plan recovery does not require new approval when the existing authorization covers it. Success requires actual Worker/D1/Owner/version readback and receipt, not a subprocess exit code.

Deployment keeps the required explicit instance, Cloudflare account and resource targets. Apply/resume use the frozen authorized plan; moving directories or changing saved CLI context never retargets that plan or replaces its confirmation.

First deployment verifies the exact Cloudflare `workers.dev` address. An existing Instance upgrade uses its current trusted address, including a custom domain, and checks that it matches the frozen plan before cloud writes. A domain change follows the separate trusted-origin rebind flow; entering a different URL in an upgrade plan does not establish trust. Final readback verifies the same Instance and Owner and rejects an older origin version.

Cloudflare login, GUI/UAC and browser steps may require the user. WebUI does not hold Cloudflare credentials. Updating local Skills/CLI never upgrades an Instance implicitly. Worker rollback never rolls back D1, and Time Travel restore is not automatic. Actual external verification requires a separately approved isolated environment.

Device authentication delivers its verification URL and code only to a real dedicated terminal. A headless process fails before starting login; complete the authorized official Wrangler login manually and inspect the exact profile/account. An interrupted authentication action is never automatically repeated. Resuming after manual login requires evidence bound to the original plan, explicit profile/account and a fresh readback; it records the external resolution while retaining that the original action's commitment is unproven.

## Initial trend history backfill

Schema 30 separates initial history backfill from the hourly Cron. `deploy trends inspect` reads the verified deployment, queue and actual inspection usage. `deploy trends plan` freezes a bounded plan; `deploy trends run` executes only that authorized plan. This fixed-purpose deployment maintenance updates derived statistics, without changing Issue/Event facts or permissions. Web/API/MCP remain read-only consumers of coverage.

Pass non-secret structured input in a file or stdin:

```sh
cfkanban deploy trends inspect --input-file trends-inspect.json --json --no-interactive
cfkanban deploy trends plan --input-file trends-plan.json --json --no-interactive
cfkanban deploy trends run --input-file trends-run.json --json --no-interactive
```

Inspection needs `instanceId`, `currentReceiptPath`, `serviceBundleRoot` and the absolute `wranglerExecutable`. Use the private receipt for the current deployment and matching verified canonical Service cache. Planning adds `taskId`, optional `operationId` and `budget`, returning `{plan, plan_digest, inspection}`. Execution includes those exact paths, `instanceId`, `taskId`, `operationId`, the unchanged `plan`, and `authorization: {task_id, operation_id, instance_id, plan_digest}`. Credentials are loaded internally; never put them in these files. Targets and the algorithm come from the verified receipt and immutable Service, not command overrides or arbitrary SQL.

Check current account allowance first. Default limits are 8 Issue pages per batch, 100 Events per page, 1000 pages, 30 minutes, 3000 provider requests, at least 500ms between requests, 250000 D1 rows read and 50000 written. A budget override can only reduce work or slow requests. Before another page, the runner reserves 4000 reads and 1000 writes plus control requests. These limits apply to this run; other account traffic also consumes allowance.

The runner uses a local lock, a cross-host 120-second D1 lease/fence, and one CAS SQL commit per page. The private journal records actual D1 reads/writes, SQL duration, request count, pending progress and local Node CPU, which is not Worker CPU. Budget exhaustion, 429, missing usage, no progress or target drift stops execution. If a result is uncertain, retain the original plan, operation and batch ID and inspect commit evidence before further writes; do not blindly rerun or change keys. Verify queue and chart coverage afterward: an empty queue can still leave unrecoverable history marked `partial`.

Registering an existing preferred custom domain for schema 27+ WAF management is a separate non-secret workflow. `deploy waf-target inspect` verifies the exact Worker/domain/D1 and current Owner; `deploy waf-target plan` freezes the target, current versions and optional exact legacy rule import. Review it before `apply` or `resume` with the same plan authorization. It writes guarded target/ownership metadata to D1, creates no domain or rule, and keeps local Cloudflare credentials local. The Web/API then manage enable/disable through the shared Service plan/apply contract. Existing `deploy public-access` domain cutover/rollback retains its independent origin and Passkey impacts.

```text
cfkanban deploy waf-target inspect --help
cfkanban deploy waf-target plan --help
cfkanban deploy waf-target apply --help
cfkanban deploy waf-target resume --help
```
