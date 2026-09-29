# Workspaces and Projects

A workspace organizes projects. Each project has its own board, issues, labels, and description.

## Create a Workspace and Project

```text
Use $cfkanban-admin to create DemoProject in the Product workspace with the notes “Mobile product collaboration”.
Create Product if it does not exist, then open the board.
```

Creating a Workspace requires the Owner. The Owner or a Workspace administrator can create Projects in that Workspace. Project administrators cannot create sibling Projects. The Agent checks existing containers, resolves ambiguous names, and reports the exact containers. Project creation does not automatically add ordinary members, Issues, or Public Join.

**In the Web UI:** The Owner opens **Administration → Workspaces & Projects**, creates a Workspace, then creates a Project inside it with a name and optional notes. Workspace administrators open their Workspace management **Projects** section, enter **New project name**, and create it.

## Change names and Project notes

```text
Use $cfkanban-admin to rename DemoProject to Mobile and update its Project notes to:
<goals, scope, delivery conventions, and relevant non-secret links>
```

The Owner and workspace administrators can rename their workspace. Project administrators can also edit their project’s name and description. Renaming preserves issues and access.

**In the Web UI:** The Owner changes the Workspace name under **Workspaces & Projects**, or opens a Project's **Settings** to edit its name and notes. Scoped administrators use **Workspace settings** or the Project management **Settings** area. Project notes inform collaboration; they do not replace permissions or authorize additional Agent actions.

Internal Project notes are separate from the [Public Join summary](./public-join.md). Only publish information intended for all visitors; do not copy private context into a public introduction.

## Rename board columns

```text
Use $cfkanban-admin to change the display label of DemoProject's todo column to “Ready”, leaving the other columns unchanged.
```

You need project management access. This changes the displayed column name while preserving the five statuses—Backlog, Todo, In Progress, Done, and Canceled—and their order.

**In the Web UI:** The Owner uses Project **Settings → Board column names**. Scoped administrators edit **Status names** on the Project management page and save each label.

## Common questions

**Why is a named Project missing?** Names may be duplicated, the Project may be archived, or it may be outside your access. Supply its Workspace, instance, or existing link so the Agent can resolve it first.

**Does renaming break a directory association?** Valid associations use stable Project IDs, so renaming does not change them. See the [Usage overview](../usage/index.md) for directory associations.

**How do I stop access to an old Project?** Use [Archive and permanent cleanup](./cleanup.md). Renaming or clearing notes does not archive content.
