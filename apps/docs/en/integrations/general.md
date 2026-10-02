# General

Use this guide for hosts that can discover Skills, run local stdio MCP, or open a browser. [DeepSeek Harness](./deepseek-harness.md) has a dedicated plugin guide. Other hosts use their own documented discovery and reload mechanisms; compatibility with ordinary Skills or MCP does not imply a dedicated cfKanban adapter.

## Install the Skills

```text
Install the official stable cfKanban Skills for this Agent host.
Explain the local changes, preserve my existing cfKanban identity, and verify that all four Skills can be loaded.
Do not deploy or upgrade an instance.
```

The Agent first identifies the host and its supported installation method. It reads the official [installation guide](https://github.com/breakstring/cfKanban/releases/latest/download/install.md), resolves the [canonical stable pointer](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json), fixes the immutable manifest and exact release, and verifies the publisher, allowed artifact origins, and SHA-256 digests before installing. Checking availability does not itself authorize installation. If no verified stable release is available, report that result; do not substitute a source checkout or plugin cache.

Install the complete bundle, keeping all four Skills, shared `packages/skill-runtime`, and their relative paths. Copying a single `SKILL.md` or one Skill directory is insufficient. A bundle containing the local integrations also includes prebuilt `mcp/`, `local-runtime/`, the matching self-contained Vue document, and `dsh/`. It uses a compatible existing Node.js; it does not contain or install Node.js.

| Capability | Installation and verification |
| --- | --- |
| Host discovers local Skill directories | Use its supported layout for the complete verified bundle. Check referenced resources and the resolved Skill paths. |
| Host supports a compatible Git plugin or marketplace | Use the published stable default `main` source. Verify its commit against the selected release tag and its installed content against the verified bundle. |
| Codex with plugin support | The repository is a plugin source. Ordinary stable installation follows `main` without `--ref`; a fixed installation digest is separate from the saved update source. |
| Host supports local stdio MCP | Add the fixed prebuilt entry using the host's documented configuration format; see below. |
| DeepSeek Harness Desktop or Web | Install the [verified DSH archive](./deepseek-harness.md) in the intended profile. |

If `main` trails the selected release or changes during installation, report the mismatch and recheck. Do not silently choose a development branch or another tag. A host without a compatible discovery layout needs an explained limit, not an incomplete copy.

Git plugin projections provide guidance and source, without prebuilt local pages. Before using local MCP or the workbench, use `cfkanban-deploy` to install the complete verified Skill bundle of **the same release**. The workbench verifies the private active receipt and full tree digest before loading matching assets. Missing, modified, or different-version bundles are refused; it neither compiles in the plugin cache nor downloads another version automatically. Online WebUI alone does not require local page artifacts.

Verify that `cfkanban-howto`, `cfkanban`, `cfkanban-admin`, and `cfkanban-deploy` load, including a referenced resource. The first explains capabilities without executing; the other three handle daily collaboration, application administration, and installation/deployment respectively. Run `node scripts/cfkanban-tool.mjs help` from each resolved operational Skill directory to inspect its command surface. Some hosts require a new conversation after installation; verify the version actually loaded there.

## Connect an existing identity and scope

Installing Skills does not join a Project. Follow [Join and sign in](../usage/access.md) for an invitation or Public Join. Owners connecting another computer use [Owner devices](../administration/devices.md). The integration reads the private `.cfkanban/` belonging to its actual OS user and execution environment; it does not accept credentials in chat, command arguments, environment variables, MCP settings, or browser storage.

Use [directory association](../usage/profile.md) to recommend an exact Instance/Project scope through `.cfkanban-scope.json`. The file is a non-secret filter and grants no access. The local view checks the actual working directory, trusted instance, live identity, and Project permission. One valid target can bind automatically; multiple targets require an explicit choice. Missing or invalid scope keeps manual selection available without silently querying every Project.

## Local MCP and workbench

These entries require a selected published bundle containing the matching prebuilt artifacts, plus Node `>=22.12.0`. A source test does not prove their published availability.

Configure a verified absolute Node executable and fixed server entry as separate arguments:

```json
{
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/verified-bundle/mcp/server.mjs"]
}
```

This illustrates one server entry, not a universal host configuration file. Use your host's supported MCP format and keep paths containing spaces as individual arguments. Startup does not compile code or download packages. The local server exposes bounded daily tools; onboarding, recovery, administration, deployment, and sensitive browser delivery continue through Skills. Remote Worker MCP and OAuth are not provided by this local integration.

```text
Use cfKanban MCP to verify my identity on <instance>, then list unfinished Issues in Project <UUID>.
Show the returned Principal and resolved scope. Do not change any Issue.
```

Read the instance, identity, and scope before a write. Each write performs one atomic operation, requires a stable idempotency key, and uses the current version where CAS applies. Service permissions and audit remain authoritative.

To open the local workbench, give the Agent a real working directory and an exact target:

```text
Use $cfkanban to open Project <UUID> on <instance> in local mode, using <absolute working directory> for scope discovery.
Only open the view; do not change any Issue.
```

The Skill's `web open` defaults to local mode for Project or Issue targets. Its local server runs on demand and serves the same Vue task view as the DSH sidebar. Choose online mode explicitly for the full instance Web UI or administration:

```text
Use $cfkanban to open CFK-123 on <instance> in online mode in my selected browser.
```

Local mode does not accept management targets and does not silently switch online after missing Node, an incomplete bundle, or a startup failure. In trusted Codex App context with IAB available, the Agent prefers IAB after checking that it can reach the same loopback environment. An explicit browser choice takes priority. Other supported browsers use their verified delivery path. Long-lived credentials and one-time launch capabilities are never copied into the view or reply.

Frontend assets are local; task reads and writes still contact the trusted online Service. Use Project switching, board/list views, details, manual refresh, and the permitted priority, status, assignee, comment, and completion controls. The board and list append pages near the bottom, with manual loading available. Status counts describe loaded items; “+” indicates another page. At capacity, refine the filter or open the full board. Copy a CFK identifier or Issue URL to ask an Agent to read current task data; descriptions and comments can copy their original Markdown, with a plain-text fallback when clipboard access fails.

## Update local Skills

```text
Use $cfkanban-deploy to check my local Skills and <instance address> for compatible stable updates without changing anything.
```

```text
Use $cfkanban-deploy to update the local cfKanban Skills and this host's entry to the latest compatible stable release.
Keep a recoverable previous installation and my private identity. Do not upgrade the live instance.
```

Checking only reports availability. An explicit update verifies compatibility and publisher continuity, presents the local changes and rollback, updates the actual host entry, and verifies loading. Reuse a compatible installation if the latest Skills cannot operate an older instance; an explicit compatible historical release is another option. Server upgrades remain a separate [deployment action](../deployment/updates.md).

An explicit version takes priority. An exact RC clearly carried forward for testing in the trusted conversation can also be selected; an incidental RC mention or current development branch does not choose it. Otherwise, use latest stable. The installed version and digest are fixed for verification; the host's long-term stable update source is checked separately. Temporary RC tests use the existing host entry and keep or restore that source. If the host cannot separate the installed RC from its saved source, explain the switch required before its next native stable update.

### Switch a Git source pinned to an old tag

```text
Switch my existing cfKanban Git installation from its fixed tag to the default stable branch and update the host entry.
Show the saved source and change first. Keep my identity and deployment records; do not upgrade the instance.
```

Only fixed-tag Git installations need this source change. Removing `--ref` from a copied Codex command does not alter an existing registration. Use the host's supported source-switch mechanism and verify the saved source, actual installed files, and selected release. Directory installations continue through verified bundle updates.

Report the canonical active receipt, host projection, and current conversation's loaded version separately. Updating one does not prove that all three changed. After an update, stop and restart the MCP and the owning `web open` process, then verify their running versions; replacing files does not update a running process. Closing a browser tab does not prove the local service stopped.

## Recover or remove the integration

A conflict requires reading the latest state. A timed-out or interrupted write may already have committed: preserve the original parameters and idempotency key, read back, and use the identical request if a retry is necessary. If identity changes, select and verify it again. Keep an uncertain operation's original view and recovery action rather than starting a replacement write or online opening.

Stop the local service through the host's terminal or process controls. Removing a host Skill/MCP configuration only removes that integration; it preserves `.cfkanban/`, identities, deployment records, and Issue history. Windows native, WSL, containers, SSH, and remote Hosts have independent execution homes. Use the connection flow in the intended environment instead of copying secrets to bypass a sandbox or network limit.
