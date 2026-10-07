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

Deployment keeps the required explicit instance, Cloudflare account and resource targets. Apply/resume use the frozen authorized plan; moving directories or changing saved CLI context never retargets that plan or replaces its confirmation.

First deployment verifies the exact Cloudflare `workers.dev` address. An existing Instance upgrade uses its current trusted address, including a custom domain, and checks that it matches the frozen plan before cloud writes. A domain change follows the separate trusted-origin rebind flow; entering a different URL in an upgrade plan does not establish trust. Final readback verifies the same Instance and Owner and rejects an older origin version.

Cloudflare login, GUI/UAC and browser steps may require the user. WebUI does not hold Cloudflare credentials. Updating local Skills/CLI never upgrades an Instance implicitly. Worker rollback never rolls back D1, and Time Travel restore is not automatic. Actual external verification requires a separately approved isolated environment.

Device authentication delivers its verification URL and code only to a real dedicated terminal. A headless process fails before starting login; complete the authorized official Wrangler login manually and inspect the exact profile/account. An interrupted authentication action is never automatically repeated. Resuming after manual login requires evidence bound to the original plan, explicit profile/account and a fresh readback; it records the external resolution while retaining that the original action's commitment is unproven.

Registering an existing preferred custom domain for schema 27+ WAF management is a separate non-secret workflow. `deploy waf-target inspect` verifies the exact Worker/domain/D1 and current Owner; `deploy waf-target plan` freezes the target, current versions and optional exact legacy rule import. Review it before `apply` or `resume` with the same plan authorization. It writes guarded target/ownership metadata to D1, creates no domain or rule, and keeps local Cloudflare credentials local. The Web/API then manage enable/disable through the shared Service plan/apply contract. Existing `deploy public-access` domain cutover/rollback retains its independent origin and Passkey impacts.

```text
cfkanban deploy waf-target inspect --help
cfkanban deploy waf-target plan --help
cfkanban deploy waf-target apply --help
cfkanban deploy waf-target resume --help
```
