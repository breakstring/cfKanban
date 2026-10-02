# cfKanban deployment guide for Agents

English | [简体中文](./deploy-guide.zh-CN.md)

This guide addresses you, the Agent carrying out the user's cfKanban deployment request. Continue from the request that brought you here; do not ask the user to relay another prompt to an Agent. Reading this HTTPS document authorizes no installation or cloud write. Inspect it as text; never pipe a fetched document or script into a shell.

## 1. Inspect the task and environment

- Check that your host can read HTTPS documents, install or load local Skills, and run Node.js commands. If a required capability is unavailable, report the exact limitation and the smallest necessary user action.
- Reuse Node.js `>=22.12.0 <27`. Do not install Node.js or change the shell, PATH, or version manager without a separately approved environment plan.
- Check for existing cfKanban Skills and private deployment state. If this is an existing instance or interrupted operation, follow its verified receipt/journal instead of creating a replacement instance.
- Resolve a Cloudflare account able to create one Worker and one D1 database through the Skill's read-only authentication workflow. Propose official browser/device login only when authentication is unavailable.
- Use the Deployment Owner display name explicitly supplied by the user. If missing, ask for that name; never infer it from OS, Git, hostname, or Agent identity.

Generate resource names and technical parameters during planning. Do not require the user to pre-create a Worker, D1 database, Workspace, Project, or Credential.

## 2. Load or install the verified Skills

First installation discovers the latest stable release by default; reuse an existing trusted, compatible installation. Read the canonical stable pointer:

<https://github.com/breakstring/cfKanban/releases/latest/download/stable.json>

Resolve and pin the immutable manifest URL, SHA-256, and exact version; verify the publisher, allowed artifact origins, and required bundle digests. Keep this snapshot for the operation, separate from the host's saved update source. Stop on missing or failed verification instead of falling back to a prerelease, cache, or development source. If a trusted installed deployment Skill supports `release discover`, use `{}` or `{"selectionMode":"latest_stable"}` for read-only stable discovery, then `release verify` for artifact bytes. Retain the returned `selection_mode`; refilling `version` with the resolved stable version in this mode keeps `marketplace.ref: null` and rejects RCs. Explicit exact-version choices (current stable, historical, or RC) require `{"selectionMode":"exact_version","version":"<target>"}`. An older Skill without these inputs uses the HTTPS document flow while retaining the choice separately; do not install an update merely to check.

When installation is needed, first identify the actual Agent host and its supported Skill installation and discovery methods. Include the source, exact version, user scope, local paths, and rollback in the plan; record the source commit when using Git. Every host must preserve the complete verified Skill bundle: all four Skills, shared `packages/skill-runtime`, and relative layout. Copying a single Skill directory is insufficient.

- A host with a compatible Git marketplace or plugin source can follow the repository's default `main` branch, which contains only published stable releases. Before installation, verify that its commit matches the published tag for the pinned stable target and that the installed files match the verified Skill bundle.
- A host that loads local Skill directories uses the complete verified bundle and its supported discovery layout. Preserve the shared runtime and relative paths when creating the host entry. If the host cannot support that layout, report the specific limitation.

For **Codex with plugin support only**, a fresh default-branch installation uses this example after the applicable authorization; other hosts use their own supported installation method:

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git
codex plugin add cfkanban-agent-skills@cfkanban
```

After installation or update on any host, verify its actual copy against the same pinned target and read back the saved source/ref separately; a matching version string alone is insufficient. `latest_stable` must leave no unexpected tag pin: fixing a manifest/version/digest does not add `--ref`. For the Git path, if `main` still trails Latest or the source changes during the operation, stop and report it; also stop if a host copy differs from the verified bundle. Do not silently substitute a tag, prerelease, or development checkout. `exact_version` uses the verified exact tag/bundle, including `--ref <resolved-version>` only when the supported Codex installation method needs it.

RC testing temporarily switches the existing host entry/projection, recording its original source/ref and restoration first; do not create another plugin entry or an automatic migration script. Keep or restore the default stable long-term source, and verify the installed RC and saved update source separately. If the host cannot keep an RC installation while restoring its source, explain the limitation and required switch back before a later native stable update; never claim an arbitrary tag pin will update to stable automatically.

An existing Git-based installation pinned to a tag needs a source switch before native updates can follow stable. Inspect the saved source/ref first (the `cfkanban` marketplace in Codex); removing `--ref` from a copied command does not change the saved setting, and refreshing a fixed tag does not upgrade to stable. Present the source change and rollback, then use the host's supported procedure within the user's authorization; reuse authorization already covering that update instead of repeatedly asking. Keep private `.cfkanban/` identity and deployment records. Local-directory installations continue through their verified bundle update path. Following `main` lets later host updates discover new stable releases; it does not automatically refresh installed Skills or the current task.

Check the canonical active receipt, host plugin/Skill projection, and current task loaded version separately. Updating the canonical bundle does not update the host; an installed host projection does not prove this task loaded it. Explain the specific handoff and remaining step if a new task is required, and mark unverifiable loading as unverified.

Checking for updates and executing them are separate; local Skill updates and cloud Instance upgrades are independent. If the latest Skills are incompatible with an older target instance, reuse a verified compatible installation or explain the limitation and propose an explicit compatible historical stable release. Never force a server upgrade to join a Project or update Skills.

## 3. Run the deployment Skill

Read the installed `cfkanban-deploy/SKILL.md` and its deployment workflow reference. From that Skill directory, discover the actual command catalog:

```text
node scripts/cfkanban-tool.mjs help
```

Call the catalog's commands with structured JSON on stdin; do not invent command flags or include secrets in the input. Use `capabilities`, `release discover`, `release verify`, `runtime resolve-wrangler`, and the authentication/readback commands for preflight; use `plan strict-zero`, journal commands, and `deploy wrangler-action` for the approved deployment. Follow the Skill's complete phase order, with these checkpoints:

1. Run the Skill capability checks and inspect existing private cfKanban state without printing credentials or Cloudflare tokens.
2. Verify the release pointer, immutable manifest, publisher, artifact origins, Skill bundle digest, Service bundle digest, Node range, Wrangler range, API range, and schema version.
3. Reuse a compatible Node.js and Wrangler when available. If Wrangler is missing or incompatible, show a separate plan before installing a pinned copy under `~/.cfkanban/tool-runtime/`; never install it into your working repository or global PATH.
4. Resolve Cloudflare authentication from an existing deployment journal/receipt, an environment token, an explicitly named profile, the private deployment config, or Wrangler's default context. Do not enumerate profiles to guess an identity, activate a profile, or expose raw authentication output.
5. Ask only for the Owner display name if it is still missing. Generate a strict-zero plan for one Worker and one D1 database on `workers.dev`, with collision checks, exact account and resource names, migration classification, local paths, and rollback/recovery boundaries.
6. Obtain the user's authorization for that frozen task/operation/plan digest before executing it. Resume unchanged, journal-proven steps within that authorization; do not ask again for every command. DNS/custom-domain work, paid services, destructive migrations, unknown-resource takeover, account changes, or later plan drift require new authorization.
7. Execute the approved journaled plan. Generate the Owner Credential directly into the private pending slot; never return it in chat, command arguments, logs, a repository, or a browser.
8. Apply migrations in manifest order, read back both the ledger and actual schema, deploy the Worker and Web assets, bootstrap the same Owner Principal, and verify public discovery plus authenticated `/meta` and `/me` facts.
9. Promote the Credential to current only after identity and fingerprint readback match, then write a redacted receipt. Report the instance URL, IDs, versions, and verification evidence without secrets.

## 4. Verify and hand off

Report the verified instance URL and ID, Owner Principal ID, Skill/Service versions, and redacted receipt/journal references. Distinguish completed, pending, and failed steps. A successful upload alone is not a completed deployment.

If the user's task includes initial board setup, continue with `cfkanban-admin` to create the explicitly scoped Workspace and Project and read both back. Otherwise offer that next step without performing the writes. The server generates immutable UUIDs; users provide only display names, which can change. Deployment itself creates neither container.

Use `cfkanban` for requested Issue work or an explicit Project-scoped `web launch`. Use `cfkanban-admin` for invitations and the [joining guide](./join.md) for recipient onboarding. Never send a long-lived Credential to the browser.

## Stop and ask instead of guessing

Stop and explain the exact blocker when the release or digest cannot be verified, the Cloudflare account is ambiguous, a resource with the proposed name cannot be proven to belong to this instance, local Credential state conflicts, migration ledger/schema facts drift, or the requested operation adds DNS, paid, destructive, or security-impacting changes outside the approved plan.

On an interrupted deployment, resume the same task/operation/plan journal when its facts still match. Do not generate a second Owner identity or silently start a replacement deployment.
