# cfKanban Agent Skills

Language: [English](README.md) | [简体中文](README.zh-CN.md)

cfKanban packages three Skills in one portable, verified bundle:

- `cfkanban`: daily identity, scope, Issue collaboration, Invite/Public Join, and Project/Issue Web launch.
- `cfkanban-admin`: Deployment Owner application administration.
- `cfkanban-deploy`: canonical release verification, local Skill lifecycle, Cloudflare deployment, resume, migration, and upgrade safety.

Each `SKILL.md` starts with what the Skill can do, when to use a different Skill, a task-to-command map, the required workflow, and stop conditions. The paired reference guide provides the detailed English or Simplified Chinese endpoint and recovery instructions.

## What users need to say

Users describe the result; the Skills own the safety workflow. These prompts are enough:

```text
Use $cfkanban-deploy to deploy cfKanban for me.
Use $cfkanban-admin to create my first cfKanban board.
Use $cfkanban to join this Project: <Invite URL>
```

The user does not need to request release verification, read-only preflight, a deployment plan, version checks, readback, or recovery handling. Each Skill starts with the safe discovery required for that intent, asks only for missing choices, and presents side effects at the correct authorization boundary.

## Current testing-preview entry

The first stable release has not been published. Today, Codex users can load the immutable testing tag:

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.44
codex plugin add cfkanban-agent-skills@cfkanban
```

The testing tag is immutable; use mutable `main` only for deliberate development-snapshot evaluation. After installation, start a new Codex task so the Skills are loaded. Installation only enables discovery; it does not create `.cfkanban/`, select a stable or prerelease deployment, or authorize local/cloud writes.

The current testing release pointer is <https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.44/prerelease.json>. `cfkanban-deploy` may use it only after the user explicitly chooses the testing prerelease.

Install the complete plugin/bundle rather than copying one `SKILL.md` or one `skills/<name>/` directory. The three entrypoints deliberately share the bundled JavaScript source modules under `packages/skill-runtime`; despite the internal directory name, this is not an embedded Node.js executable or runtime distribution. A host projection must preserve that verified bundle layout. The current testing preview is supported through the Codex plugin path. Other-host projection is part of the stable release installation flow and must not be approximated with an incomplete folder copy.

## Commands included with each Skill

From any Skill directory, inspect that Skill's exact command surface:

```text
node scripts/cfkanban-tool.mjs help
```

The result is structured JSON containing each command's name, effect, accepted input fields, and output classification. Commands accept structured JSON on stdin so secrets do not need to appear in process arguments. Credentials are never accepted as input fields; ordinary authenticated requests, Invite/Public Join redemption, and Owner rotation read the correct current or pending secret from private files internally. Browser Launch and Invite creation use dedicated commands whose default browser/clipboard delivery keeps their one-time capability out of stdout.

Before proposing Cloudflare login, `cfkanban-deploy` first reuses an exact profile/account already frozen in a deployment journal or receipt. Otherwise, `runtime resolve-cloudflare-auth` lets Wrangler use environment authentication or resolve the current private deployment/config context. It never lists profiles. A named profile is inspected only when the user explicitly supplies it, using `--profile`; otherwise environment/config-directory selection remains Wrangler-owned. The generated private `wrangler.jsonc` pins the selected `account_id`. Tokens, email, bindings, resource inventories, and raw Wrangler output are never returned. A new login is planned only when neither the current context nor an explicitly supplied profile is usable.

The `.mjs` extension means plain JavaScript in Node's explicit ES module format. These files run directly with `node`, need no compile step, and remain unambiguous when a portable Skill is installed outside a `package.json` tree.

## Marketplace and plugin installation

The repository root is a Codex plugin, and `.agents/plugins/marketplace.json` provides a named local marketplace entry. An already downloaded checkout can be registered and installed for development or validation with:

```text
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

Start a new Codex task after installing or reinstalling so the host loads the snapshot's Skills.

Codex and other Agent hosts place discoverable Skills/plugins in host-owned locations. Those files are verified projections used for host discovery; they are not cfKanban's persistent state or canonical release truth. Removing one projection affects only that host's discovery.

Marketplace/plugin is a convenience entry and never overrides the canonical HTTPS publisher, immutable release manifest, artifact-origin allowlist, SHA-256 digests, or installed receipt. A local source checkout is not a canonical stable release. Install, update, downgrade, deployment, and Instance upgrade remain separate planned actions and never run automatically because a marketplace entry exists.

### Optional Cloudflare companion

Cloudflare's own [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) and [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) Skills are useful optional references for current platform facts and Wrangler syntax. They are not dependencies of `cfkanban-deploy`, are never installed automatically, and cannot replace its release verification, exact Wrangler compatibility, frozen plan, journal, migration readback, or authorization. If a user requests them, follow the [upstream installation guide](https://github.com/cloudflare/skills#installing) as a separate host-owned change with source/revision, scope, target, and rollback shown first.

## Unified cfKanban data root

All persistent files owned by cfKanban use one private maintenance root for the current execution environment:

```text
~/.cfkanban/
  instances/
  service-releases/
  skill-releases/
  tool-runtime/
```

- `instances/` stores trusted instance metadata, Credentials, journals, and redacted receipts.
- `service-releases/` stores verified immutable Service deployment bundles used by deployment and Instance-upgrade plans; it has no active pointer and never implies a cloud write.
- `skill-releases/` stores verified immutable Skill versions and the atomic active pointer.
- `tool-runtime/` stores an isolated pinned Wrangler npm package and its dependencies only when a user-owned compatible Wrangler is unavailable and the exact install plan is authorized. It uses a compatible user-owned Node.js and never contains or installs Node.js itself.

Host marketplace/plugin metadata, host Skill projections, plugin caches, and Cloudflare authentication stay in their owning system's directories. They cannot be moved into `.cfkanban/` because the corresponding host/tool must discover and manage them there. Windows native and WSL2 use different user homes and never share these locations automatically.

The unified root does not weaken secret boundaries: Credential files keep minimum ownership/ACL checks, no broad recursive cleanup is allowed, and no cfKanban state belongs in a Repo, sync directory, or temporary directory.

## Localization policy

Metadata schemas that accept only one string—`SKILL.md` frontmatter, `agents/openai.yaml`, `.codex-plugin/plugin.json`, and marketplace metadata—use English. Documents that support locale-specific files are maintained as paired English and Simplified Chinese files with language links at the top.

## Shared helper modules

The three Skills route into the same dependency-free JavaScript modules in `packages/skill-runtime`. These are source files executed by the user's compatible Node.js, not a bundled Node.js runtime. Sharing them keeps path validation, trusted-origin handling, secret injection, error normalization, release verification, plan digests, and migration readback consistent without publishing a standalone cfKanban CLI or copying business rules out of the Service.

The separate Service archive contains the built Worker, Web assets, migrations, contracts, a pinned Wrangler configuration schema, and `wrangler.template.json`. That JSON file is a non-deployable skeleton with placeholder resource identities. After the exact deployment plan is authorized and D1 exists, `deployment write-wrangler-config` writes a private actual configuration outside the immutable archive; the template is never deployed unchanged.
