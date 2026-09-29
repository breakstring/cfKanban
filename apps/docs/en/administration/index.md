# Administration

Use `cfkanban-admin` to organize Workspaces and Projects, manage members and invitations, and maintain Owner settings. See [Usage](../usage/index.md) for daily collaboration and [Deployment](../deployment/index.md) for Cloudflare maintenance.

## Find your management scope

```text
Use $cfkanban-admin to check my identity and management scope at <instance address>, and list the Workspaces and Projects I can manage.
```

This request is read-only. The Agent verifies the exact instance, current identity, and resource permissions before reporting your scope. Names, Issue assignments, and ordinary writer access do not grant administration. Select the intended instance if you use several.

| Capability | Owner | Workspace administrator | Project administrator |
| --- | --- | --- | --- |
| Create, archive, or restore Workspaces | Yes | No | No |
| Create Projects | Instance-wide | Own Workspace | No |
| Project name, context, and column labels | Instance-wide | All child Projects | Own Project |
| Ordinary membership and Project invitations | Instance-wide | All child Projects | Own Project |
| Appoint Workspace administrators | Yes | No | No |
| Appoint Project administrators | Instance-wide | Own Workspace | No |
| Archive or restore Projects | Instance-wide | Own Workspace | No |
| Public Join, quotas, global usage, and audit | Yes | No | No |
| Identity recovery, others' Credentials, permanent purge | Yes | No | No |

Workspace administrators inherit management and read/write access to all current and future child Projects. Ordinary `reader` and `writer` grants remain independent; active sources combine. The Owner is the single owner of the instance, but their application Credential does not confer Cloudflare control.

## Open management

```text
Use $cfkanban-admin to open the management page available to me in <requested browser>.
```

**In the Web UI:** The Owner's full management entry is `/app/admin`, with **Overview**, **Workspaces & Projects**, **Members & access**, **Activity**, and **Archived**. Scoped administrators use **Manage** from an authorized Project and see only their settings, members, and Projects. The Agent can also open management for an empty authorized Workspace.

Browser Session scope also limits access. An Owner Session opened for a single Project does not automatically gain instance administration. Ask the Agent to open the full administration target. If an action is missing, check the current identity, scope, and deployed version first.

## Continue by goal

- [Workspaces and Projects](./projects.md): containers, Project notes, and column labels.
- [Members, invitations, and administrators](./members.md): collaborators and direct or inherited access.
- [Public Join and quotas](./public-join.md): public participation and resource limits.
- [Instance settings and usage](./settings.md): homepage text, attachment capacity, statistics, and audit.
- [Devices and identity recovery](./devices.md): Owner devices, rotation, and participant recovery.
- [Archive and permanent cleanup](./cleanup.md): pause access, restore, or preview irreversible deletion.

The Agent verifies changes by reading the result. A version conflict requires fresh state. An uncertain response requires checking the original operation instead of repeatedly creating new invitations, deletions, or permission changes.
