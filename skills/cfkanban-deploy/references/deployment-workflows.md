# Deployment and update workflows

Language: [English](deployment-workflows.md) | [简体中文](deployment-workflows.zh-CN.md)

Run `node scripts/cfkanban-tool.mjs help` from the Skill directory before planning. The catalog reports every deploy command, its effect, and accepted input fields for the installed release.

## Storage ownership

All persistent state owned by cfKanban uses one current-environment user root:

```text
~/.cfkanban/
  instances/<instance_id>/
    credentials/
    journals/
    receipts/
  skill-releases/
  tool-runtime/
```

- `instances/` contains trusted-origin metadata, private Credentials, operation journals, and redacted receipts.
- `skill-releases/` contains verified immutable Skill bundle versions plus an atomic active pointer and previous known-good version.
- `tool-runtime/` contains the exact cfKanban-managed Wrangler npm package and its dependencies when a compatible user-owned Wrangler is unavailable. It uses the current environment's compatible user-owned Node.js, never contains or installs Node.js, and is never added to PATH.

Windows native places `.cfkanban` under the current Windows profile home. WSL2 uses the current Linux home. They are separate execution environments and never discover, call, copy, or share these directories automatically.

The shared root is a maintenance boundary, not permission flattening: secret files retain stricter checks, broad recursive cleanup is forbidden, and each subdirectory keeps its own receipt/version lifecycle.

## Why some files still appear in host directories

Agent hosts discover Skills and plugins only in host-defined locations. Codex, for example, maintains marketplace configuration and plugin/cache projections in its own directories. Other hosts may require personal or project Skill folders.

Those host-owned files are verified discovery projections of the canonical Skill release; they are not cfKanban's persistent source of truth and contain no cfKanban Credential. The install flow may create/update a projection only after an explicit source/version/digest plan. Removing a host projection disables discovery for that host but does not delete `~/.cfkanban/` state or the verified release copy.

Marketplace/plugin installation is supported as a convenience entry point. It never overrides the canonical HTTPS publisher, immutable manifest, artifact origin allowlist, SHA-256 digest, or installed receipt. A marketplace update is not automatic authorization to install, update a Skill, deploy, or upgrade an Instance.

## Before the first canonical release

A repository marketplace can make this Skill discoverable before the project publishes its first canonical release. That does **not** make a stable deployment target available.

For a read-only check, report the missing canonical bootstrap/manifest plainly and stop. Do not invent a release URL, give `release verify` a synthetic HTTPS manifest, treat a plugin cache as the Service bundle, or fall back to the current working tree.

An explicit source evaluation is a separate engineering mode. Before any plan, record the repository URL, exact commit, branch/tag only as a human-readable aid, dirty/untracked state, lockfile state, validation command/result, and the fact that publisher continuity and canonical release guarantees do not apply. A mutable branch name alone is not a reproducible source. If the installed Skill release does not provide a source-specific plan that freezes those facts, stop before local installation, Credential generation, or Cloudflare writes. Never reuse a source experiment as an unlabelled upgrade of an existing Instance.

## Cloudflare upstream alignment

Cloudflare maintains two useful optional companions in its own repository:

- [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) routes broad platform questions and requires retrieval from current Cloudflare documentation.
- [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) covers current CLI syntax, configuration, D1 migrations, dry runs, and secret handling.

Use them when already installed, or guide a user to the [upstream installation instructions](https://github.com/cloudflare/skills#installing) only after the user asks for that separate host change. Record the selected repository revision/version, installation scope, host discovery target, and rollback. Do not auto-install them, do not invoke Wrangler's `--install-skills` option during a cfKanban operation, and do not place their host projections under `~/.cfkanban/`.

These companions are current platform references, not cfKanban orchestration dependencies. Generic advice such as installing `wrangler@latest` in the current project, using a bare `npx wrangler`, selecting Pages or automatic provisioning, or deploying immediately is intentionally overridden here by the verified release's compatible Wrangler range, resolved absolute executable, one Worker + one D1 + Static Assets topology, frozen plan, journal, and readback rules. If current Cloudflare docs or the pinned config schema show that the Service bundle is no longer valid, stop and publish a corrected immutable release; never patch the verified bundle in place.

## Cloudflare authentication

Authentication is its own planned boundary between Tool Runtime preparation and the strict-zero deployment plan. A simple user request remains sufficient; the Agent owns these details:

1. Choose a collision-free profile name for local interactive use, or `default` for a device-flow environment. Run `runtime inspect-cloudflare-auth` with the resolved absolute Wrangler executable and that profile name. It checks the exact Wrangler version, command support, keyring preference, profile existence, required scope catalog, and environment-variable shadowing without returning a token, credential path, profile list, or raw Wrangler output.
2. If `safe_to_plan` is false, report its blocker codes and stop. Do not switch to bare `npx`, a different profile, plaintext storage, or a wider scope set as a workaround.
3. Run `runtime plan-cloudflare-auth` with the current Agent task ID, selected mode, and the unchanged preflight result. Existing profiles stop by default; re-authentication requires `allowExistingProfile: true` and an explicit explanation that the existing login will be replaced.
4. Show the plan digest and every action. Only after the user authorizes that exact plan, invoke each `runtime cloudflare-auth-action` in order. Each action is revalidated against the digest and spawned without a shell. The wrapper disables Wrangler disk logs for these auth actions and never returns raw auth output or an OAuth token.
5. Run the inspection again, then run `runtime wrangler-account-readback` for one exact account ID and the selected named profile, or with no profile for the default login. Only the readback can advance to the deployment plan.

The modes are:

| Environment | `mode` | Exact Wrangler behavior | Important boundary |
| --- | --- | --- | --- |
| Local interactive computer | `named_profile_browser` | `auth create <name>` with a localhost browser callback | Named profiles are experimental in Wrangler 4.127.1. `login --profile` is invalid. No directory binding is created. |
| Local interactive default profile | `default_profile_browser` | `login` with a localhost browser callback | Replaces/re-authenticates the default profile when it already exists. |
| Remote SSH or container | `default_profile_device` | `login --device --browser=false` | Wrangler 4.127.1 does not offer device flow on `auth create`, so this uses the default profile and no callback host/port. |
| Non-interactive/headless | existing environment API token | No OAuth action is planned | The user or host supplies it outside Skill input. Never request, echo, persist, or copy the token. It shadows profiles. |

The OAuth plan requests only these four scopes, each as a separate process argument after one `--scopes` flag:

| Scope | Why cfKanban needs it |
| --- | --- |
| `account:read` | Resolve and verify the selected account membership. |
| `user:read` | Complete Wrangler identity/account discovery. |
| `workers_scripts:write` | Upload the Worker, bundled Static Assets, bindings, subdomain, and triggers used by the verified Service bundle. |
| `d1:write` | Create, migrate, query, and bind the single D1 database. |

Cloudflare automatically adds `offline_access` so Wrangler can refresh the OAuth login. The plan deliberately omits the broad `workers:write` scope and separate KV, routes, Pages, zone, AI, Queue, R2, DNS, and other product scopes. If Wrangler no longer exposes one of the four required scopes, or the Cloudflare consent surface requires an unexpected scope, stop and require a corrected release; do not widen access in place.

Wrangler's keyring setting is global for every Wrangler profile owned by the current OS user. Enabling it is therefore shown as a separate action when the persisted preference is off. Existing plaintext profiles may migrate to encrypted files when next accessed; macOS uses Keychain, Linux requires a reachable secret-service backend, and Windows may perform a one-time download of Wrangler's pinned keyring binding. These effects are outside `~/.cfkanban/`. Never disable keyring automatically on rollback: Wrangler can delete encrypted credentials belonging to unrelated profiles. Profile deletion/logout and any keyring change are separate, newly authorized cleanup actions.

Do not use `wrangler auth activate`. It writes a directory binding and makes behavior depend on the current Repo. Every cfKanban command instead carries the selected `--profile` explicitly and pins `account_id` in the generated private Wrangler config. Cloudflare login alone creates no Worker, D1, deployment, cfKanban Credential, or Repo file.

## Command map

| Phase | Commands | Result |
| --- | --- | --- |
| Host preflight | `capabilities` | Read-only environment and path report. |
| Release trust | `release verify`, `release continuity` | Verified immutable manifest/artifacts and publisher continuity decision. |
| Canonical Skill install | `plan skill-update`, `release install-skill-bundle` | Exact first-install/update plan, immutable version directory, atomic active pointer, and readback under `.cfkanban/skill-releases`. |
| Wrangler selection | `runtime resolve-wrangler` | Explicit compatible path, compatible PATH path, or missing/incompatible result. |
| Cloudflare auth inspection | `runtime inspect-cloudflare-auth` | Redacted command/profile/keyring/scope facts and blockers; no token or raw output. |
| Cloudflare auth plan/action | `runtime plan-cloudflare-auth`, `runtime cloudflare-auth-action` | Task-bound digest, shell-free argument arrays, explicit global keyring effect, OAuth consent, and required readback. |
| Cloudflare account | `runtime wrangler-account-readback` | Read-only D1 access proof for one exact account/profile; database inventory is discarded. |
| Tool Runtime plan/install | `runtime plan-install`, `runtime install` | Exact local-only plan and authorized installation under `.cfkanban/tool-runtime`. |
| Initial plan | `plan strict-zero` | Frozen plan and normalized digest. |
| Plan drift | `plan compare` | Exact deltas and whether new authorization is required. |
| Journal | `journal create`, `journal authorize` | Resumable operation bound to task, operation ID, and digest. |
| Portable config | `deployment write-wrangler-config` | Private config bound to the verified bundle, frozen account/Worker, and created D1. |
| Cloudflare step | `deploy wrangler-action` | One allowlisted Wrangler action plus redacted result summary. |
| Worker validation | `deploy wrangler-action` with `action=validate_worker_bundle` | `wrangler deploy --dry-run` using the same config and executable intended for deployment. |
| Owner bootstrap | `credential prepare`, `bootstrap write-owner-sql`, `credential verify-and-promote` | Pending secret plus hash-only SQL, followed by internal `/me` verification; none reveals the token. |
| Migration proof | `migrations reconcile`, `migrations write-ledger-record-sql` | Ledger/schema consistency and insert-only checksum record. |
| Skill update | `plan skill-update`, `release install-skill-bundle` | New verified local version and atomic active pointer. |
| Instance upgrade | `plan instance-upgrade` plus journal/deploy/migration commands | Independent pinned Cloudflare upgrade. |
| Local readback | `state inspect`, `origin rebind-check`, `api request` | Redacted state, trusted origin continuity, and authenticated health/identity checks. |

Commands accept structured JSON on stdin. Credential generation and loading remain internal. The `.mjs` entrypoint is ordinary Node JavaScript in explicit ES module format; it runs directly with `node`, requires no build step, and stays portable outside a `package.json` tree.

## First deployment

1. Read the canonical bootstrap as a document. Resolve the stable pointer to one immutable release manifest, or use a prerelease pointer only after the user explicitly chooses testing.
2. Run `release verify` for both Skill and Service deployment bundles, then compare publisher/origin continuity with any receipt.
3. Run `capabilities`. Compare the verified Skill artifact with `installed_skill_bundle`; on a first install, `plan skill-update` must use `current: null`, while an update uses only the redacted current receipt. A matching plugin or marketplace cache remains only a host projection and never allows this step to be skipped. Reuse compatible Node and Wrangler; if Wrangler is absent/incompatible, create `runtime plan-install`.
4. Show the Skill plan's canonical source/version/digest, `.cfkanban/skill-releases` target, atomic switch, and rollback. If both local prerequisites are needed, show the Skill and Tool Runtime plans together, including both digests, before requesting one user decision covering those exact writes. After authorization, install the canonical Skill bundle first, run `help` from the returned installed path, and verify the active receipt before installing or resolving Wrangler.
5. If Cloudflare auth is not already usable, inspect it and generate the task-bound OAuth plan. Show the profile operation, four requested scopes, global keyring effect, browser/device interaction, local storage owner, and exact digest. Execute only authorized `runtime cloudflare-auth-action` entries, then inspect again. Never use `login --profile`, quote all scopes as one argument, bind the profile to the Repo, or add broad product scopes.
6. Run `runtime wrangler-account-readback` with the exact account ID and optional named profile; a bare `npx` is forbidden because it may download an unpinned latest Wrangler. Since Wrangler does not support `--profile` on `whoami`, the command uses read-only `d1 list --json`, fixes the account through `CLOUDFLARE_ACCOUNT_ID`, discards the database inventory, and stops when an environment credential would shadow the requested profile.
7. Run `plan strict-zero`. The default candidate contains one Worker, one D1, bundled Static Assets, `workers.dev`, no optional Cloudflare products, and 120/300/30 request gates per 60 seconds. Freeze the selected Cloudflare profile/account and resolve missing Owner display name before freezing the digest.
8. Create the journal and present the entire plan. `journal authorize` records approval only for the current Agent task, operation ID, and digest.
9. Execute only allowlisted `deploy wrangler-action` steps. Create D1 explicitly; automatic provisioning is not used. Unknown same-name resources are never adopted; a collision proposes a different name.
10. Run `deployment write-wrangler-config` with the created D1 ID. The bundle's `wrangler.template.json` is only a schema-checked skeleton with placeholder resource identities and must never be deployed unchanged. The command writes a private actual config outside the immutable bundle, points to the bundle's built Worker/Static Assets/migrations, and freezes account, names, bindings, compatibility date, and rate gates.
11. Before data bootstrap, create the pending Owner Credential and hash-only bootstrap SQL. The plaintext token never enters the plan, SQL, stdout, command arguments, environment, logs, or receipt.
12. Initialize the checksum ledger and use Cloudflare's standard `wrangler d1 migrations apply --remote` behavior. It applies pending files sequentially; reconcile the cfKanban checksum ledger plus actual schema after the command or any uncertain result.
13. Run `validate_worker_bundle` with the exact generated config and resolved Wrangler. A successful dry run is required but is not deployment authorization or remote-write proof.
14. Deploy, then verify Worker health, public instance discovery, bindings, migration/schema state, and `/api/v1/me`. Only then promote the pending Owner Credential and write a redacted receipt.

### Handoff to a usable board

The first deployment creates infrastructure and the Deployment Owner, but it intentionally creates no Workspace, Project, Label, Grant, or Issue. The final report must offer the simple next prompt, “Use `$cfkanban-admin` to create my first cfKanban board.” The Admin Skill owns Owner verification, the missing-name questions, the two read-backed atomic creates, and the Browser Launch workflow. Do not make the user encode those steps in their prompt or hide the application writes inside the Cloudflare deployment authorization.

## Interruption and resume

An Agent task, normalized plan digest, and operation ID define one authorization. The same task may resume unchanged planned work, but a new task or any plan delta requires new authorization.

After timeout, response loss, Agent restart, or partial execution:

1. Load the journal; do not infer progress from a previous command's exit code alone.
2. Read Cloudflare resource markers and verify account/type/`instance_id` ownership.
3. Read the migration checksum ledger and bounded `sqlite_master` artifacts with the Service bundle's fixed read-only SQL.
4. Compare the frozen plan and current state. Continue only an allowlisted incomplete step with no drift.

Never log raw Wrangler output without redaction. Never retry a create with new identifiers while the prior commit remains uncertain.

## Skill update

A Skill update is local only:

1. Verify target manifest, bundle digest, compatibility, and publisher continuity.
2. Create `plan skill-update`; it must report no Cloudflare writes.
3. Install into a new immutable directory under `.cfkanban/skill-releases`.
4. Run a no-side-effect discovery/help smoke.
5. Atomically switch the active pointer and retain the previous known-good version.
6. Update the host-owned marketplace/plugin/Skill projection only as an explicit install step.

Failure before pointer switch leaves the active version unchanged. This operation never upgrades a deployed Instance.

## Instance upgrade

An Instance upgrade is a separate Cloudflare plan:

1. Pin the Service deployment bundle and compatibility matrix; inspect current Worker/D1 markers and bindings.
2. Obtain a Cloudflare restore point/bookmark as evidence when required. The Skill does not execute Time Travel restore.
3. Create `plan instance-upgrade` with exact Worker, binding, and ordered migration deltas.
4. Authorize and journal the exact digest; apply one migration at a time with before/after ledger and schema readback.
5. Verify the deployed Service after the final step. Do not update local Skills implicitly.

Destructive migrations, missing restore evidence, unknown baseline, partial schema artifacts, checksum drift, resource deletion/replacement, DNS/domain changes, or cost/permission changes leave the normal upgrade path and require a new explicit plan.

Worker rollback does not roll back D1. D1 restore is destructive, never automatic, and always needs new authorization. The deploy Skill does not provide full D1 export/import, one-click restore, local disaster-recovery rehearsal, or automatic Time Travel restore.

## Stop conditions

Stop on canonical origin/digest mismatch, publisher discontinuity, unverified storage, Node/Wrangler incompatibility without an approved plan, mixed Windows/WSL tooling, authentication preflight blockers, existing-profile collision without explicit re-authentication approval, unexpected OAuth scope, account ambiguity, missing Owner display name, unknown resource ownership, plan drift, migration checksum/schema drift, partial application, or unavailable restore evidence. Loading the Skill or installing its marketplace/plugin entry is never deployment authorization.
