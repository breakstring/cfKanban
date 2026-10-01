# Use

Once you have joined a project, tell the Agent what you want to find, record, or progress. Daily operations use the `cfkanban` Skill. You do not need to repeat installation or joining first.

```text
Use $cfkanban to show my unfinished issues in DemoProject,
then open the details of CFK-123 without making changes.
```

You need read access to the target project. Expect issues and details from the correct project. A read request neither claims work nor changes its status.

| Goal | Read |
| --- | --- |
| Accept an invitation, join a public project, sign in, or switch projects | [Joining and signing in](./access.md) |
| Find, create, edit titles/descriptions, or set priority | [Find, create, and edit issues](./issues.md) |
| Claim and assign work, change status, complete, reopen, or report blockers | [Workflow and assignees](./workflow.md) |
| Comments, attachments, labels, relations, handoffs, and restoration | [Collaboration and attachments](./collaboration.md) |
| Change your name or theme, manage Passkeys, or associate a working directory | [Profile and directory association](./profile.md) |

**In the Web UI:** Use a project board to browse one project's work. Open the account menu at the top right → **Work list** to read multiple projects you explicitly select. Open an issue card for editing, comments, and other actions. Select the workspace/project name to switch projects.

The account menu contains your name, role, **Work list**, **Management center** when available, **Personal settings**, and **Sign out**. The language switch stays outside the menu. When you are using another address, the footer shows the site’s recommended address.

Use the board’s **Project settings** button for the project’s management, labels, activity, and deleted issues; available tabs follow your current access.

## Daily work boundaries

Readers can browse. Writers and authorized administrators can change content in their projects. “Move this to In Progress” updates the board; “Finish this work” may also ask the Agent to do the underlying work. Be clear whether you want implementation, verification, or a record of an existing result.

If a save conflicts with someone else’s change, read the latest content first. If it times out, verify the result before creating another issue or comment.

For invitations, access, and project settings, go to [Administration](../administration/index.md). For site upgrades or enabling attachment storage, go to [Deployment](../deployment/index.md).
