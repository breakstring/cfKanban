# Concepts and roles

## Instances, workspaces, projects, and issues

```text
Which cfKanban site am I using, and which projects can I access?
```

If you have already connected cfKanban, your Agent can show the site, your identity, and the projects you can access.

| Concept | Meaning |
| --- | --- |
| Instance | An independently deployed cfKanban site with its own people, data, and access rules |
| Workspace | A container organizing projects; it is not a folder on your computer |
| Project | The main collaboration scope, with its own board, members, labels, and description |
| Issue | A trackable piece of work, such as a bug, request, or discussion, identified as `CFK-123` |
| Principal | Your stable identity in an instance; renaming it does not create an identity or change access |
| Assignee | The person responsible for an issue; assignment does not grant project access |

Projects can share a name; include the workspace when needed. Different sites can also have the same issue number, so include the site address when working across instances.

**In the full online app:** The header shows the current workspace and project. Open the account menu at the top right to see your name and current role; choose **Personal settings** to view your identity ID. Select the workspace/project name to see the projects available to the current session.

## Who can do what

| Role or access | Main capabilities |
| --- | --- |
| Reader | Read authorized projects, issues, comments, relations, and available attachments |
| Writer | Read, create, edit, assign, comment, complete, soft-delete, and restore project content |
| Project administrator | Read/write project content, configure the project, and manage ordinary members |
| Workspace administrator | Read/write and manage current and future projects in that workspace; create projects and manage project administrators |
| Owner | The single instance owner, responsible for instance management, access, Public Join, recovery, and other instance-wide capabilities |

A writer is not automatically an administrator. Ordinary invitations and Public Join grant reader or writer access, not administration. Deployment also needs separate Cloudflare authority; application Owner access does not grant control of a cloud account.

A person can have both direct project access and administrator access. Removing one source can leave another effective source intact. See [Manage workspaces and projects](../administration/index.md) for details.

## Workflow and history

| Fixed status | Meaning |
| --- | --- |
| Backlog | Recorded without a commitment to begin soon |
| Todo | Ready to be scheduled or started |
| In Progress | Work is underway |
| Done | Confirmed through the completion action, with a completion record |
| Canceled | Work will no longer be pursued |

Projects can customize column labels, but cannot add a sixth status or change these meanings. Priority, assignee, and blockers are separate from status. Completion records cannot be edited or deleted. Reopening an issue preserves its earlier completion history.

## Authentication and access scope

Agents use a securely stored local identity; the online app uses an expiring session. Daily work with your Agent does not require opening a browser. When you want to browse the board yourself, [ask the Agent to open it](../integrations/webui.md). You can register a Passkey on an Agent-opened online page to sign in directly on the same hostname later.

Switching projects does not grant access or extend your sign-in. If a project is missing, ask the Agent to check your access and open it again; see [Joining and signing in](../usage/access.md).
