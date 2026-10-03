# Open a board

::: tip Most of the time, just ask your Agent
cfKanban is an **Agent first** Kanban system. You can usually find tasks, record requirements, change status, assign people, add comments, or complete work by telling your Agent what you need, without opening a UI.

When you want to see progress, browse details, or make changes yourself, choose the **lightweight local workbench** or the **full online app**.
:::

Both interfaces access the same instance's tasks under the same business permissions. The local workbench is convenient for viewing and handling tasks beside your Agent; the full online app includes account and management features. The local workbench also needs a connection to the online instance; it is not an offline copy.

| | Local workbench / DSH sidebar | Full online app |
| --- | --- | --- |
| Best for | Viewing and moving tasks forward beside your Agent | Browsing the full application and managing your account and team |
| Daily tasks | Project switching, boards and lists, quick priority/status/assignee edits, details, comments, and completion | These daily actions plus all application entry points |
| Workspaces, members, access, and custom settings | Ask the Agent to open the appropriate management entry | Manage within your permissions and current session scope |
| How to open | Ask the Agent; in DSH, select the logo | Explicitly ask the Agent for online mode, or sign in to the site with a registered Passkey |
| Local requirements | Matching local components installed; included in the DSH plugin | A normal browser; Agent sign-in requires a usable local identity |

## Open the local workbench

```text
Open the board for DemoProject.
```

You can also name a task:

```text
Open CFK-123 in the local workbench.
```

The Agent opens projects and tasks in local mode by default, starting the service when needed. In Codex App, it prefers the in-app browser when available; you can also request a specific browser. In DSH, use the sidebar beside your chat. If startup fails, the Agent explains the cause rather than switching to online mode without asking.

A [directory association](../usage/profile.md) can open the board for your current code project automatically; multiple matches still require a choice. Scroll the board horizontally to see all status columns and toward the bottom to load more tasks. Copy Markdown from details and comments, or copy a task ID or link to give to the Agent.

## Open the full online app

```text
Open the online board for DemoProject.
```

The local workbench and DSH sidebar also have an **Open full online board** icon at the top right; hover to see its description. It opens the matching project or task with your current identity, usually without another sign-in. For management features, ask the Agent to open the management page you need.

On an online page opened by your Agent, you can also register a Passkey through the account menu at the top right → **Personal settings** → **Register Passkey**, then sign in directly from the site's homepage. **You do not need to mention Passkey registration when asking to open the page**; follow the browser or system prompts when registering. First and additional registrations both require an Agent-opened online session. See [Joining and signing in](../usage/access.md) for the steps.

Workspace and project administrators can use the [management entry points](../administration/index.md); instance-wide Owner features are under [Deploy and manage](../deployment/index.md).

Both interfaces need network access to the online instance. Closing the local page does not sign you out of the online app. After updating local components, restart the workbench or DSH as instructed by the Agent to use the new version.
