# Open a board

cfKanban offers a local workbench and a full online app. **They access the same instance's tasks with the same permissions; the local workbench is not an offline copy.** Use the local workbench for daily tasks and the full online app for account or management features.

| | Local workbench / DSH sidebar | Full online app |
| --- | --- | --- |
| Best for | Viewing and moving tasks forward beside your Agent | Browsing the full application and managing your account and team |
| Daily tasks | Project switching, boards and lists, quick priority/status/assignee edits, details, comments, and completion | These daily actions plus all application entry points |
| Workspaces, members, access, and custom settings | Ask the Agent to open the appropriate management entry | Manage within your permissions and current session scope |
| How to open | Ask the Agent; in DSH, select the logo | Explicitly ask the Agent for online mode, or sign in to the site with a registered Passkey |
| Local requirements | Matching local components installed; included in the DSH plugin | A normal browser; Agent sign-in requires a usable local identity |

## Open the local workbench

```text
Open the local workbench for DemoProject using my current cfKanban identity.
```

You can also name a task:

```text
Open CFK-123 in the local workbench.
```

The Agent opens projects and tasks in local mode by default, starting the service when needed. In Codex App, it prefers the in-app browser when available; you can also request a specific browser. In DSH, use the sidebar beside your chat. If startup fails, the Agent explains the cause rather than switching to online mode without asking.

A [directory association](../usage/profile.md) can open the board for your current code project automatically; multiple matches still require a choice. Scroll the board horizontally to see all status columns and toward the bottom to load more tasks. Copy Markdown from details and comments, or copy a task ID or link to give to the Agent.

## Open the full online app

```text
Open the full online board for DemoProject.
```

The local workbench and DSH sidebar also have an **Open full online board** icon at the top right; hover to see its description. It opens the matching project or Issue with your current identity, usually without another sign-in. For management features, ask the Agent to open the appropriate management entry with a matching management session.

To register a Passkey, be explicit:

```text
Open the full online app so I can register a Passkey for my current identity.
```

After registration, you can sign in directly from the site's homepage. See [Joining and signing in](../usage/access.md) for the steps. Workspace and project administrators can use the [management entry points](../administration/index.md); instance-wide Owner features are under [Deploy and manage](../deployment/index.md).

Both interfaces need network access to the online instance. Closing the local page does not sign you out of the online app. After updating local components, restart the workbench or DSH as instructed by the Agent to use the new version.
