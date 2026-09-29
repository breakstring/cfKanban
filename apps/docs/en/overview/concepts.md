# Concepts and roles

## Instances, workspaces, projects, and issues

```text
Use $cfkanban to confirm my current instance, identity, and accessible projects.
Show only non-sensitive information and do not change any permissions.
```

The Agent needs a trusted local identity in the current environment. Expect the exact site, current identity, and authorized projects, without credential contents.

| Concept | Meaning |
| --- | --- |
| Instance | An independently deployed cfKanban site with its own people, data, and access rules |
| Workspace | A container organizing projects; it is not a folder on your computer |
| Project | The main collaboration scope, with its own board, members, labels, and background |
| Issue | A trackable piece of work, such as a bug, request, or discussion, identified as `CFK-123` |
| Principal | Your stable identity in an instance; renaming it does not create an identity or change access |
| Assignee | The person responsible for an issue; assignment does not grant project access |

Workspaces and projects have stable IDs. Two objects with the same name are still distinct. Issue numbers are unique and never reused within an instance; separate instances can have the same numbers.

**In the Web UI:** The header shows the current workspace, project, and role in that project. Select your name to open **My profile** and view your identity ID. Select the workspace/project name to see the projects available to the current session.

## Who can do what

| Role or access | Main capabilities |
| --- | --- |
| Reader | Read authorized projects, issues, comments, relations, and available attachments |
| Writer | Read, create, edit, assign, comment, complete, soft-delete, and restore project content |
| Project administrator | Read/write project content, configure the project, and manage ordinary members |
| Workspace administrator | Read/write and manage current and future projects in that workspace; create projects and manage project administrators |
| Owner | The single instance owner, responsible for instance management, access, Public Join, recovery, and other instance-wide capabilities |

A writer is not automatically an administrator. Ordinary invitations and Public Join grant reader or writer access, not administration. Deployment also needs separate Cloudflare authority; application Owner access does not grant control of a cloud account.

A person can have both direct project access and administrator access. Removing one source can leave another effective source intact. See [Administration](../administration/index.md) for details.

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

Agents use a securely stored local identity. The Web UI uses an expiring session. For first access, ask an Agent to open an authenticated board, then register a Passkey to sign in directly on the same hostname later.

Having project access and being able to reach it through the current browser session are separate conditions. Older sessions and Owner sessions explicitly opened for one project can be narrower. Switching projects neither grants access nor extends a session. If an expected project is missing, ask the Agent to check your access and open the correct entry point; see [Joining and signing in](../usage/access.md).
