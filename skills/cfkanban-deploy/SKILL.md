---
name: cfkanban-deploy
description: Install, inspect, deploy, resume, and upgrade cfKanban on Cloudflare with canonical release verification, strict-zero plans, migration readback, journals, isolated pinned Wrangler management, and out-of-band Owner recovery.
---

# cfKanban Deploy

Use this Skill for the Cloudflare control plane and local Skill lifecycle. For the same operational guide in Simplified Chinese, read [references/deployment-workflows.zh-CN.md](references/deployment-workflows.zh-CN.md).

## What this Skill can do

- Verify a canonical bootstrap pointer, immutable release manifest, allowed artifact origins, SHA-256 digests, and publisher continuity.
- Inspect Node, Wrangler, OS, storage, and host capabilities without changing them.
- Let Wrangler resolve environment authentication and the current deployment context without enumerating profiles; inspect one named profile only when the user explicitly supplies it; never return tokens, email, directory bindings, resource inventories, or raw output; create and execute an exact, task-bound OAuth plan only when login is actually missing; then read back and pin the selected account before freezing a deployment plan.
- Plan and install an isolated pinned Wrangler npm package, called the Tool Runtime, when no compatible user-owned Wrangler exists.
- Produce, authorize, execute, resume, and verify a strict-zero deployment: one Worker, one D1, bundled Static Assets, and `workers.dev` by default.
- Generate a private portable Wrangler configuration from the verified Service bundle and validate it with `wrangler deploy --dry-run` before deployment.
- Reconcile migration manifest checksums, the remote ledger, and actual D1 schema artifacts.
- Update local Skills and upgrade a deployed Instance as two independent operations.
- Perform controlled out-of-band recovery for the same Owner Principal after total Owner Credential loss.

Loading this Skill is not authorization to install software, change local state, create cloud resources, migrate data, change DNS, recover an Owner, publish, or upgrade.

`packages/skill-runtime` contains shared JavaScript source modules, not a Node.js executable or runtime distribution. The optional Tool Runtime under `~/.cfkanban/tool-runtime/` contains only pinned Wrangler and its npm dependencies; it runs with a compatible user-owned Node.js and never installs Node.js. In the Service bundle, `wrangler.template.json` is a schema-checked skeleton with placeholder resource identities, not a deployable configuration. Generate the private, plan-bound actual configuration outside the immutable bundle before any dry run or deployment.

## Intent-first user experience

Treat a plain request such as “Deploy cfKanban for me” as sufficient to begin. Do not require the user to mention capability checks, release manifests, bundle digests, strict-zero, migrations, journals, readback, or rollback terminology. Translate the requested outcome into the required workflow: begin with read-only discovery, explain availability and blockers in plain language, ask only for result-changing missing choices, and present the exact effects at the authorization boundary. Keep detailed contract terms in Agent reasoning and technical evidence, not in a prompt the user must compose.

If only a prerelease is available, say that stable deployment is unavailable and offer the prerelease as an explicit testing choice. Never opt the user into a prerelease or source checkout silently.

The current public testing pointer is `https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.44/prerelease.json`. Treat it as unavailable until that exact HTTPS resource and its declared immutable manifest/artifacts can be fetched and verified. Do not substitute the repository tag, plugin cache, or source checkout for a missing release asset.

## Choose the deployment source first

- **Canonical stable release:** start from the project's published HTTPS bootstrap document, resolve one immutable manifest, and verify both bundles before planning. This is the normal end-user path.
- **Explicit testing prerelease:** verify its immutable release pointer, manifest, and both bundles exactly like a stable release, but label every plan and report as testing and require the user to choose it explicitly.
- **Marketplace or plugin snapshot:** use it only to discover and load this Skill. It is not a Service deployment bundle and does not prove that a canonical release exists.
- **Explicit source evaluation:** require the user to choose the exact repository revision and acknowledge non-canonical, reproducibility, and working-tree risks. Inspect the commit and dirty state and run the repository's complete validation before proposing any source plan. Never fabricate an HTTPS manifest, call a source checkout stable, or use source evaluation for an existing production Instance without a separately supported plan.

If no stable release is published and the user has not explicitly chosen an available prerelease or source evaluation, report that stable deployment is not currently available and stop before local or Cloudflare writes.

## Command entry point

Run commands from this Skill directory:

```text
node scripts/cfkanban-tool.mjs help
node scripts/cfkanban-tool.mjs <command>
```

`help` returns the deploy command catalog with each command's effect and input fields. Other commands accept one structured JSON object on stdin. Credentials are never input fields; secret generation, bootstrap SQL, and authenticated verification read private files internally.

## Task-to-command map

| Goal | Command | Required handling |
| --- | --- | --- |
| Inspect host support | `capabilities` | Read-only first step. Its Wrangler probe covers PATH only and cannot decide whether the cfKanban Tool Runtime is reusable. |
| Verify a release | `release verify`, `release continuity` | Pin immutable manifest, artifact origins, versions, and digests; stop on source discontinuity. |
| Resolve Wrangler | `runtime resolve-wrangler` | Mandatory before any install decision. Prefer an explicit compatible path, then PATH, then the active cfKanban Tool Runtime. |
| Resolve Cloudflare auth | `runtime resolve-cloudflare-auth` | Always pass the resolved Wrangler path and an absolute private cfKanban deployment/config `contextDirectory` outside user Repos, including with `selectedProfile`; the directory is a controlled Wrangler cwd and is not a second frozen auth source. Never enumerate profiles or return tokens, email, bindings, resource inventories, or raw output. |
| Inspect Cloudflare login | `runtime inspect-cloudflare-auth` | Read exact Wrangler/profile/keyring/command/scope state without returning tokens or raw command output. |
| Plan and perform login | `runtime plan-cloudflare-auth`, then `runtime cloudflare-auth-action` | Freeze separate process arguments, OAuth scopes, global keyring effects, profile operation, and task digest before opening a browser or saving auth. |
| Verify Cloudflare account | `runtime wrangler-account-readback` | Run a read-only D1 listing against one exact account ID, with an explicit named profile when selected; return no database inventory. |
| Read back the target D1 | `runtime d1-resource-readback` | Return only the exact target name and verified UUID, or `absent`; never expose the account's other databases. |
| Read back the target Worker | `runtime worker-resource-readback`, `runtime worker-version-readback` | Return only the exact current single-version deployment plus a redacted binding inventory; never expose account inventory, author metadata, secrets, or raw output, and treat only Cloudflare code `10007` as absence. |
| Read D1 restore evidence | `runtime d1-restore-point-readback` | Return one bookmark without restoring. Wrangler does not report the plan retention boundary, so a migration-bearing plan must separately freeze a verified current boundary. |
| Install Tool Runtime | `runtime plan-install`, then `runtime install` | Exact version and plan digest; never modify PATH, shell profile, global Node/Wrangler, or a user Repo. |
| Plan first deployment | `plan strict-zero` | Freeze account, resource names, bindings, Owner display name, release, instance IDs, migrations, and rate gates. |
| Authorize/resume deployment | `journal create`, `journal authorize`, `plan compare` | Authorization binds the current task, operation ID, and exact normalized plan digest. |
| Generate portable config | `deployment write-wrangler-config` | Bind the verified Service bundle to the frozen Worker/account/D1 without modifying the immutable bundle. |
| Execute Cloudflare steps | `deploy wrangler-action` | Only allowlisted plan steps; read back after every write or uncertain response. |
| Validate Worker bundle | `deploy wrangler-action` with `action=validate_worker_bundle` | Run the resolved, release-compatible Wrangler with `deploy --dry-run` before the remote deploy action. |
| Bootstrap Owner | `deployment prepare-owner-credential`, `bootstrap write-owner-sql`, authorized `bootstrap_owner`, recovery `owner_bootstrap_readback` when needed, then `deployment finalize-owner` | Bind the pending secret and SQL to the exact task/plan/journal. After an uncertain attempt, retry only when the fixed read-only probe proves all six bootstrap tables are still empty. Finalize only after release/config, health, discovery, `/meta`, `/me`, Owner, Credential ID, and fingerprint all match; then write the redacted receipt. |
| Verify migrations | `migrations reconcile`, `migrations assess-ledger-recovery`, `migrations write-ledger-record-sql` | Check ordered manifest + insert-only checksum ledger + bounded schema artifacts. Checksum SQL is accepted only for the exact missing row proven recoverable by the same authorized journal and is fixed to that journal's private path. |
| Install or update canonical Skills | `plan skill-update`, `release install-skill-bundle` | Required before a canonical first deployment when no matching verified release is active; local-only atomic version switch, with no Cloudflare or D1 write. |
| Upgrade an Instance | `release install-service-bundle`, `plan instance-upgrade`, journal/deploy commands, `deployment finalize-upgrade` | Cache and re-verify the immutable Service bundle; freeze exact existing resources/current bindings, migration and restore evidence, deploy, then verify the unchanged Owner Credential and write an idempotent redacted before/after receipt. Do not update local Skills implicitly. |
| Recover lost Owner access | deployment plan/journal plus the same pending-secret and bootstrap primitives | Restore the same Principal only; this is not a Web/application endpoint. |
| Hand off to first-use setup | `cfkanban-admin` after deployment verification | Deployment alone creates no Workspace or Project; offer the next prompt but do not silently perform application writes. |

The full phase, path, recovery, and marketplace/plugin guide is [references/deployment-workflows.md](references/deployment-workflows.md).

## Cloudflare login contract

When resuming an authorized journal or maintaining an installed instance, first verify and reuse the exact profile/account already frozen there. Otherwise run `runtime resolve-cloudflare-auth` with the resolved Wrangler executable and the private deployment/config context directory. Let Wrangler apply this identity order: environment credentials, a named profile only when the user explicitly supplied it, the profile bound to the context directory, then the default profile. The resolver never lists profiles. An unrelated or stale profile is never inspected and cannot block the current or explicitly selected context.

The resolver may hold the current or explicitly selected Wrangler token only inside the bounded helper process while obtaining account memberships. The token, user email, directory bindings, Cloudflare resource lists, and raw command output never leave the helper or enter receipts. Treat returned account/profile labels only as untrusted display metadata. Handle its states exactly: `resolved` means read back the exact account; `account_selection_required` asks only for an account; `unavailable` permits either a user-supplied profile or a login proposal; `blocked` stops on the reported active/selected-context problem.

Only when `runtime resolve-cloudflare-auth` returns `unavailable` may the Agent propose a new login. Profile names identify authentication contexts, not cfKanban releases, so do not put release/version labels in newly proposed names. Propose the stable name `cfkanban`, inspect it with `runtime inspect-cloudflare-auth`, then feed that redacted result to `runtime plan-cloudflare-auth`. Show the returned plan and digest before invoking any `runtime cloudflare-auth-action`.

For an interactive local computer, prefer `named_profile_browser`. Wrangler 4.127.1 requires `auth create <name>`, with the profile name as a positional argument; `login --profile` is invalid. The planned `--scopes` values are separate process arguments: `account:read`, `user:read`, `workers_scripts:write`, and `d1:write`. Do not collapse them into one quoted argument and do not add the broader `workers:write`, KV, routes, Pages, zone, AI, or other product scopes. Cloudflare adds `offline_access` for refresh. If the consent page requires unexpected access, stop and report the delta.

For a remote or container environment where the browser cannot reach `localhost:8976`, use a preflight for the `default` profile and `default_profile_device`; Wrangler 4.127.1 does not expose device flow on `auth create`. This changes the default profile, so an existing default login requires explicit re-authentication approval. An existing named profile likewise stops unless `allowExistingProfile` is explicitly approved. Headless API-token authentication must already be supplied through the environment by the user or host; never ask for or accept the token in chat or structured Skill input.

Wrangler's keyring preference is global to every Wrangler profile for the current OS user, not private to cfKanban or one profile. Enabling it can cause existing plaintext profile credentials to migrate when next accessed; on Windows it may also download the pinned keyring backend. The plan must disclose those effects. Never disable keyring as automatic rollback because Wrangler can remove encrypted credentials for unrelated profiles. Do not run `auth activate` or create a Repo binding automatically. A deliberately selected named profile is passed explicitly with `--profile`; otherwise Wrangler resolves the current config-directory/environment context. In both cases, the generated private `wrangler.jsonc` pins `account_id`, and exact account readback is still required.

Login authorizes Wrangler and writes Wrangler/OS-owned authentication state only. It does not create a Worker, D1, deployment, directory binding, or `.cfkanban/` Credential. After every login action, rerun `runtime inspect-cloudflare-auth`, rerun `runtime resolve-cloudflare-auth` in the same private deployment context, and use `runtime wrangler-account-readback` with the exact selected account/profile. Only a successful readback can proceed to `plan strict-zero`.

## Local storage and host projections

cfKanban-managed persistent data uses one maintenance root in the current execution environment user's home:

```text
~/.cfkanban/
  instances/
  service-releases/
  skill-releases/
  tool-runtime/
```

Windows native uses the same `.cfkanban` name under that Windows user's profile home. WSL2 uses its Linux home and is a separate environment.

Agent hosts still require Skills/plugins to appear in host-owned discovery locations. A Codex plugin cache or another host's Skill directory is therefore a verified, disposable projection of the canonical bundle, not cfKanban's persistent source of truth. Do not relocate host marketplace configuration, plugin caches, Cloudflare authentication, or the host's own metadata into `.cfkanban/`.

## Official Cloudflare companion Skills

Cloudflare publishes the optional [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) platform Skill and [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) CLI Skill. When already available, use them for current Cloudflare product facts, Wrangler syntax, configuration schema, and generic troubleshooting. They are not a dependency or deployment authority for cfKanban.

Do not auto-install either companion. If the user asks to install one, treat that as a separate host-owned change and show the upstream repository, selected revision/version, scope, target discovery directory, and rollback first. Never run Wrangler's Skill-install option implicitly as part of a cfKanban deployment.

The companion Skills cannot choose a different Cloudflare product, install `wrangler@latest` into a user Repo, invoke a bare `npx wrangler`, adopt resources, or bypass this Skill's canonical release, exact compatibility range, frozen config, plan digest, journal, migration readback, and authorization rules. If current Cloudflare documentation or the pinned Wrangler schema conflicts with the verified Service bundle, stop and require a corrected release instead of editing the bundle during deployment.

## Required deployment workflow

1. Verify bootstrap, immutable manifest, origins, digests, compatibility, and publisher continuity.
2. Run `capabilities` and compare the verified Skill artifact with `installed_skill_bundle`. Its `tools.wrangler` result is explicitly PATH-only, while `installed_tool_runtime` is only an unverified receipt hint. Always run `runtime resolve-wrangler` with the verified manifest's Wrangler range before deciding that Wrangler is absent or incompatible; the resolver checks an explicit path, PATH, and the active `~/.cfkanban/tool-runtime/` in that order. Reuse a compatible result. Only when the resolver returns unavailable/incompatible may an exact Tool Runtime plan be created. If the exact canonical Skill release is not active, create `plan skill-update` with `current: null` for a first install or the redacted current receipt for an update. A matching marketplace/plugin cache never satisfies this step.
3. Before any write, show the Skill plan's source, version, digest, `~/.cfkanban/skill-releases/` target, atomic switch, and rollback. When both local installations are needed, present both plans together and obtain authorization for each exact digest before executing either. Install the Skill bundle with `release install-skill-bundle`, run `help` from the returned canonical path, and read back the active Skill receipt before continuing.
4. Reuse an exact profile/account already frozen in the authorized journal/receipt. Otherwise run `runtime resolve-cloudflare-auth` in the private deployment/config context. Let Wrangler use environment auth or that context without listing profiles. Pass `selectedProfile` only when the user explicitly names one. Ask only for an unresolved account choice. `unavailable` permits the user to supply a profile or approve a new OAuth plan; `blocked` stops. Skill or Service version changes never justify a new login. Do not bind a profile to the Repo.
5. Run `runtime wrangler-account-readback` for the selected account/profile. Wrangler does not allow `--profile` on `whoami`, so named-profile verification uses a read-only D1 probe with `CLOUDFLARE_ACCOUNT_ID` and returns no database inventory; stop if an environment credential would shadow that profile.
6. Generate and freeze the complete deployment or upgrade plan. Resolve account ambiguity and Owner display name before authorization.
7. Before requesting deployment authorization, run both `runtime d1-resource-readback` and `runtime worker-resource-readback` for the exact frozen names. Both must return `absent`; a present or unclassifiable target stops the plan, and the user may instead approve newly proposed names. The read-only wrappers disable Wrangler disk logs and return no account inventory.
8. Create the operation journal and request one approval for the complete task/operation/digest. The plan's `owner_bootstrap.recovery_authorization` makes guarded zero-state recovery part of that same approval. Do not phrase the authorization as a one-command or one-attempt approval; that would accidentally remove the resumability the plan promises. If the user independently narrows the approval, honor that narrower boundary.
9. Immediately before D1 creation, require its exact readback to remain `absent`. The pinned Wrangler `d1 create` command has no JSON flag, so `action=create_d1` deliberately omits `--json` and fixes the account through `CLOUDFLARE_ACCOUNT_ID`. Never parse its human output for the UUID. After success or failure, run the exact-name readback again; only a successful create plus one verified exact match supplies the D1 ID for the private config. A failed command followed by a present resource is ambiguous and must stop rather than adopt it.
10. Generate the private Wrangler config from the verified bundle. Execute only plan-listed actions, reconcile ledger checksums and schema artifacts before and after migrations, and run the allowlisted Worker dry run. Migration SELECT readback uses `d1 execute --command --json`. Generated checksum and Owner-bootstrap SQL use remote `d1 execute --file`, rely on that ingestion path's transaction boundary, and must not contain explicit SQL transaction control. A missing checksum row remains a stop unless `migrations assess-ledger-recovery` proves that this same authorized journal recorded a successful non-destructive apply and a later exact readback shows complete expected schema, the absent row, and no other drift. Then write only that insert-only row, execute it under the same journal, and read back and reconcile again.
11. Immediately before Worker deployment, require its exact readback to remain `absent`. After a successful deploy, require it to return `present`. Use `deployment prepare-owner-credential` so the private pending Credential is derived from the authorized Owner IDs rather than caller-supplied IDs. `bootstrap write-owner-sql` must recheck the journal, frozen config, complete migration readback, successful Worker deployment, exact origin, and pending Credential before journaling the SQL digest; `action=bootstrap_owner` accepts only that exact private file. Start with one remote bootstrap attempt. After a failed, interrupted, or response-uncertain attempt, run `action=owner_bootstrap_readback`. Its fixed `SELECT` returns only bounded row counts for the six tables touched by bootstrap and disables Wrangler disk logs. A newer `absent` result permits exactly one retry of the same SQL under the existing full-plan authorization; do not ask the user to repeat a technical confirmation when task, operation, plan, config, SQL, Credential, and target have not drifted. `present_or_partial`, a successful prior attempt, malformed output, a missing newer readback, or any drift forbids retry and requires finalization/readback, a stop, or new authorization for the changed plan.
12. Run `deployment finalize-owner` with the same plan/config and verified release files. It re-verifies the public health/discovery response and authenticated `/api/v1/meta` plus `/api/v1/me`, including exact Instance ID, origin, Service/schema versions, Owner flag, Principal ID, Credential ID, and fingerprint. Only then may it write trusted instance metadata, promote pending to current, and create an idempotent redacted deployment receipt. A partial local finalization resumes from the exact current Credential and never generates a second secret.
13. On interruption or uncertain response, read back both exact resources, journal, migration ledger, schema, and public instance marker before resuming.

## Definition of a usable first installation

A verified Worker and D1 are the deployment result, but the user still has no board until application setup is complete. End the deployment report with the verified instance URL/ID, Owner Principal/fingerprint, redacted receipt/journal identifiers, and a clear next action: use `cfkanban-admin` to verify Owner identity, create one explicitly named Workspace and Project, read both back, and create an Owner Web launch. Creating those resources is a separate application workflow and must not be hidden inside deployment.

## Contract and stop conditions

- **MUST:** Marketplace/plugin is a discovery and installation convenience; it never overrides canonical publisher, manifest, artifact origins, or digests.
- **MUST:** Cloudflare companion Skills and Wrangler Skill installation are optional host-owned changes; they never run implicitly and never replace the cfKanban deployment contract.
- **MUST:** Cloudflare login uses the structured auth preflight and task-bound plan; OAuth scopes remain separate process arguments, and global keyring/profile effects are shown before execution.
- **MUST:** Before proposing login, reuse the journal/receipt's exact verified auth target or run `runtime resolve-cloudflare-auth` in the private deployment context. Let Wrangler resolve environment/context identity, never enumerate profiles, and inspect a named profile only when the user explicitly supplies it.
- **MUST:** Never interpret `capabilities.tools.wrangler` as the final availability result. Run `runtime resolve-wrangler` with the verified release range and reuse a compatible active Tool Runtime before proposing installation.
- **MUST:** `create_d1` uses the pinned Wrangler syntax without `--json`, fixes the frozen account ID in the child environment, and obtains the database UUID only through `runtime d1-resource-readback` after the command.
- **MUST:** Both frozen resource names use their exact readback commands before authorization and again immediately before their write; Worker absence is recognized only from Cloudflare machine code `10007`, and all other failures stop.
- **MUST:** Migration readback uses the fixed bounded SQL through `d1 execute --command --json`, validates exactly two successful result sets, and returns only normalized ledger/table/index facts; never use remote `--file` for SELECT evidence.
- **MUST:** Remote `d1 execute --file` provides the transaction boundary for generated checksum/bootstrap SQL; those files contain no explicit `BEGIN`, `COMMIT`, `ROLLBACK`, or `SAVEPOINT`. Missing-ledger recovery is limited to the same authorized journal proof described above and can never baseline arbitrary existing schema.
- **MUST:** Owner Credential preparation, bootstrap SQL, every D1 bootstrap attempt and its newer zero-state recovery readback, authenticated identity readback, pending-to-current promotion, and deployment receipt all remain bound to the same authorized task/operation/plan. `/me` alone is insufficient for deployment finalization: exact discovery and `/meta` must also prove the Instance, origin, Service/schema, Owner Principal, Credential ID, and fingerprint.
- **MUST:** Request deployment approval at full-plan scope. Guarded Owner-bootstrap recovery is included in the plan and does not need per-attempt application-level confirmation when all bound facts remain unchanged. Never turn the approval request into an accidental single-process-attempt limit; an explicit user-authored narrower limit still controls.
- **MUST:** A verified Cloudflare profile/account remains reusable across releases. New profile names do not contain cfKanban Skill or Service version labels.
- **MUST:** Use current Cloudflare documentation and the pinned Wrangler config schema to detect drift, but never mutate an immutable Service bundle in place to follow generic advice.
- **MUST:** Windows native and WSL2 never auto-discover, execute, copy, or share Node, Wrangler, Cloudflare auth, Skills, Tool Runtime, or `.cfkanban/` state.
- **MUST:** Any cost, account, permission, DNS/domain, destructive migration, resource adoption/replacement, secret, binding, or plan-digest delta requires new authorization.
- **MUST:** Worker rollback never claims to roll back D1. D1 restore is destructive, never automatic, and needs new authorization.
- **MUST:** Skill update and Instance upgrade are separate planes; checking both never authorizes or executes either.
- **DECIDES:** The user chooses Node installation method, ambiguous Cloudflare account, custom domain, paid capability, compliance location, non-stable source, and destructive recovery.

Stop on origin/digest mismatch, publisher discontinuity, missing or unverified canonical Skill installation, an unreadable effective/selected Cloudflare auth context, unknown same-name resources, account ambiguity, missing Owner display name, unverified storage, incompatible Node/Wrangler without an approved plan, plan drift, migration checksum/schema drift outside the exact same-journal recovery rule, unavailable restore evidence, partial migration state, or any request to adopt an unknown resource silently. Unrelated profiles are outside the selected context and do not create a blocker.
