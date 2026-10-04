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
```

Preparation checks compatible Node/Wrangler, exact Cloudflare account, trustworthy release and artifact digests. Plan output binds resources, migrations, optional capabilities and costs. Apply requires matching authorization material for that exact plan; a blanket yes does not authorize drift. Multi-step deployment is not one atomic transaction.

Resume keeps the same plan, operation and journal. Unknown resources, identity changes, partial migrations or schema/readback mismatches stop new writes. Same-plan recovery does not require new approval when the existing authorization covers it. Success requires actual Worker/D1/Owner/version readback and receipt, not a subprocess exit code.

Cloudflare login, GUI/UAC and browser steps may require the user. WebUI does not hold Cloudflare credentials. Updating local Skills/CLI never upgrades an Instance implicitly. Worker rollback never rolls back D1, and Time Travel restore is not automatic. Actual external verification requires a separately approved isolated environment.

Device authentication delivers its verification URL and code only to a real dedicated terminal. A headless process fails before starting login; complete the authorized official Wrangler login manually and inspect the exact profile/account. An interrupted authentication action is never automatically repeated. Resuming after manual login requires evidence bound to the original plan, explicit profile/account and a fresh readback; it records the external resolution while retaining that the original action's commitment is unproven.
