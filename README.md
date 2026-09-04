# cfKanban

English | [简体中文](README.zh-CN.md)

cfKanban is a small, self-hosted Kanban for people who work through Coding Agents. You ask your Agent to deploy and operate it; the same Cloudflare Worker also serves a bilingual Web board for direct human use.

It runs as one Cloudflare Worker plus one D1 database. There is no separate server, Pages project, KV namespace, or standalone cfKanban CLI.

## Availability

cfKanban is currently a **public testing preview**, not a stable end-user release.

- The Worker, D1 schema, Web UI, and three Agent Skills are implemented in this repository.
- You can install the Codex plugin from this public repository today and inspect or evaluate the Skills.
- The [`0.1.0-alpha.23` GitHub prerelease](https://github.com/breakstring/cfKanban/releases/tag/0.1.0-alpha.23) packages immutable Skill and Service bundles for testing. It sharpens the Agent-first public message and replaces product-owned English fragments across the Simplified Chinese Web UI with natural Chinese while preserving stable keys and user content.
- Its machine-readable testing entry is [`prerelease.json`](https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.23/prerelease.json).
- The stable release pointer and real multi-environment deployment acceptance are not published yet.
- Do not treat `main`, a local checkout, or a marketplace snapshot as a canonical stable release or production-ready deployment.

This distinction matters: the plugin helps Codex discover the Skills, while a canonical release manifest will identify and verify the exact Skill and Service bundles that may be deployed.

The release archives do not contain a Node.js executable. The Skill bundle contains ordinary `.mjs` helper modules that run with a compatible Node.js already available on the user's computer. The Service bundle contains the built Worker, Web assets, migrations, contracts, and a `wrangler.template.json` configuration skeleton; the deployment Skill replaces its placeholder resource values by generating a private, plan-bound Wrangler configuration before use. Users do not need to unpack either archive manually.

## What you need

For the current testing-preview path:

- Codex desktop or Codex CLI with plugin support;
- Git access to this repository;
- a new Codex task after plugin installation, so the new Skills are loaded.

For a future Cloudflare deployment you will also need:

- a Cloudflare account that can create one Worker and one D1 database;
- a compatible Node.js and Wrangler environment. `cfkanban-deploy` checks what already exists first. If Wrangler is unavailable, it must show a separate installation plan before adding a pinned Wrangler package under `~/.cfkanban/tool-runtime/`; it does not bundle or install Node.js;
- the Owner display name you want cfKanban to use. The Agent must not guess it from your operating-system or Git identity.

## Install the testing-preview Skills in Codex

The repository is a Codex plugin marketplace. From the command line, add the immutable testing tag and install its plugin:

```sh
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.23
codex plugin add cfkanban-agent-skills@cfkanban
```

`--ref` is optional. It is included above only to pin the installation to the immutable testing tag. If you deliberately want the latest mutable development snapshot, omit `--ref`; Codex will then use the repository's default branch, currently `main`.

If you already have a local checkout, register that exact checkout instead:

```sh
cd /absolute/path/to/cfKanban
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

Then start a **new Codex task**. Plugin installation does not modify Cloudflare, create `~/.cfkanban/`, deploy the Service, or authorize any later operation.

The plugin contains three Skills:

| Skill | Ask it to help with |
| --- | --- |
| `$cfkanban-deploy` | Deploy, update, resume, or recover a cfKanban installation. |
| `$cfkanban-admin` | Create boards and manage Projects, invitations, access, and Owner settings. |
| `$cfkanban` | Join a Project and work with Issues, Comments, and the Web board. |

You normally talk to the Skill in natural language. The bundled `.mjs` commands are deterministic tools for the Agent; ordinary users do not need to run them manually.

## Ask your Agent to deploy

In the new task, this one sentence is enough:

> Use `$cfkanban-deploy` to deploy cfKanban for me.

You do not need to know or mention manifests, digests, preflight, deployment plans, migrations, or rollback journals. The Skill handles those details: it starts with read-only checks, explains what is available in plain language, asks only for information that is actually missing, and shows the exact changes before anything is installed or deployed.

If Cloudflare login is needed, the Skill shows that as its own small plan and then opens the appropriate browser or device flow after approval. Completing login does not create a Worker or D1 database; the deployment plan remains a later, separate approval.

At the current testing-preview stage, no stable deployment target is published. The Skill should say that clearly and may offer the `0.1.0-alpha.23` prerelease as an explicit testing choice; it must never select a prerelease, a marketplace cache, or the current working tree silently.

If you deliberately want to evaluate a source revision, say so explicitly:

> Use `$cfkanban-deploy` to evaluate this source checkout for a cfKanban deployment.

A source evaluation is an engineering path, not the stable installation path. The Skill must explain that distinction and its consequences; the user should not have to formulate the warning themselves.

The current Skill does not provide a source-specific remote deployment plan that freezes all of those facts, so a correct source evaluation stops before Cloudflare writes. Use the published prerelease for the supported testing flow below.

## What the deployment Skill handles for you

Whether you use the testing prerelease now or a stable release later, the same short prompt remains the entry point. The Skill is responsible for:

1. confirming the exact release and checking that its files have not changed;
2. checking the computer and reusing compatible Node.js and Wrangler installations when possible;
3. reusing an exact journal/receipt auth target or asking Wrangler to resolve the current private deployment/config context; an alternate profile is considered only when the user explicitly names it, while the private config pins the exact account;
4. showing the resources, local changes, costs, and recovery limits before asking for approval;
5. creating one Worker, one D1 database, and the bundled Web app only after approval;
6. reading everything back before reporting that deployment succeeded.

The default plan creates only one Worker and one D1 database on `workers.dev`. Custom domains, paid services, destructive migrations, resource adoption or replacement, and permission changes require a new explicit plan.

## Get your first usable board

After deployment has been verified, start a new task or continue with the installed Skills:

1. Ask `$cfkanban-admin` to verify the Owner identity, create one Workspace and one Project with the keys and names you choose, read both back, and create an Owner Web launch.
2. Open the returned one-time URL. The long-lived Credential is not placed in the browser or URL.
3. Ask `$cfkanban` to create the first Issue or work with the Project from the Agent.
4. If another person or Agent should join, ask `$cfkanban-admin` to create an invitation with explicit Project targets and `reader` or `writer` access.

The user-facing prompt can stay just as short:

> Use `$cfkanban-admin` to create my first cfKanban board.

The Skill verifies the Owner, asks for the Workspace and Project names/keys it still needs, explains each write, reads the result back, and then offers the Web board.

## Join an existing cfKanban Project

Install the plugin, start a new task, and give the one-time Invite URL to your Agent:

> Use `$cfkanban` to join this Project: `<Invite URL>`

The Skill inspects the Invite before redeeming it, explains the Project and access level, and asks only for missing information or approval. It should reuse your existing identity for that instance when allowed. Otherwise it asks only for the display name, creates a pending Credential directly inside private local state, redeems the Invite, verifies `/api/v1/me`, and promotes the Credential only after matching readback. Do not paste a long-lived Credential into chat, environment variables, command arguments, a repository, or browser storage.

## Local data and security boundaries

cfKanban-owned persistent local data uses the current execution environment user's private directory:

```text
~/.cfkanban/
  instances/       # trusted instance metadata, Credentials, journals, receipts
  service-releases/ # verified immutable Service deployment bundles
  skill-releases/  # verified immutable Skill releases and active pointer
  tool-runtime/    # isolated pinned Wrangler package; never a bundled Node.js runtime
```

Codex marketplace configuration and plugin caches remain in Codex-owned directories because Codex must discover them there. They are disposable host projections, not cfKanban state and not canonical release truth. Windows native and WSL2 use separate user homes and are never mixed automatically.

## For contributors

Install the exact lockfile and run the complete repository validation:

```sh
npm ci
npm run validate
```

`npm run validate` runs typechecks, unit and integration tests, OpenAPI/error checks, generated-artifact drift checks, local D1 validation, credential-free CI policy checks, the Web build, and a Worker dry-run build. It does not log in to Cloudflare or write remote resources.

Start with the [documentation index](docs/README.md), [product brief](docs/product/product-brief.md), [user storyboard](docs/product/user-storyboard.md), [Agent Skills guide](docs/skills/README.md), and [implementation plan](docs/plans/2026-08-29-v0-implementation-plan.md). Frozen technical contracts live under [`docs/specs/`](docs/specs/).
