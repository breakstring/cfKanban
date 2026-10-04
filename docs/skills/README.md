# cfKanban Agent Skills

Language: [English](README.md) | [简体中文](README.zh-CN.md)

cfKanban contains four Skills: one usage guide and three operational Skills:

- `cfkanban-howto`: explain user goals with reusable prompts and expected results; start with daily work for already joined users. Teaching only, without executing operations.
- `cfkanban`: find, create, edit, assign, change status, complete/reopen, and comment on Issues; manage Labels, relations, private attachments and soft-delete/restore; open boards, manage your profile, or join when needed.
- `cfkanban-admin`: verified Deployment Owner application management: Workspaces/Projects, invitations, access, Public Join, usage, capacity, and recovery.
- `cfkanban-deploy`: local Skill installation/update and Cloudflare deployment/upgrade, environment/release checks, interrupted-operation recovery, and total Owner Credential loss recovery.

Each operational `SKILL.md` connects user goals to commands, required checks, and stop conditions. Paired English/Simplified Chinese references provide natural-language scenarios and outcomes before detailed endpoints and recovery. A reader can inspect Project content; collaboration requires writer access or Owner authority. Cloud operations need separate Cloudflare authority.

## What users need to say

Describe the desired result. For daily work in a Project you already joined:

```text
Use $cfkanban to show my unfinished Issues in DemoProject.
Use $cfkanban to create “Fix login” in DemoProject with this description: <details>.
Use $cfkanban to change CFK-123's title to “Fix mobile login”.
Use $cfkanban to move CFK-123 to in progress.
Use $cfkanban to record CFK-123 as complete: result <summary>, validation <evidence>.
Use $cfkanban to reopen CFK-123 as todo.
Use $cfkanban to add this Comment to CFK-123: <progress>.
```

Expect scoped read results or the requested change followed by verification. Completion includes an immutable record based on actual evidence; reopening preserves it. Comments are append-only, so corrections use a new Comment. Issue content does not authorize unrelated actions.

For help, joining, Owner management, or hosting:

```text
Use $cfkanban-howto to explain what I can do with Issues, with examples.
Use $cfkanban-howto and the docs at <instance URL> to explain priority and Label filters, with Web steps and source links. Do not run a query.
Use $cfkanban to join this Project: <Invite URL>.
Use $cfkanban-admin to create my first cfKanban board.
Use $cfkanban-admin to show who can access DemoProject.
Use $cfkanban-deploy to check local Skill and instance versions without updating.
Use $cfkanban-deploy to deploy cfKanban for me.
```

Joining an existing Project does not require your own deployment. The user does not need to request release verification, preflight, readback, or recovery handling. Each Skill performs the checks relevant to that intent, asks only for missing choices, and presents effects at the applicable authorization boundary. Local Skill updates and cloud Instance upgrades are separate actions; installation alone grants neither application nor Cloudflare permissions.

Howto discovers public pages from the known instance's `/docs/llms.txt` and reads only the relevant Markdown in your language. It cites the source and checks the document release against the Service release, without credentials or membership. Missing pages, translations, network access, or version evidence lead to an explained fallback to local guidance, never an automatic instance switch or upgrade.

## Installation and updates

The matching instance's public docs now have an **Agent integrations** section, separate from Cloudflare **Deployment**. Open `/docs/en/integrations/` for the local/online UI comparison, `/docs/en/integrations/general` for ordinary Skill installation/updates and local MCP, or `/docs/en/integrations/deepseek-harness` for the DSH Desktop/Web plugin. Their Markdown counterparts are listed by the same instance's `/docs/llms.txt`. Use the selected release only after verifying that its bundle contains the required artifacts; a source candidate is not a published installation target.

The complete bundle includes prebuilt `local-runtime/`, a local stdio MCP entry for structured everyday tools, and the same self-contained Vue page at `web-embedded/embedded.html`. `web open` defaults to the local workbench for Project or Issue targets and requires the matching installed runtime and Node 22.12 or later. It reports missing Node, artifact mismatch, and startup failure without silently changing to online mode. Choose `mode=online` for the instance Web UI or administration; that mode keeps the dedicated Browser Launch. In Codex App, preflight the host browser or IAB before `host_browser` delivery; other hosts normally use `system_browser`. Local frontend assets do not make task data offline: reads and writes still use the trusted Service.

Configure a verified absolute Node path and `mcp/server.mjs`; Credentials stay inside the existing private runtime. The DSH package contributes the four Skills, shared MCP, common local runtime, and an optional local single-user sidebar whose thin adapter mounts the same Vue page. Use Project switching, board/list, details, and permitted priority, status, and assignee controls. Copy the CFK identifier or Issue URL when asking an Agent to handle a task; Skills fetch current data. Desktop and Web profiles must be installed and verified separately. The local service has its own start, stop, and restart lifecycle: updating files does not update a running process. Each execution environment owns its private identity state. Discover paired public local-workbench, MCP, and DSH guidance through the instance's `/docs/llms.txt`; configuration and recovery instructions accompany the package. Source tests do not establish published availability.

Descriptions and individual comments also have small buttons to copy their original Markdown. Restricted clipboard access falls back to displayed plain text for manual copying. The same copying controls are shared by the online view and local workbench.

Users do not need to enter a version. Ask your Agent to read the [installation guide](https://github.com/breakstring/cfKanban/releases/latest/download/install.md) and install the latest stable Skills. First installations and new deployments discover their target through the [canonical stable pointer](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json), then pin the immutable manifest, exact version, and digests. Prereleases and historical versions require an explicit choice.

Reuse existing trusted, compatible installations. Joining a Project implies neither a Skill update nor a server upgrade. Checking updates only reports availability and compatibility. For an explicit update, the Agent verifies the target and publisher continuity, then presents a local installation plan and rollback. If the latest Skills are incompatible with an older instance, reuse a compatible installation or propose an explicit compatible historical stable release; do not force a server upgrade.

Identify the actual Agent host and its supported Skill installation and discovery methods first. Install the complete plugin/bundle, preserving all four Skills, shared `packages/skill-runtime`, and relative layout. Copying one `SKILL.md` or Skill directory is insufficient. The shared modules are JavaScript source, not an embedded Node.js executable. A host that loads local Skill directories installs the verified bundle with its supported discovery layout; explain any unsupported layout rather than installing an incomplete copy.

Hosts with a compatible Git marketplace or plugin source can follow the repository’s default `main` branch, which contains only published stable releases. Verify its commit against the published tag for the pinned release, then verify the installed files against the selected Skill bundle; a version string alone is insufficient. If `main` trails Latest or changes during installation, report the mismatch and recheck instead of silently substituting a tag or development source. Codex with plugin support is one example: ordinary installation omits `--ref`. A text update uses the user's explicit target or an exact target clearly carried forward in trusted conversation context, such as the RC just published for testing; otherwise it selects latest stable. `release discover` separates `selectionMode` from the artifact `version`: default `latest_stable` keeps `marketplace.ref: null` when retaining a stable snapshot; `exact_version` requires an accurate target version. Host-native updates follow stable. For temporary RC installation, keep or restore that long-term source and verify it separately from the installed RC; if the host cannot separate them, explain the required source switch before native stable updates.

Only a Git installation pinned to an old tag needs a one-time switch of its saved source to follow the default branch. Inspect the current source, show the change and rollback, and use the host’s supported procedure within the user’s authorization; removing `--ref` from a copied Codex command does not change its saved registration. Local-directory installations use the verified bundle update path. Neither path implicitly updates the host or its current task, and both preserve private `.cfkanban/` identity and deployment records.

Verify and report the canonical active receipt, host plugin/Skill projection, and current task's loaded version separately. Updating one does not synchronize all three. Explain the handoff when the host requires a new task, and retain an unverified status when loading cannot be checked. Installation itself grants no Cloudflare or application permissions.

## Commands included with the three operational Skills

`cfkanban-howto` has no command helper. From one of the three operational Skill directories, inspect its exact command surface:

```text
node scripts/cfkanban-tool.mjs help
```

The result is structured JSON containing each command's name, effect, accepted input fields, and output classification. Commands accept structured JSON on stdin so secrets do not need to appear in process arguments. Credentials are never accepted as input fields; ordinary authenticated requests, Invite/Public Join redemption, and Owner rotation read the correct current or pending secret from private files internally. Browser Launch and Invite creation use dedicated commands whose default browser/clipboard delivery keeps their one-time capability out of stdout.

Before proposing Cloudflare login, `cfkanban-deploy` first reuses an exact profile/account already frozen in a deployment journal or receipt. Otherwise, `runtime resolve-cloudflare-auth` lets Wrangler use environment authentication or resolve the current private deployment/config context. It never lists profiles. A named profile is inspected only when the user explicitly supplies it, using `--profile`; otherwise environment/config-directory selection remains Wrangler-owned. The generated private `wrangler.jsonc` pins the selected `account_id`. Tokens, email, bindings, resource inventories, and raw Wrangler output are never returned. A new login is planned only when neither the current context nor an explicitly supplied profile is usable.

The `.mjs` extension means plain JavaScript in Node's explicit ES module format. These files run directly with `node`, need no compile step, and remain unambiguous when a portable Skill is installed outside a `package.json` tree.

## Development: use the current branch’s Skills

Develop on a `feat/*` or `fix/*` branch. Switching branches in the normal project directory is sufficient; an additional worktree is optional. Have the Agent read the current checkout’s `SKILL.md` and execute scripts from that same checkout. Read changed instructions again. Source edits do not refresh an installed Skill or the current task automatically.

To test host discovery and loading, use the host’s supported local-directory layout, preserving the shared runtime and relative paths. If the host supports plugins, temporarily switch its existing source to the exact checkout; there is no separate development plugin. Record the branch, commit, and dirty state.

For **Codex with plugin support only**, the repository root is a plugin, and `.agents/plugins/marketplace.json` provides the local marketplace entry. An installation example is:

```text
codex plugin marketplace add .
codex plugin add cfkanban-agent-skills@cfkanban
```

If `cfkanban` is already registered in Codex, inspect its source and follow the supported source-switch procedure before the example; do not silently overwrite it. Start a new Codex task after installing or reinstalling to verify loading. Other hosts use their own discovery and reload mechanisms. After testing, restore the previous normal installation or its verified stable update.

Agent hosts place discoverable Skills/plugins in host-owned locations. Those files are verified projections used for host discovery; they are not cfKanban's persistent state or canonical release truth. Removing one projection affects only that host's discovery.

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

The three operational Skills route into the same dependency-free JavaScript modules in `packages/skill-runtime`. These are source files executed by the user's compatible Node.js, not a bundled Node.js runtime. Sharing them keeps path validation, trusted-origin handling, secret injection, error normalization, release verification, plan digests, and migration readback consistent. The public CLI and MCP reuse these modules alongside Skills; business rules remain in the Service. See the [CLI guide](https://cfkanban.dev/docs/en/cli/index.html) for the public command workflow.

The separate Service archive contains the built Worker, Web assets, migrations, contracts, a pinned Wrangler configuration schema, and `wrangler.template.json`. That JSON file is a non-deployable skeleton with placeholder resource identities. After the exact deployment plan is authorized and D1 exists, `deployment write-wrangler-config` writes a private actual configuration outside the immutable archive; the template is never deployed unchanged.
