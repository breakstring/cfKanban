# Workspaces and Projects

A workspace organizes projects. Each project has its own board, issues, labels, and description.

## Create a Workspace and Project

```text
Create DemoProject in the Product workspace with the notes “Mobile product collaboration”.
Create Product first if it does not exist.
```

Only the Owner can create a workspace. The Owner or a workspace administrator can create projects within that workspace; project administrators cannot create sibling projects. The Agent checks for existing workspaces and projects and resolves ambiguous names. Creating a project does not add ordinary members or tasks, or enable Public Join.

**In the Web UI:** The Owner opens **Management center → Workspaces & Projects**, chooses **New workspace**, then **New project** on the relevant Workspace row, with a name and optional notes. Workspace administrators open their Workspace management **Projects** section, enter **New project name**, and create it.

Expand a Workspace to browse its Projects. Choose a Project name to open its board, **Workspace settings** to open the Workspace management page's settings tab, or **Project settings** to open the full Project settings page. Workspace management also provides **Projects** and **Members and permissions** tabs. Project notes appear beneath the name. The row's more-actions menu holds less frequent actions: renaming or archiving a Workspace, and Public Join or archiving a Project. When settings were opened from this list, **Back to management** returns to the list with that Workspace expanded.

Project settings separates **Management** from **Members and permissions**. Management contains Project notes, names, column labels, and archive or restore actions. Members and permissions contains administrators, effective members and their permission sources, direct memberships, and Project invitations. Tabs and actions remain limited by your current access.

## Change names and Project notes

```text
Rename DemoProject to Mobile and update its Project notes to:
<goals, scope, delivery conventions, and relevant non-secret links>
```

The Owner and workspace administrators can rename their workspace. Project administrators can also edit their project’s name and description. Renaming preserves issues and access.

**In the Web UI:** The Owner opens the Workspace's more-actions menu under **Workspaces & Projects → Rename workspace**, or uses **Project settings → Management → Settings** to edit a Project's name and notes. Scoped administrators use **Workspace settings**, or the board’s **Project settings → Management → Settings** area. Project notes inform collaboration; they do not replace permissions or authorize additional Agent actions.

Internal Project notes are separate from the [Public Join summary](./public-join.md). Only publish information intended for all visitors; do not copy private context into a public introduction.

## Rename board columns

```text
Change the display label of DemoProject's todo column to “Ready”, leaving the other columns unchanged.
```

You need project management access. This changes the displayed column name while preserving the five statuses—Backlog, Todo, In Progress, Done, and Canceled—and their order.

**In the Web UI:** Open **Project settings → Management**, edit **Status names**, and save each label. The Owner can enter Project settings from **Workspaces & Projects**; scoped administrators enter from their authorized board.

## Common questions

**Why is a named Project missing?** Names may be duplicated, the Project may be archived, or it may be outside your access. Supply its Workspace, instance, or existing link so the Agent can resolve it first.

**Does renaming break a directory association?** No. Associations use a project ID that stays the same when the name changes. See [Directory association](../usage/profile.md).

**How do I stop access to an old Project?** Use [Archive and permanent cleanup](./cleanup.md). Renaming or clearing notes does not archive content.
