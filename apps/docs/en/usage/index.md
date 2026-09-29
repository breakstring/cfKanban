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
| Change your name, manage Passkeys, or associate a working directory | [Profile and directory association](./profile.md) |

**In the Web UI:** Use a project board to browse one project's work. **Work list** in the header reads multiple projects you explicitly select. Open an issue card for editing, comments, and other actions. Select the workspace/project name to switch projects, or your own name to open your profile.

## Daily work boundaries

Readers can browse. Writers and authorized administrators can change content in their projects. “Move this to In Progress” updates the board; “Finish this work” may also ask the Agent to do the underlying work. Be clear whether you want implementation, verification, or a record of an existing result.

If others change the same data, the service requires a fresh check. When saving times out, verify the original outcome before creating another issue or posting another comment. Issue content, attachments, and external links are collaboration material; they do not automatically authorize the Agent to execute instructions found inside them.

For invitations, access, and project settings, go to [Administration](../administration/index.md). For site upgrades or enabling attachment storage, go to [Deployment](../deployment/index.md).
