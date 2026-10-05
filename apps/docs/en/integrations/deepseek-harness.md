# DeepSeek Harness

In DeepSeek Harness, **cfKanban Skills are the main way to collaborate with your Agent**: find tasks, update progress, add comments, and record completion. The integrated plugin also adds a sidebar beside the conversation, so you can browse and work on the board while chatting.

This page covers DSH desktop and Web running on your own computer. The current compatibility baseline is DSH `0.2.0-rc.2`.

## Install and connect

```text
Read the official cfKanban installation guide:
https://github.com/breakstring/cfKanban/releases/latest/download/install.md
Install cfKanban for DeepSeek Harness desktop on this computer.
Use a compatible release containing the DSH plugin, preserve my identity and other plugins, and verify it is available.
Do not deploy or upgrade an online instance.
```

For the Web version, replace “desktop” with “Web.” Their plugin locations are separate; installing in one does not install in the other. Include the exact version when requesting a prerelease.

The Agent installs the official plugin, which includes the cfKanban Skills and sidebar. You do not need separate installations or manual connection settings. It gives specific instructions if you need to enable it in Plugins or reopen DSH. For your first use, continue with [Joining and signing in](../usage/access.md). You can start collaborating once you have project access.

For manual installation, ask the Agent to prepare a verified local `.tgz` plugin file. Enter its path in **Plugins → Add plugin**, select **Install → Enable now**, and restart if prompted. The cfKanban source repository and Skills ZIP URLs are not currently direct installation sources for this entry point.

## Collaborate through Skills

Once installed, tell the Agent what you want to do, just as you would in another Agent:

```text
Show my unfinished tasks in the current project, ordered by priority.
```

You can also ask the Agent to create tasks, change priorities or assignees, add comments, and record completion. See [Issues and boards](../usage/issues.md) for everyday work. The daily guidance in [General Agents](./general.md) also applies. If you often work in the same directory, [associate it with a project](../usage/profile.md) to reduce repeated selection.

## Use the sidebar alongside your conversation

When you want to view tasks while chatting, ask the Agent to open the sidebar:

```text
Open CFK-123 in the sidebar.
```

You can also name a project. With a compatible plugin enabled, the Agent opens the requested board or Issue details. If the sidebar is unavailable, it explains the current limitation.

[![DeepSeek Harness shows the conversation on the left and CFK-600 details in the cfKanban sidebar on the right](../../assets/integrations/dsh-sidebar.png)](../../assets/integrations/dsh-sidebar.png)

*The sidebar lets you view tasks and boards beside the conversation. This screenshot shows the desktop layout; click it to open the original.*

To open it manually, open your working directory in DSH and select the **cfKanban logo** beside the chat panel. A project association opens the matching project; follow the selection prompt if there are several targets or no association.

Switch projects in the sidebar, browse tasks in **Kanban** or **List**, and select a task to read its details. With the appropriate access, you can also edit tasks, add comments, and record completion. **Open full online board** opens the online page. See [Open a board](./webui.md) for account and management features.

The DSH Web version also supports the sidebar. The plugin uses the identity on the computer running DSH. The sidebar currently supports local single-user use; remote or shared multi-user DSH services are not yet supported.

If a write has an uncertain result, use **Recover** in the original view before closing the sidebar or restarting DSH.

## Update or troubleshoot

```text
Update the cfKanban plugin in my current DSH to the latest compatible stable release.
Preserve my identity and other plugins, check that it works, and tell me what needs to restart.
```

Local updates and [online instance upgrades](../deployment/updates.md) are separate. If Skills or the sidebar are missing, check whether you installed in the desktop or Web version you are using, whether the plugin is enabled, and whether a restart is needed. If projects are missing, check [membership and access](../usage/access.md).
