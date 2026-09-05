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

The testing release linked by this guide is `0.1.0-alpha.47`. Disclose that it is a prerelease and require the user's explicit testing choice before selecting it; do not silently substitute it for stable. Reuse an already compatible, verified installation. Installing or updating local Skills is a separate operation from deploying or upgrading an instance.

If running in Codex and installation is needed, first present this host-level plan: source `https://github.com/breakstring/cfKanban.git`, immutable ref `0.1.0-alpha.47`, user scope, and removal of the newly installed plugin as rollback. After authorization, use these commands for a fresh installation:

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.47
codex plugin add cfkanban-agent-skills@cfkanban
```

If a `cfkanban` marketplace entry already exists at another ref, inspect it and present the exact update and rollback before changing it. Do not delete or overwrite it silently. Check Skill discovery after installation; if the host requires a new task to load the plugin, report that specific handoff with the target version and remaining step. Do not claim the Skills are loaded before they are discoverable.

For another Agent host, use its supported Skill mechanism to install the three directories `cfkanban`, `cfkanban-admin`, and `cfkanban-deploy` from the verified Skill bundle. Resolve the following testing release pointer and verify its immutable manifest, allowed artifact origins, and SHA-256 digests. A checkout, `main`, or plugin cache is not deployment truth:

<https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.47/prerelease.json>

## 3. Run the deployment Skill

Read the installed `cfkanban-deploy/SKILL.md` and its deployment workflow reference. From that Skill directory, discover the actual command catalog:

```text
node scripts/cfkanban-tool.mjs help
```

Call the catalog's commands with structured JSON on stdin; do not invent command flags or include secrets in the input. Use `capabilities`, `release verify`, `runtime resolve-wrangler`, and the authentication/readback commands for preflight; use `plan strict-zero`, journal commands, and `deploy wrangler-action` for the approved deployment. Follow the Skill's complete phase order, with these checkpoints:

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

If the user's task includes initial board setup, continue with `cfkanban-admin` to create the explicitly scoped Workspace and Project and read both back. Otherwise offer that next step without performing the writes. Keys are immutable; display names can change. Deployment itself creates neither container.

Use `cfkanban` for requested Issue work or an explicit Project-scoped `web launch`. Use `cfkanban-admin` for invitations and the [joining guide](./join.md) for recipient onboarding. Never send a long-lived Credential to the browser.

## Stop and ask instead of guessing

Stop and explain the exact blocker when the release or digest cannot be verified, the Cloudflare account is ambiguous, a resource with the proposed name cannot be proven to belong to this instance, local Credential state conflicts, migration ledger/schema facts drift, or the requested operation adds DNS, paid, destructive, or security-impacting changes outside the approved plan.

On an interrupted deployment, resume the same task/operation/plan journal when its facts still match. Do not generate a second Owner identity or silently start a replacement deployment.
