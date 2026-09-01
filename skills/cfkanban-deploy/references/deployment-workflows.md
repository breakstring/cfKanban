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
- `tool-runtime/` contains the exact cfKanban-managed Wrangler dependency when a compatible user-owned Wrangler is unavailable. It is never added to PATH.

Windows native places `.cfkanban` under the current Windows profile home. WSL2 uses the current Linux home. They are separate execution environments and never discover, call, copy, or share these directories automatically.

The shared root is a maintenance boundary, not permission flattening: secret files retain stricter checks, broad recursive cleanup is forbidden, and each subdirectory keeps its own receipt/version lifecycle.

## Why some files still appear in host directories

Agent hosts discover Skills and plugins only in host-defined locations. Codex, for example, maintains marketplace configuration and plugin/cache projections in its own directories. Other hosts may require personal or project Skill folders.

Those host-owned files are verified discovery projections of the canonical Skill release; they are not cfKanban's persistent source of truth and contain no cfKanban Credential. The install flow may create/update a projection only after an explicit source/version/digest plan. Removing a host projection disables discovery for that host but does not delete `~/.cfkanban/` state or the verified release copy.

Marketplace/plugin installation is supported as a convenience entry point. It never overrides the canonical HTTPS publisher, immutable manifest, artifact origin allowlist, SHA-256 digest, or installed receipt. A marketplace update is not automatic authorization to install, update a Skill, deploy, or upgrade an Instance.

## Cloudflare upstream alignment

Cloudflare maintains two useful optional companions in its own repository:

- [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) routes broad platform questions and requires retrieval from current Cloudflare documentation.
- [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) covers current CLI syntax, configuration, D1 migrations, dry runs, and secret handling.

Use them when already installed, or guide a user to the [upstream installation instructions](https://github.com/cloudflare/skills#installing) only after the user asks for that separate host change. Record the selected repository revision/version, installation scope, host discovery target, and rollback. Do not auto-install them, do not invoke Wrangler's `--install-skills` option during a cfKanban operation, and do not place their host projections under `~/.cfkanban/`.

These companions are current platform references, not cfKanban orchestration dependencies. Generic advice such as installing `wrangler@latest` in the current project, using a bare `npx wrangler`, selecting Pages or automatic provisioning, or deploying immediately is intentionally overridden here by the verified release's compatible Wrangler range, resolved absolute executable, one Worker + one D1 + Static Assets topology, frozen plan, journal, and readback rules. If current Cloudflare docs or the pinned config schema show that the Service bundle is no longer valid, stop and publish a corrected immutable release; never patch the verified bundle in place.

## Command map

| Phase | Commands | Result |
| --- | --- | --- |
| Host preflight | `capabilities` | Read-only environment and path report. |
| Release trust | `release verify`, `release continuity` | Verified immutable manifest/artifacts and publisher continuity decision. |
| Wrangler selection | `runtime resolve-wrangler` | Explicit compatible path, compatible PATH path, or missing/incompatible result. |
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

1. Read the canonical bootstrap as a document. Resolve the stable pointer to one immutable release manifest.
2. Run `release verify` for both Skill and Service deployment bundles, then compare publisher/origin continuity with any receipt.
3. Run `capabilities`. Reuse compatible Node and Wrangler. If Wrangler is absent/incompatible, create and present `runtime plan-install`; install only after exact authorization. Run `runtime wrangler-account-readback` with the exact account ID and optional named profile; a bare `npx` is forbidden because it may download an unpinned latest Wrangler. Since Wrangler does not support `--profile` on `whoami`, the command uses read-only `d1 list --json`, fixes the account through `CLOUDFLARE_ACCOUNT_ID`, discards the database inventory, and stops when an environment credential would shadow the requested profile.
4. Run `plan strict-zero`. The default candidate contains one Worker, one D1, bundled Static Assets, `workers.dev`, no optional Cloudflare products, and 120/300/30 request gates per 60 seconds. Freeze the selected Cloudflare profile/account and resolve missing Owner display name before freezing the digest.
5. Create the journal and present the entire plan. `journal authorize` records approval only for the current Agent task, operation ID, and digest.
6. Execute only allowlisted `deploy wrangler-action` steps. Create D1 explicitly; automatic provisioning is not used. Unknown same-name resources are never adopted; a collision proposes a different name.
7. Run `deployment write-wrangler-config` with the created D1 ID. It writes a private config outside the immutable bundle, points to the bundle's built Worker/Static Assets/migrations, and freezes account, names, bindings, compatibility date, and rate gates.
8. Before data bootstrap, create the pending Owner Credential and hash-only bootstrap SQL. The plaintext token never enters the plan, SQL, stdout, command arguments, environment, logs, or receipt.
9. Initialize the checksum ledger and use Cloudflare's standard `wrangler d1 migrations apply --remote` behavior. It applies pending files sequentially; reconcile the cfKanban checksum ledger plus actual schema after the command or any uncertain result.
10. Run `validate_worker_bundle` with the exact generated config and resolved Wrangler. A successful dry run is required but is not deployment authorization or remote-write proof.
11. Deploy, then verify Worker health, public instance discovery, bindings, migration/schema state, and `/api/v1/me`. Only then promote the pending Owner Credential and write a redacted receipt.

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

Stop on canonical origin/digest mismatch, publisher discontinuity, unverified storage, Node/Wrangler incompatibility without an approved plan, mixed Windows/WSL tooling, account ambiguity, missing Owner display name, unknown resource ownership, plan drift, migration checksum/schema drift, partial application, or unavailable restore evidence. Loading the Skill or installing its marketplace/plugin entry is never deployment authorization.
