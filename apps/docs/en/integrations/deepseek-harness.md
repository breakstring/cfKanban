# DeepSeek Harness

The cfKanban DSH plugin supplies four Skills, the local stdio MCP, and an optional task sidebar beside chat. Desktop and Web use the same adapter but have independent profiles. The compatibility baseline is DSH `0.2.0-rc.2` and Node `>=22.12.0`; check the selected archive's compatibility metadata before installing into another version.

The sidebar reuses cfKanban's self-contained Vue workbench. DSH's Host handles the private identity and permitted operations; the embedded page receives task data through a dedicated message channel. It does not ask the browser to visit a separate localhost Web page and never receives the long-lived Credential. See the [local and online UI comparison](./index.md#local-and-online-web-ui).

## Obtain and verify the archive

```text
Use $cfkanban-deploy to check the published cfKanban release for this DSH version.
Prepare its verified Skill bundle and identify the DSH archive, exact version, source, and SHA-256 evidence.
Show the intended DSH profile and local installation changes before installing; do not deploy or upgrade an instance.
```

Start from the [official stable installation guide](https://github.com/breakstring/cfKanban/releases/latest/download/install.md) and [stable pointer](https://github.com/breakstring/cfKanban/releases/latest/download/stable.json). The Agent verifies the immutable release manifest, publisher continuity, allowed origins, and the SHA-256 of `cfkanban-skills-VERSION.zip`, then safely extracts the complete bundle. The fixed archive is inside that verified ZIP:

```text
cfkanban-skills-VERSION/
  dsh/cfkanban-dsh-VERSION.tgz
```

The release manifest publishes the Skill and Service ZIP digests; it does not provide a separate public DSH tarball URL or digest. The verified outer Skill ZIP establishes the DSH archive's source. You can record the extracted tarball's hash on macOS/Linux:

```sh
shasum -a 256 /absolute/path/cfkanban-skills-VERSION/dsh/cfkanban-dsh-VERSION.tgz
```

On Windows:

```powershell
Get-FileHash -Algorithm SHA256 'C:\absolute\path\cfkanban-dsh-VERSION.tgz'
```

A newly calculated hash identifies those local bytes; it does not independently prove their publisher. Keep the verified ZIP/manifest evidence and check the package's `artifact-manifest.json` version and component/file digests. If the selected published bundle has no `dsh/` archive, this plugin is unavailable from that release. Choose an exact published prerelease only when explicitly testing it. A source-built candidate records its checkout and dirty state and is not a canonical release.

Install the fixed prebuilt archive, not the source subdirectory or an unverified registry package. It includes complete Skills resources, shared runtime, prebuilt MCP, local runtime, and compiled sidebar assets; installation and startup need no cfKanban build or downloaded frontend dependencies.

## Install in Web

For an installed official DSH Web CLI, use the absolute path of the verified archive:

```sh
dsh plugin --profile web add /absolute/path/cfkanban-skills-VERSION/dsh/cfkanban-dsh-VERSION.tgz
```

Start or restart `dsh web` and open the actual loopback address it reports. An installation into `web` does not install into `desktop`. If you use a different existing Web profile, select that exact profile through DSH's documented mechanism. The [official bundle guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) documents profile installation from a prebuilt tarball and removal through the plugin manager.

## Install in Desktop

Launch Desktop once to initialize its profile, then **fully quit** it. Closing its window may leave the Host running. Install with the command supplied by that Desktop application, then reopen it. For a macOS application installed in `/Applications`, the command is:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /absolute/path/cfkanban-skills-VERSION/dsh/cfkanban-dsh-VERSION.tgz
```

Use the application's actual path if installed elsewhere. On other platforms use that installation's supplied command; do not guess a path or use a separately installed npm CLI to modify `desktop`. Desktop's **Manage dsh Command…** can expose its own command, and its **Plugins** page manages plugin rows. The bundled CLI manages plugins while Desktop is quit; it does not boot Desktop. See [official Desktop ownership](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime).

## Verify Skills, MCP, and the sidebar

In the intended profile's Plugins page, check that the `cfkanban-bundle`, `cfkanban-skills`, and `cfkanban-mcp` rows are active. Keep `cfkanban-panel` active if you want the sidebar. The bundle adds its own filesystem provider and MCP entry; preserve other providers and servers.

Verify discovery and loading of `cfkanban-howto`, `cfkanban`, `cfkanban-admin`, and `cfkanban-deploy`, including a referenced resource. From each resolved operational Skill directory, `node scripts/cfkanban-tool.mjs help` shows that Skill's command surface. The bundled provider is named `cfkanban` and uses rank 600. A project or user Skill with the same name can take precedence; inspect the loaded path if an old Skill appears. This follows the [official filesystem provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md).

```text
Call mcp__cfkanban__cfkanban_connection_inspect to check my local cfKanban connections.
Verify my identity on <instance> and my access to Project <UUID>. Show the returned identity and scope without changing tasks.
```

DSH's [official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) discovers the bounded daily tools under the `mcp__cfkanban__` namespace. Connection inspection uses the existing private identity of the Host's actual OS user. Joining, recovery, administration, deployment, and sensitive browser delivery still use Skills. Missing identity should lead to [joining](../usage/access.md) or [Owner device connection](../administration/devices.md), not a credential pasted into chat or plugin settings.

Open the task tab using the cfKanban logo button beside chat. Set the current DSH Session's workspace to your real Project working directory. The Host reads only that directory's `.cfkanban-scope.json`; use [directory association](../usage/profile.md) to prepare it. One valid Instance/Project target binds automatically after live identity and permission checks. Multiple targets require a selection within the recommendations. Missing, invalid, or unauthorized targets show a reason and keep manual selection available. This filter neither grants permission nor starts work.

Use the sidebar's Project switcher, board/list, details, and manual refresh. Permissions control the inline priority, status, and assignee actions, plus comments and completion. Copy the CFK identifier or Issue URL when referring an Agent to a task; it reads current data through Skills. Description and comment copy buttons provide raw Markdown with a manual-copy fallback. The original DSH Session supplies the workspace directory; switching another chat does not rebind an existing tab.

The sidebar's **Open full online board** action verifies the bound identity and exact target, then uses the existing temporary Browser Launch to open the system browser. If the result is uncertain, use **Recover original online opening** instead of creating another launch. The Host keeps the original request and blocks Project switching and new writes until it is resolved.

The sidebar supports a local, single-user Host listening on loopback. Public, unknown, remote, or multi-user Host use is unsupported. WSL, containers, SSH, and remote machines do not inherit this computer's private identity.

## Node and profile settings

By default, the bundle uses the running Host's absolute executable for stdio MCP. Desktop uses its bundled Electron in Node mode; it does not depend on GUI PATH. To use a verified standalone Node, set the bundle row through plugin settings or the profile's own patch layer:

```yaml
- id: cfkanban-bundle
  config:
    nodeExecutable: /absolute/path/to/node
```

The runtime checks that executable with a bounded version probe. Missing or incompatible Node is reported without modifying global Node, PATH, or shell settings. Keep credentials out of this configuration and environment variables.

## Update, disable, and remove

Install another verified fixed archive into the same intended profile using the same `add` command. Restart the Web Host or fully quit and reopen Desktop, then verify the MCP initialize version, actual Skill paths, connection identity, and scope against that archive. Updated files or an active receipt do not replace an already running MCP. Local plugin updates never upgrade the Cloudflare instance; version selection and restoration rules are in [General](./general.md#update-local-skills).

Disable `cfkanban-panel` in Plugins to retain Skills and MCP without the sidebar. To remove the full plugin from Web:

```sh
dsh plugin --profile web remove @cfkanban/dsh-plugin
```

For Desktop, use its bundled command with `--profile desktop` while the application is fully quit. DSH removes the package and its layer. Disabling or removing the integration preserves `.cfkanban/`, credentials, deployment records, and Issue history.

## Common problems

| Symptom | What to check |
| --- | --- |
| Plugin appears in Web but not Desktop | They are independent profiles; install and restart the intended one. |
| A Skill is absent or old | Check row activation, actual loaded path, a conflicting project/user Skill, and the selected archive version. |
| MCP tools are missing | Check `cfkanban-mcp` activation, verified Node and fixed server entry, startup failure, and actual discovery. Reload the row or restart after reconnect attempts are exhausted. |
| No identity or Project access | Verify the Host's OS user/environment, trusted instance, live identity, and current permission. Use the corresponding connection flow. |
| Wrong or missing Project recommendation | Check the source Session's registered workspace and its scope file; choose a target explicitly rather than broadening the query. |
| Conflict, timeout, or interrupted write | Read current state; retain original parameters and idempotency key. Use the original view's recovery action, and verify the service result after a Host restart before writing again. |
| Host, sandbox, network, or browser restriction | Report the blocked boundary. Do not copy credentials, weaken permissions, or silently select a different environment. |

Inspect only activation, loaded paths, version/digest, Node version, MCP readiness, non-secret identity metadata, and explicit scope. Do not print the full DSH configuration, LLM/API secrets, private credential files, or one-time browser capabilities.
