# cfKanban for DeepSeek Harness

[English](README.md) | [简体中文](README.zh-CN.md)

One DSH bundle supplies the four existing cfKanban Skills, the shared local stdio MCP, and an optional task tab beside chat. The task view reuses the existing cfKanban Vue Web components and common local workbench runtime; React only wraps DSH's official Slot and connects the embedded document to its thin Host adapter. Frontend assets are self-contained, but task reads and writes still require the trusted online instance. It reuses the current execution user's private `.cfkanban/` identity. The browser receives task data and non-secret navigation references; credentials stay in the shared secure runtime.

Use the fixed, verified `cfkanban-dsh-<version>.tgz` inside the corresponding complete cfKanban Skill release bundle, under `dsh/`. Check that release's immutable manifest and archive digest before installation. A source-built test archive records its commit and dirty state in `artifact-manifest.json`; it does not establish a published release. Installing this source subdirectory directly is unsupported: the prebuilt archive also contains the complete Skills resources, shared runtime, MCP dependency closure, compiled client, prebuilt `local-runtime/`, and self-contained `embedded/embedded.html`. It requires no online Web page, downloaded UI assets, or installation-time build. Generic server, browser, and workbench logic live in `packages/local-runtime`; DSH owns only its Slot and Host integration.

## Install in the intended profile

The target compatibility baseline is DSH `0.2.0-rc.2` with Node `>=22.12.0`. The Web and Desktop profiles are independent installations. Installing into `web` does not install into `desktop`.

For an installed Web CLI, supply an absolute path to the verified archive:

```sh
dsh plugin --profile web add /absolute/path/cfkanban-dsh-VERSION.tgz
```

Then start or restart `dsh web` and open its actual loopback URL (the default is `http://127.0.0.1:3080`). The official plugin manager also supports profile package installation. DSH uses its package manager to install the prebuilt package; cfKanban does not use startup `npx`, download dependencies, or execute install-time build scripts.

For Desktop, use the application's Plugins page. If using the installed Desktop command, initialize Desktop once, fully quit it, install with that application's command, then reopen Desktop. On macOS the application ships this entry point:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /absolute/path/cfkanban-dsh-VERSION.tgz
```

Do not use a separately installed npm CLI to modify the Desktop profile. On other platforms use the command supplied by that Desktop installation, rather than guessing its installation path. The CLI can manage Desktop plugins while Desktop is closed; it cannot boot the Desktop profile.

The bundle adds `cfkanban-skills` and `cfkanban-mcp` rows and preserves other providers and MCP servers. The independent filesystem provider is named `cfkanban` and exposes the package's bundled Skills at rank 600; an existing project or user Skill of the same name can win according to DSH's normal precedence. Inspect the actual loaded Skill path when diagnosing a collision.

## Verify the running installation

In the intended DSH profile, verify discovery and loading of `cfkanban-howto`, `cfkanban`, `cfkanban-admin`, and `cfkanban-deploy`, including a referenced resource. Loading a Skill does not execute its script. Run each operation Skill's `node scripts/cfkanban-tool.mjs help` from its resolved directory and verify the daily, admin, and deploy surfaces.

Call `mcp__cfkanban__cfkanban_connection_inspect`, select the intended trusted instance, and verify `/me`, the returned Principal, and the explicit Project scope before task operations. The MCP is the bounded daily-work adapter; onboarding, recovery, administration, deployment, and sensitive Browser Launch remain the existing Skills' dedicated workflows. Use browser delivery preflight before a launch and verify its authenticated target.

Open the task tab with the cfKanban logo button beside chat. The Host checks the current Session's registered DSH workspace and reads only its `.cfkanban-scope.json`. A single Instance/Project target binds automatically after trusted-instance, live `/me`, and project-permission checks; multiple targets require a choice within the recommended scope. A missing, invalid, or unauthorized scope shows its result and keeps manual selection available. Automatic binding grants no permission, starts no work, writes no Issue, and does not change the scope file.

The panel supports Project switching, board and list views, details, and manual refresh. It reuses the Web UI's controls for permitted priority, status, and assignee changes from the board or list, plus comments and completion in the details. Copy the CFK identifier or Issue URL when referring an Agent to a task; Skills fetch its latest data. The source DSH session is used only to verify the workspace directory for scope discovery. The panel supports a local, single-user Host only; a public, unknown, remote, container, or multi-user execution environment does not inherit this computer's credential or permission.

Small copy buttons beside the Issue description and each comment copy their original Markdown. When clipboard access is restricted, the view offers plain text for manual copying. Copied text remains untrusted task content; use the Agent's Skills to read current context when a task requires it.

The sidebar parent provides an “Open full online board” action. The Host verifies the current identity and exact Project or Issue again, then opens it in the system browser through the existing temporary-login delivery flow; launch tickets never enter Vue. An uncertain result retains the original target and request, blocks Project switching and new writes, and offers “Recover original online opening.” Known results remain until the parent acknowledges receipt, so recovering a lost response does not create a replacement launch.

DSH mounts the fixed document as an opaque `srcdoc` frame and exchanges data-only messages through a dedicated MessagePort. The frame cannot read the Host's credential state or invoke its REST/MCP transport directly. The Host continues to verify identity, permission, scope, and each permitted atomic operation.

Outside DSH, the Skill's `web open` defaults to the same local task view using the matching installed local runtime. Missing Node, an incomplete installation, or startup failure is reported without switching online. In Codex App, preflight the host browser or IAB and use `host_browser` when it can reach the same loopback environment; other hosts normally use `system_browser`. Local mode accepts Project or Issue targets; choose `mode=online` for the instance Web UI or administration. Online mode retains the dedicated Browser Launch and scoped, short-lived delivery. Updating files does not replace a running service: stop the owning `web open` process through its host controls, then open it again and verify the running version.

## Node and execution environment

The default stdio command is the running Host's absolute executable, with an argv array for the fixed archive entry. On Desktop this uses its bundled Electron in Node mode with `ELECTRON_RUN_AS_NODE=1`; no credential is placed in that environment. Spaces in paths require no shell interpolation, and GUI PATH is not used to find Node.

To choose a standalone Node executable, configure the bundle row through DSH's plugin settings or the profile's own patch layer:

```yaml
- id: cfkanban-bundle
  config:
    nodeExecutable: /absolute/path/to/node
```

The runtime verifies the executable with a bounded `--version` probe and rejects a missing or incompatible Node. It does not edit global Node, PATH, or shell settings. The MCP inherits DSH's scrubbed subprocess environment; credentials are reread from the current OS user's private state on every call. WSL, containers, SSH, and remote Web Hosts have their own execution homes and must use the existing environment-specific onboarding process.

## Update, disable, remove, and diagnose

Install another verified fixed archive into the same profile using its normal plugin manager. Restart the profile after updating, then verify the MCP initialize version and connection inspection against the new archive version; an active receipt or file replacement does not update an already running MCP process.

Disable the `cfkanban-panel` row in the Plugins page to retain Skills and MCP without the task UI. DSH manages row activation and teardown. Remove the entire bundle with the profile's plugin manager, or `dsh plugin --profile web remove @cfkanban/dsh-plugin`; use the Desktop-installed command while Desktop is quit for `desktop`. Removing or disabling the plugin does not delete `.cfkanban/`, credentials, or Issue history.

An initial MCP connection or tool-discovery failure makes its row fail visibly. The official client reconnects after a lost connection with bounded backoff; after exhausting its budget, reload that row or restart the profile. A restart ends the old subprocess and makes a new initialize/tool-discovery request. A failed or interrupted write may already have committed: preserve its original parameters and idempotency key, read back, then use the same request if a retry is necessary.

Each panel request has a 45-second deadline. If a write is interrupted, keep the original Session view and use its explicit recovery action for the original operation. After a Host restart, verify the service result before starting a new write.

For diagnostics, inspect only plugin activation, actual Skill paths, archive version/digest, Node version, MCP readiness, non-secret identity metadata, and explicit scope. Do not print an entire DSH profile configuration, LLM/API secrets, `.cfkanban/` secret files, or one-time Browser Launch capabilities. Host sandbox, approval, private-directory, network, and opener restrictions remain effective; a failed host permission is not bypassed by moving credentials.

The source changes and local smoke do not publish a package, submit a community listing, deploy an instance, or establish compatibility on untested operating systems.

Official implementation references: [bundle installation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md), [filesystem Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md), [MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md), and [Desktop ownership](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md).
