# DeepSeek Harness

The DSH plugin adds cfKanban Skills, MCP, and a task sidebar beside your chat in one installation. **Once installed, you do not need to install the Skills or configure MCP separately.** This page covers DSH desktop and Web running on your own computer. The current compatibility baseline is DSH `0.2.0-rc.2`.

## Ask your current Agent to install

```text
Read the official cfKanban installation guide:
https://github.com/breakstring/cfKanban/releases/latest/download/install.md
Install the cfKanban plugin for DeepSeek Harness desktop on this computer, including Skills, MCP, and the sidebar.
Use a compatible release containing the DSH plugin, preserve my identity and other plugins, and verify it is available.
Do not deploy or upgrade an online instance.
```

For the Web version, replace “desktop” with “Web.” Their plugin locations are separate; installing in one does not install in the other. Include the exact version when requesting a prerelease.

The Agent prepares the plugin package from the official release and installs it in the DSH version you choose. It gives specific instructions if you need to enable it in Plugins or reopen DSH. If you do not yet have a cfKanban identity, continue with [Joining and signing in](../usage/access.md). Installing the plugin does not join a project.

## Can I install by entering the repository URL in DSH?

**DSH supports online installation sources, but the cfKanban source repository URL is not currently a direct installation source.** DSH accepts Git, npm, or archive URLs. The complete cfKanban plugin currently comes inside the Skills release package, with no separate online plugin package entry point. Neither the repository root nor the Skills ZIP URL is a directly installable DSH plugin.

This does not require a separate repository. A future release can offer the same prebuilt plugin package as a separate download, with its fixed-version URL usable in DSH. For now, use the local file method below or let the Agent handle installation.

If you prefer the desktop UI, first ask the Agent to prepare the verified plugin file:

```text
Prepare the official cfKanban plugin package compatible with my DSH, verify it, and give me its local file path.
I will install it manually in DSH's Plugins page.
```

Open **Plugins → Add plugin**, enter the local `.tgz` path provided by the Agent, select **Install**, then **Enable now**. Restart if DSH asks. You do not need to unpack source code or calculate digests yourself. See the [official DSH plugin UI guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-plugin-manager/README.md) for supported entry points.

## Open the project sidebar

1. Open your working project directory in DSH.
2. Select the **cfKanban logo** beside the chat panel.
3. If the directory has a project association, the sidebar checks your identity and access, then opens the sole matching project. Choose a target when there are several.

Without an association, select a project manually or ask the Agent to [save a project association](../usage/profile.md) for the directory. An association only helps selection; it does not grant access. The plugin uses the identity on the computer running DSH. Remote or shared multi-user DSH services are outside the sidebar's current support scope.

The sidebar supports project switching, boards and lists, quick changes to priority, status, and assignee, and task details, comments, and completion. **Open full online board** opens the current project or Issue online. For workspace, member, or Owner management, ask the Agent to open the [appropriate management entry](../administration/index.md) with a matching management session. See [Open a board](./webui.md) for the two interfaces.

The DSH Web version also embeds the sidebar through the plugin; you do not need to open a separate local workbench page in your browser.

## Update or troubleshoot

```text
Check and update the cfKanban plugin in my current DSH, preserving my identity and other plugins.
Explain which applications or sessions need to restart, then verify the Skills, MCP, and sidebar.
```

If the plugin is missing, check whether you installed it in the desktop or Web version you are using, whether it is enabled, and whether a restart is needed. If the sidebar opens but shows no projects, check [membership and access](../usage/access.md). Reinstalling the plugin does not resolve missing permissions.
