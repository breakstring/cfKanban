# Workspaces and Projects

A Workspace organizes Projects. A Project contains a board, Issues, Labels, and Project notes. A Workspace is not a local folder: names help identify it, while stable IDs determine the actual target.

## Create a Workspace and Project

```text
Use $cfkanban-admin to create DemoProject in the Product workspace with the notes “Mobile product collaboration”.
Create Product if it does not exist, then open the board.
```

Creating a Workspace requires the Owner. The Owner or a Workspace administrator can create Projects in that Workspace. Project administrators cannot create sibling Projects. The Agent checks existing containers, resolves ambiguous names, and reports the exact containers. Project creation does not automatically add ordinary members, Issues, or Public Join.

**In the Web UI:** The Owner opens **Administration → Workspaces & Projects**, creates a Workspace, then creates a Project inside it with a name and optional notes. Workspace administrators open their Workspace management **Projects** section, enter **New project name**, and create it.

Workspace and Project creation are separate operations. If the Workspace was created but Project creation fails, the report should explain that state. The Workspace is not automatically deleted.

## Change names and Project notes

```text
Use $cfkanban-admin to rename DemoProject to Mobile and update its Project notes to:
<goals, scope, delivery conventions, and relevant non-secret links>
```

The Owner and Workspace administrators can rename their Workspace. The Owner, parent Workspace administrator, or Project administrator can edit the Project name and notes. Renaming preserves stable IDs, Issues, and access; existing URLs use IDs.

**In the Web UI:** The Owner changes the Workspace name under **Workspaces & Projects**, or opens a Project's **Settings** to edit its name and notes. Scoped administrators use **Workspace settings** or the Project management **Settings** area. Project notes inform collaboration; they do not replace permissions or authorize additional Agent actions.

Internal Project notes are separate from the [Public Join summary](./public-join.md). Only publish information intended for all visitors; do not copy private context into a public introduction.

## Rename board columns

```text
Use $cfkanban-admin to change the display label of DemoProject's todo column to “Ready”, leaving the other columns unchanged.
```

You need permission to manage Project settings. This changes only the Project's display label. The five fixed status keys remain `backlog`, `todo`, `in_progress`, `done`, and `canceled`, with the same count, order, and completion semantics. Renaming cannot add custom statuses or bypass completion records.

**In the Web UI:** The Owner uses Project **Settings → Board column names**. Scoped administrators edit **Status names** on the Project management page and save each label.

## Common questions

**Why is a named Project missing?** Names may be duplicated, the Project may be archived, or it may be outside your access. Supply its Workspace, instance, or existing link so the Agent can resolve it first.

**Does renaming break a directory association?** Valid associations use stable Project IDs, so renaming does not change them. See the [Usage overview](../usage/index.md) for directory associations.

**How do I stop access to an old Project?** Use [Archive and permanent cleanup](./cleanup.md). Renaming or clearing notes does not archive content.
