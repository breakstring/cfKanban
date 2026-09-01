---
name: cfkanban-deploy
description: Install, inspect, deploy, resume, and upgrade cfKanban on Cloudflare with canonical release verification, strict-zero plans, migration readback, journals, Tool Runtime isolation, and out-of-band Owner recovery.
---

# cfKanban Deploy

Use this Skill for the Cloudflare control plane and local Skill lifecycle. For the same operational guide in Simplified Chinese, read [references/deployment-workflows.zh-CN.md](references/deployment-workflows.zh-CN.md).

## What this Skill can do

- Verify a canonical bootstrap pointer, immutable release manifest, allowed artifact origins, SHA-256 digests, and publisher continuity.
- Inspect Node, Wrangler, OS, storage, and host capabilities without changing them.
- Read the selected Wrangler authentication profile and Cloudflare account before freezing a plan.
- Plan and install an isolated Wrangler Tool Runtime when no compatible user-owned Wrangler exists.
- Produce, authorize, execute, resume, and verify a strict-zero deployment: one Worker, one D1, bundled Static Assets, and `workers.dev` by default.
- Generate a private portable Wrangler configuration from the verified Service bundle and validate it with `wrangler deploy --dry-run` before deployment.
- Reconcile migration manifest checksums, the remote ledger, and actual D1 schema artifacts.
- Update local Skills and upgrade a deployed Instance as two independent operations.
- Perform controlled out-of-band recovery for the same Owner Principal after total Owner Credential loss.

Loading this Skill is not authorization to install software, change local state, create cloud resources, migrate data, change DNS, recover an Owner, publish, or upgrade.

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
| Inspect host support | `capabilities` | Read-only first step; report unavailable, unknown, unsupported, and permission-denied separately. |
| Verify a release | `release verify`, `release continuity` | Pin immutable manifest, artifact origins, versions, and digests; stop on source discontinuity. |
| Resolve Wrangler | `runtime resolve-wrangler` | Prefer explicit compatible path, then PATH, then an authorized Tool Runtime. |
| Verify Cloudflare account | `runtime wrangler-account-readback` | Run a read-only D1 listing against one exact account ID, with an explicit named profile when selected; return no database inventory. |
| Install Tool Runtime | `runtime plan-install`, then `runtime install` | Exact version and plan digest; never modify PATH, shell profile, global Node/Wrangler, or a user Repo. |
| Plan first deployment | `plan strict-zero` | Freeze account, resource names, bindings, Owner display name, release, instance IDs, migrations, and rate gates. |
| Authorize/resume deployment | `journal create`, `journal authorize`, `plan compare` | Authorization binds the current task, operation ID, and exact normalized plan digest. |
| Generate portable config | `deployment write-wrangler-config` | Bind the verified Service bundle to the frozen Worker/account/D1 without modifying the immutable bundle. |
| Execute Cloudflare steps | `deploy wrangler-action` | Only allowlisted plan steps; read back after every write or uncertain response. |
| Validate Worker bundle | `deploy wrangler-action` with `action=validate_worker_bundle` | Run the resolved, release-compatible Wrangler with `deploy --dry-run` before the remote deploy action. |
| Bootstrap Owner | `credential prepare`, `bootstrap write-owner-sql`, authorized D1/Worker steps, then `credential verify-and-promote` | Generate the secret only after plan authorization; SQL contains only digest/prefix; promote only after `/me` verifies it. |
| Verify migrations | `migrations reconcile`, `migrations write-ledger-record-sql` | Check ordered manifest + insert-only checksum ledger + bounded schema artifacts; command success alone is insufficient. |
| Update local Skills | `plan skill-update`, `release install-skill-bundle` | Local-only atomic version switch; no Cloudflare or D1 write. |
| Upgrade an Instance | `plan instance-upgrade`, journal and deploy commands | Pin Service bundle and restore evidence; do not update local Skills implicitly. |
| Recover lost Owner access | deployment plan/journal plus the same pending-secret and bootstrap primitives | Restore the same Principal only; this is not a Web/application endpoint. |

The full phase, path, recovery, and marketplace/plugin guide is [references/deployment-workflows.md](references/deployment-workflows.md).

## Local storage and host projections

cfKanban-managed persistent data uses one maintenance root in the current execution environment user's home:

```text
~/.cfkanban/
  instances/
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
2. Run `capabilities`; reuse compatible user-owned Node/Wrangler or present an exact Tool Runtime plan. Run `runtime wrangler-account-readback` for the selected account/profile. Wrangler does not allow `--profile` on `whoami`, so named-profile verification uses a read-only D1 probe with `CLOUDFLARE_ACCOUNT_ID` and returns no database inventory; stop if an environment credential would shadow that profile.
3. Generate and freeze the complete deployment or upgrade plan. Resolve account ambiguity and Owner display name before authorization.
4. Create the operation journal and record approval only for the exact task/operation/digest.
5. Create D1, generate the private Wrangler config from the verified bundle, reconcile/apply migrations with the standard D1 migration command, then run the allowlisted Worker dry run.
6. Execute only plan-listed actions. Before and after migrations, reconcile ledger checksums and schema artifacts.
7. On interruption or uncertain response, read back remote markers, journal, migration ledger, and schema before resuming.
8. Verify health, public discovery, schema, bindings, and `/api/v1/me`; then write only a redacted receipt and promote the pending Owner Credential.

## Contract and stop conditions

- **MUST:** Marketplace/plugin is a discovery and installation convenience; it never overrides canonical publisher, manifest, artifact origins, or digests.
- **MUST:** Cloudflare companion Skills and Wrangler Skill installation are optional host-owned changes; they never run implicitly and never replace the cfKanban deployment contract.
- **MUST:** Use current Cloudflare documentation and the pinned Wrangler config schema to detect drift, but never mutate an immutable Service bundle in place to follow generic advice.
- **MUST:** Windows native and WSL2 never auto-discover, execute, copy, or share Node, Wrangler, Cloudflare auth, Skills, Tool Runtime, or `.cfkanban/` state.
- **MUST:** Any cost, account, permission, DNS/domain, destructive migration, resource adoption/replacement, secret, binding, or plan-digest delta requires new authorization.
- **MUST:** Worker rollback never claims to roll back D1. D1 restore is destructive, never automatic, and needs new authorization.
- **MUST:** Skill update and Instance upgrade are separate planes; checking both never authorizes or executes either.
- **DECIDES:** The user chooses Node installation method, ambiguous Cloudflare account, custom domain, paid capability, compliance location, non-stable source, and destructive recovery.

Stop on origin/digest mismatch, publisher discontinuity, unknown same-name resources, account ambiguity, missing Owner display name, unverified storage, incompatible Node/Wrangler without an approved plan, plan drift, migration checksum/schema drift, unavailable restore evidence, partial migration state, or any request to adopt an unknown resource silently.
