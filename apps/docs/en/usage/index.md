# Daily collaboration

This section is for ordinary members and people who manage workspaces or projects. Only the Owner maintaining the whole site needs [Deploy and manage](../deployment/index.md).

Once you have joined a project, tell the Agent what you want to find, record, or move forward. You do not need to repeat installation or joining. Daily work can stay in the conversation; ask to open a board when you want to see it yourself.

```text
List my unfinished tasks in DemoProject and summarize the latest progress on CFK-123.
```

Viewing tasks requires read access to the target project. It does not claim tasks or change their status.

| Goal | Read |
| --- | --- |
| Accept an invitation, join a public project, sign in, or switch projects | [Joining and signing in](./access.md) |
| Find, create, edit titles/descriptions, or set priority | [Find, create, and edit tasks](./issues.md) |
| Claim or assign, move status, complete, reopen, or report a block | [Workflow and assignees](./workflow.md) |
| Comments, attachments, labels, relations, copying task content, and deletion recovery | [Collaboration and attachments](./collaboration.md) |
| Change your name or theme, manage Passkeys, or associate a working directory | [Profile and directory associations](./profile.md) |

**In the full online app:** Use the project board to browse one project's work. The account menu at the top right → **Work list** reads multiple explicitly selected projects. Select a task card to open its details, edit, comment, and take other actions. Use the workspace/project name in the header to switch projects.

The account menu brings together your name, role, **Work list**, **Management center** when authorized, **Personal settings**, and **Sign out**. Language selection remains outside it. If you use a different access address, the footer shows the site's recommended address.

The board's **Project settings** provides **Management**, **Members and permissions**, **Labels**, **Activity**, and **Deleted issues**. Available tabs depend on your permissions.

## Daily work boundaries

Readers can browse; writers and authorized administrators can write within the relevant project. “Change the status to In Progress” only updates the board. “Complete this work” may also ask the Agent to do the work itself, so specify whether you want implementation, verification, or only a recorded result.

If collaborators encounter a save conflict, read the latest content first. If a save times out, verify its result before creating another task or comment.

To connect your current Agent, see [Installation and connections](../integrations/index.md). To choose the local or online interface, see [Open a board](../integrations/webui.md). For inviting members or maintaining projects, continue with [Manage workspaces and projects](../administration/index.md); you do not need to deploy a site.

[Public CLI task guides](../cli/index.md) cover the same Service semantics from a terminal.
