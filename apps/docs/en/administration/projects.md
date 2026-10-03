# Workspaces and Projects

A workspace organizes projects. Each project has its own board, issues, labels, and description.

## Create a Workspace and Project

```text
Create DemoProject in the Product workspace with the notes “Mobile product collaboration”.
Create Product first if it does not exist.
```

Only the Owner can create a workspace. The Owner or a workspace administrator can create projects within that workspace; project administrators cannot create sibling projects. The Agent checks for existing workspaces and projects and resolves ambiguous names. Creating a project does not add ordinary members or tasks, or enable Public Join.

**In the Web UI:** The Owner opens **Management center → Workspaces & Projects**, creates a Workspace, then creates a Project inside it with a name and optional notes. Workspace administrators open their Workspace management **Projects** section, enter **New project name**, and create it.

## Change names and Project notes

```text
Rename DemoProject to Mobile and update its Project notes to:
<goals, scope, delivery conventions, and relevant non-secret links>
```

The Owner and workspace administrators can rename their workspace. Project administrators can also edit their project’s name and description. Renaming preserves issues and access.

**In the Web UI:** The Owner changes the Workspace name under **Workspaces & Projects**, or opens a Project's **Settings** to edit its name and notes. Scoped administrators use **Workspace settings**, or the board’s **Project settings → Management → Settings** area. Project notes inform collaboration; they do not replace permissions or authorize additional Agent actions.

Internal Project notes are separate from the [Public Join summary](./public-join.md). Only publish information intended for all visitors; do not copy private context into a public introduction.

## Rename board columns

```text
Change the display label of DemoProject's todo column to “Ready”, leaving the other columns unchanged.
```

You need project management access. This changes the displayed column name while preserving the five statuses—Backlog, Todo, In Progress, Done, and Canceled—and their order.

**In the Web UI:** The Owner uses Project **Settings → Board column names**. Scoped administrators open the board’s **Project settings → Management**, edit **Status names**, and save each label.

## Common questions

**Why is a named Project missing?** Names may be duplicated, the Project may be archived, or it may be outside your access. Supply its Workspace, instance, or existing link so the Agent can resolve it first.

**Does renaming break a directory association?** No. Associations use a project ID that stays the same when the name changes. See [Directory association](../usage/profile.md).

**How do I stop access to an old Project?** Use [Archive and permanent cleanup](./cleanup.md). Renaming or clearing notes does not archive content.
