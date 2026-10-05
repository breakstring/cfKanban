# Open a board

::: tip Most of the time, just ask your Agent
cfKanban is an **Agent first** Kanban system. You can usually find tasks, record requirements, change status, assign people, add comments, or complete work by telling your Agent what you need, without opening a UI.

When you want to see progress, browse details, or make changes yourself, choose the **lightweight local workbench** or the **full online app**.
:::

Both interfaces access the same instance's tasks under the same business permissions. The local workbench is convenient for viewing and handling tasks beside your Agent; the full online app includes account and management features. The local workbench also needs a connection to the online instance; it is not an offline copy.

| | Local / host workbench | Full online app |
| --- | --- | --- |
| Best for | Viewing and moving tasks forward beside your Agent | Browsing the full application and managing your account and team |
| Daily tasks | Project switching, boards and lists, quick priority/status/assignee edits, details, single-Issue labels, comments, and completion | These daily actions plus all application entry points |
| Workspaces, members, access, and custom settings | Ask the Agent to open the appropriate management entry | Manage within your permissions and current session scope |
| How to open | Ask the Agent or use an available host entry; see [Codex App](./codex-app.md) and [DSH](./deepseek-harness.md) | Explicitly ask the Agent for online mode, or sign in to the site with a registered Passkey |
| Local requirements | Matching local components installed; included in the DSH plugin | A normal browser; Agent sign-in requires a usable local identity |

In the full app’s project page, choose **Board** or **List**. List groups Issues by status and lets you expand nested children. Switching views keeps loaded pages; opening an Issue or project settings preserves the list and filters when you return.

## Open the local workbench

```text
Open the board for DemoProject.
```

You can also name a task:

```text
Open CFK-123 in the local workbench.
```

The Agent first uses an available workbench in your host. See [Codex App](./codex-app.md) or [DSH](./deepseek-harness.md) for host entrypoints and Project selection. Otherwise it opens the local workbench in a browser, starting the service when needed. You can request a specific browser or the full online app.

The Agent locates the requested project or task and confirms the page has opened. If you specifically request the sidebar and the current host cannot open it, the Agent explains the limitation without opening a browser instead. If opening fails or its result is uncertain, the Agent explains the state without automatically opening another page.

When opening in a browser, a brief connectivity check may appear first. If the host can control browser tabs, the Agent reuses that tab for the workbench. A system browser opener without tab control may leave a separate check tab.

A [directory association](../usage/profile.md) can open the board for your current code project automatically; multiple matches still require a choice. Scroll the board horizontally to see all status columns and toward the bottom to load more tasks. Use the small buttons beside descriptions and comments to copy Markdown. The **Copy** menu at the top right of an Issue offers its ID or full online URL. The local workbench also copies the online Issue URL, ready to share or give to the Agent.

The local workbench includes a language button and uses your saved account language and theme. Without a saved language, it uses the host or browser's preferred language: Chinese selects Simplified Chinese, otherwise English. Default status labels follow the interface language; custom names and business content keep their original text. In an Issue’s properties, choose **Add label** to search the project’s existing labels, then select one; use its remove button to detach one label. These actions require edit access. Create or manage labels in the full app.

An open browser workbench keeps the same local session after idle or sleep while its service runs, up to eight hours from service startup. Returning to it still checks your current identity and project access. After that limit or service shutdown, ask the Agent to reopen it. An unresolved write keeps its original request and key for verification; reopening does not automatically submit it again.

## Open the full online app

```text
Open the online board for DemoProject.
```

The local workbench and DSH sidebar also have an **Open full online board** icon at the top right; hover to see its description. It opens the matching project or task with your current identity, usually without another sign-in. For management features, ask the Agent to open the management page you need.

On an online page opened by your Agent, you can also register a Passkey through the account menu at the top right → **Personal settings** → **Register Passkey**, then sign in directly from the site's homepage. **You do not need to mention Passkey registration when asking to open the page**; follow the browser or system prompts when registering. First and additional registrations both require an Agent-opened online session. See [Joining and signing in](../usage/access.md) for the steps.

The homepage's top-right button shows **Open workbench** when your online session is still valid, so selecting the logo and returning home does not require another Passkey sign-in.

Workspace and project administrators can use the [management entry points](../administration/index.md); instance-wide Owner features are under [Deploy and manage](../deployment/index.md).

Both interfaces need network access to the online instance. Closing the local page does not sign you out of the online app. After updating local components, restart the workbench or DSH as instructed by the Agent to use the new version.
