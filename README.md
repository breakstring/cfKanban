# cfKanban

English | [简体中文](README.zh-CN.md)

cfKanban is a small, self-hosted Kanban for people who work through Agents. You ask your Agent to deploy and operate it; the same Cloudflare Worker also serves a bilingual Web board for direct human use.

It runs as one Cloudflare Worker plus one D1 database, with optional private R2 storage for Issue attachments. There is no separate server, Pages project, KV namespace, or standalone cfKanban CLI.

## See it in action

https://github.com/user-attachments/assets/82e0eac9-43b1-4fd5-ae25-d3e11338c734

## Stable releases

First installations and new deployments use the latest stable release by default. You do not need to choose or enter a version: your Agent discovers it through the [official stable release entry](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json), verifies and pins the exact artifacts, then prepares the installation or deployment plan. Existing trusted, compatible Skills can be reused; joining a Project does not upgrade its server.

Local Skill updates and cloud Instance upgrades are separate actions. Prereleases, historical versions, and source development require an explicit choice. If stable is unavailable or verification fails, the Agent reports the problem instead of substituting a development snapshot.

Release archives do not contain a Node.js executable. The Skill bundle includes four Skills and shared JavaScript helpers that run with your compatible Node.js; the Service bundle includes the built Worker, Web assets, migrations, contracts, and a Wrangler configuration skeleton. The Agent generates private configuration from the approved plan; users do not need to unpack or edit the artifacts manually.

## What you need

For any supported Agent host:

- support for loading Skills, reading HTTPS documents, and running local Node.js scripts;
- a compatible Node.js environment and persistent private storage for your identity;
- access to the official release downloads, plus Git access if using a Git-based installation.

The Agent uses the host’s supported Skill directories or plugin mechanism. Some hosts need a new conversation after installation to load the Skills.

For your own Cloudflare deployment you will also need:

- a Cloudflare account that can create one Worker and one D1 database;
- a compatible Node.js and Wrangler environment. `cfkanban-deploy` checks what already exists first. If Wrangler is unavailable, it must show a separate installation plan before adding a pinned Wrangler package under `~/.cfkanban/tool-runtime/`; it does not bundle or install Node.js;
- the Owner display name you want cfKanban to use. The Agent must not guess it from your operating-system or Git identity.

## Install the Skills

Give your Agent this request:

> Read https://github.com/breakstring/cfKanban/releases/latest/download/install.md and install the latest stable cfKanban Skills for me.

The Agent identifies your host, checks existing installations, and explains the required local changes. Hosts with a compatible Git plugin or marketplace source can follow the repository’s default `main` branch, which contains only published stable releases; Codex is one example and does not need `--ref` for ordinary installation. Hosts that load local Skill directories use the complete verified bundle, including its shared runtime. The Agent checks the selected release and actual installed files for either method. Installation does not deploy or upgrade a Cloudflare instance or grant application permissions.

If your Git-based installation is pinned to an old tag, ask the Agent to switch its registered source to the default branch and update the host installation. Editing a copied command alone does not change the saved setting. Local-directory installations continue using the bundle update path. Keep your private `.cfkanban/` identity and deployment records. Neither installation method updates automatically just because a new release appears; ask for an update, then reload the host or start a new conversation when required.

cfKanban contains four Skills: an onboarding guide and three operational Skills:

| Skill | Ask it to help with |
| --- | --- |
| `$cfkanban-howto` | Learn daily use, Owner administration, and deployment, with example prompts. |
| `$cfkanban` | Join a Project and work with Issues, Comments, and the Web board. |
| `$cfkanban-admin` | Create boards and manage Projects, invitations, access, and Owner settings. |
| `$cfkanban-deploy` | Deploy, update, resume, or recover a cfKanban installation. |

You normally talk to the Skill in natural language. The bundled `.mjs` commands are deterministic tools for the Agent; ordinary users do not need to run them manually.

## After installation: start with Howto

Once the host has loaded the Skills, start with the read-only usage guide:

> Use `$cfkanban-howto` to explain how to use cfKanban, which Skill fits my needs, and give me a few prompts I can try.

You can make the question specific: “I have joined a Project; how do I find my tasks, create an Issue, change its status, and add a Comment?” Howto explains the available actions and suggests the next Skill; asking for guidance does not perform those actions.

Then choose the path that matches your situation:

- **Invited to an existing Project:** follow [the joining steps](#join-an-existing-cfkanban-project). You do not need your own Cloudflare deployment.
- **Already have access:** ask `$cfkanban` to show your unfinished Issues in a named Project or open its board.
- **Want to host an instance:** follow [the deployment steps](#ask-your-agent-to-deploy), then create your first board as Owner.

Howto is a recommended starting point, not a required setup step. If you already know what you want, ask the appropriate operational Skill directly. More examples are in the [Agent Skills guide](docs/skills/README.md).

## Ask your Agent to deploy

With the Skills loaded, this one sentence is enough:

> Use `$cfkanban-deploy` to deploy cfKanban for me.

You do not need to know or mention manifests, digests, preflight, deployment plans, migrations, or rollback journals. The Skill handles those details: it starts with read-only checks, explains what is available in plain language, asks only for information that is actually missing, and shows the exact changes before anything is installed or deployed.

If Cloudflare login is needed, the Skill shows that as its own small plan and then opens the appropriate browser or device flow after approval. Completing login does not create a Worker or D1 database; the deployment plan remains a later, separate approval.

The Agent discovers the latest stable release and pins its exact version, source, and digests in the plan. A newer release appearing during execution does not change that target.

For the complete step-by-step path, give your Agent the [deployment guide](apps/web/public/deploy-guide.md). It covers Skill installation, environment checks, authorization, deployment, readback, and recovery instead of asking the Agent to infer the workflow from this general README.

## What the deployment Skill handles for you

The Skill is responsible for:

1. confirming the exact release and checking that its files have not changed;
2. checking the computer and reusing compatible Node.js and Wrangler installations when possible;
3. reusing an exact journal/receipt auth target or asking Wrangler to resolve the current private deployment/config context; an alternate profile is considered only when the user explicitly names it, while the private config pins the exact account;
4. showing the resources, local changes, costs, and recovery limits before asking for approval;
5. creating one Worker, one D1 database, and the bundled Web app only after approval;
6. reading everything back before reporting that deployment succeeded.

The default plan creates only one Worker and one D1 database on `workers.dev`. Custom domains, paid services, destructive migrations, resource adoption or replacement, and permission changes require a new explicit plan.

## Get your first usable board

After deployment has been verified, start a new task or continue with the installed Skills:

1. Ask `$cfkanban-admin` to verify the Owner identity, create one Workspace and one Project with the display names you choose, read both back, and create an Owner Web launch.
2. The dedicated launch command opens the board without returning the one-time URL by default. The long-lived Credential is not placed in the browser or URL.
3. Ask `$cfkanban` to create the first Issue or work with the Project from the Agent.
4. If another person or Agent should join, ask `$cfkanban-admin` to create an invitation with explicit Project targets and `reader` or `writer` access; its dedicated command copies the one-time text without ordinary stdout output by default.

The user-facing prompt can stay just as short:

> Use `$cfkanban-admin` to create my first cfKanban board.

The Skill verifies the Owner, asks for the Workspace and Project display names it still needs, explains each write, reads the result back, and then offers the Web board.

## Join an existing cfKanban Project

Install or reuse the Skills, let the host load them, and give the one-time Invite URL to your Agent:

The [joining guide](apps/web/public/join.md) also covers a recipient who has not installed the Skill yet, and explains both Project Invite and Public Join paths.

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

Host discovery entries, marketplace configuration, and plugin caches remain in the directories managed by the corresponding Agent host. They are disposable host projections, not cfKanban state or canonical release truth. Windows native and WSL2 use separate user homes and are never mixed automatically.

## For contributors

### Source development and test environments

Keep `main` on the commit of a published stable release. Develop on `feat/*` or `fix/*` branches; switching branches in the normal project directory is sufficient, and an additional Git worktree is optional. Publish an exact RC from the development branch and validate it on the test instance. Then build and publish the stable artifacts, verify them, and advance `main` to that same stable commit.

For routine Skill development, have the Agent read the current branch’s `SKILL.md` and execute its scripts from that checkout. Read changed instructions again; edits do not automatically refresh an installed Skill or an existing task. To test host discovery and loading, use the host’s supported local-directory layout or temporarily switch its existing plugin source to the exact checkout. Preserve the shared runtime and relative paths in either case.

For Codex with plugin support, a local installation example is:

```sh
cd /absolute/path/to/cfKanban
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

In Codex, if `cfkanban` is already registered, inspect its source and use the supported source-switch procedure before these commands; do not silently overwrite it. After host-loading tests, restore the previous normal installation or its verified stable update. Hosts without plugins use their own Skill discovery method; no separate development plugin is needed.

Record the branch, commit, and dirty state for source tests. A development checkout or local modification is not a verified release; `main` is a distribution source whose installed content must still match the selected published release. Select prereleases or historical versions explicitly; published tags and artifacts are immutable. The current Skill has no remote deployment plan that freezes source-checkout facts, so source evaluation stops before Cloudflare writes.

This project uses isolated local development and `cfkanban.dev` as a persistent public test, demo, and dogfood instance. The site may run a prerelease; GitHub stable remains the recommended release for users deploying their own instance. Real data on the demo site retains the normal migration, permission, and recovery protections; a test Project alone cannot isolate deployment or migration. Maintainers can use the repository-only [project-release Skill](.agents/skills/project-release/SKILL.md) to prepare releases and upgrade the site within the authorized scope. One compatible Skill installation can access multiple explicitly selected instances.

Install the exact lockfile and run the complete repository validation:

```sh
npm ci
npm run validate
```

`npm run validate` runs typechecks, unit and integration tests, OpenAPI/error checks, generated-artifact drift checks, local D1 validation, credential-free CI policy checks, the Web build, and a Worker dry-run build. It does not log in to Cloudflare or write remote resources.

Source maintainers can use the [release publication and interruption-recovery workflow](docs/release-publication.md) to verify a draft before publishing its assets. This is separate from user deployment and Skill updates.

Start with the [documentation index](docs/README.md), [product brief](docs/product/product-brief.md), [user storyboard](docs/product/user-storyboard.md), [Agent Skills guide](docs/skills/README.md), and [implementation plan](docs/plans/2026-08-29-v0-implementation-plan.md). Frozen technical contracts live under [`docs/specs/`](docs/specs/).

## Friendly links

<p align="center">
  <a href="https://linux.do" alt="LINUX DO"><img src="https://shorturl.at/ggSqS" alt="LINUX DO" /></a>
</p>
