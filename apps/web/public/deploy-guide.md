# Deploy cfKanban with an Agent

English | [简体中文](./deploy-guide.zh-CN.md)

This is the step-by-step deployment guide. Give its HTTPS URL to your Coding Agent as read-only guidance. Do not execute this document or pipe it into a shell.

## What you need

- A Coding Agent that can install local Skills and run commands with your approval.
- Node.js `>=22.12.0 <27`. cfKanban does not install Node.js or change your shell, PATH, or version manager.
- A Cloudflare account that can create one Worker and one D1 database. Wrangler authentication may open an official browser or device flow.
- The display name you want for the one Deployment Owner. The Agent must ask rather than infer it from your computer or Git identity.

You do not need to pre-create a Worker, D1 database, Workspace, Project, or Credential.

## 1. Install the Skills

The current testing release is `0.1.0-alpha.38`. It is a prerelease, so the Agent must tell you that and get your explicit testing-release choice before selecting it.

For Codex, ask the Agent to show this host-level installation plan first: source `https://github.com/breakstring/cfKanban.git`, immutable ref `0.1.0-alpha.38`, user scope, and removal of the plugin as the rollback. On a fresh Codex installation, the commands are:

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.38
codex plugin add cfkanban-agent-skills@cfkanban
```

If a `cfkanban` marketplace entry already exists at another ref, do not overwrite or remove it silently. Have the Agent inspect it and present the exact update and rollback first. After installing or updating the plugin, start a new Codex task so the three Skills are discoverable.

For another Agent host, install the three directories `cfkanban`, `cfkanban-admin`, and `cfkanban-deploy` from the verified Skill bundle using that host's normal Skill mechanism. The Agent must verify the immutable manifest and SHA-256 from the testing release pointer instead of treating a checkout, `main`, or a plugin cache as deployment truth:

<https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.38/prerelease.json>

## 2. Give the deployment intent

Start a new task and say:

> Use `$cfkanban-deploy` and this guide to deploy a new cfKanban instance for me. Use the `0.1.0-alpha.38` testing release. Start with read-only checks, then show the exact plan and required authorization before any local installation or Cloudflare write.

That request is enough. You should not need to invent resource names, migration commands, digests, or Wrangler flags.

## 3. What the Agent should do

1. Run the Skill capability checks and inspect existing private cfKanban state without printing credentials or Cloudflare tokens.
2. Verify the release pointer, immutable manifest, publisher, artifact origins, Skill bundle digest, Service bundle digest, Node range, Wrangler range, API range, and schema version.
3. Reuse a compatible Node.js and Wrangler when available. If Wrangler is missing or incompatible, show a separate plan before installing a pinned copy under `~/.cfkanban/tool-runtime/`; never install it into your working repository or global PATH.
4. Resolve Cloudflare authentication from an existing deployment journal/receipt, an environment token, an explicitly named profile, the private deployment config, or Wrangler's default context. Do not enumerate profiles to guess an identity, activate a profile, or expose raw authentication output.
5. Ask only for the Owner display name if it is still missing. Generate a strict-zero plan for one Worker and one D1 database on `workers.dev`, with collision checks, exact account and resource names, migration classification, local paths, and rollback/recovery boundaries.
6. Wait for your approval of that frozen plan. DNS/custom-domain work, paid services, destructive migrations, unknown-resource takeover, account changes, or any later plan drift require a new decision.
7. Execute the approved journaled plan. Generate the Owner Credential directly into the private pending slot; never return it in chat, command arguments, logs, a repository, or a browser.
8. Apply migrations in manifest order, read back both the ledger and actual schema, deploy the Worker and Web assets, bootstrap the same Owner Principal, and verify public discovery plus authenticated `/meta` and `/me` facts.
9. Promote the Credential to current only after identity and fingerprint readback match, then write a redacted receipt. Report the instance URL, IDs, versions, and verification evidence without secrets.

## 4. After deployment

Use `$cfkanban-admin` to create an explicit Workspace and Project. Keys are immutable after creation; display names can change. Deployment does not silently create either container.

Then use `$cfkanban` for Issues and a Project-scoped Browser Launch. To invite another person or Agent, use `$cfkanban-admin` and the [joining guide](./join.md). The browser never accepts a long-lived Credential.

## Stop and ask instead of guessing

The Agent must stop when the release or digest cannot be verified, the Cloudflare account is ambiguous, a resource with the proposed name cannot be proven to belong to this instance, local Credential state conflicts, migration ledger/schema facts drift, or the requested operation adds DNS, paid, destructive, or security-impacting changes that were not in the approved plan.

On an interrupted deployment, resume the same task/operation/plan journal when its facts still match. Do not generate a second Owner identity or silently start a replacement deployment.
