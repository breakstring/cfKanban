# Manage workspaces and projects

You can manage settings, members, and invitations within an authorized workspace or project without being the Owner or having a Cloudflare account. Use the `cfkanban-admin` Skill or the corresponding management pages in the full online app.

The Owner can manage these too. For instance settings, Public Join, devices, and deployment maintenance, start with [Owner getting started](../deployment/index.md).

## Find your management scope

```text
List the workspaces and projects I can manage at <instance address>.
```

The Agent returns the workspaces and projects you can manage. Reader or writer access does not automatically grant administration. Include the site address if you use several.

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
Open the management page available to me in <requested browser>.
```

**In the full online app:** The Owner can open the account menu at the top right → **Management center**. The full management entry is `/app/admin`, with **Overview**, **Workspaces & Projects**, **Members & access**, **Activity**, and **Archived**. Scoped administrators open **Project settings → Management** from an authorized Project and see only their settings, members, and Projects. The Agent can also open management for an empty authorized Workspace.

Browser Session scope also limits access. An Owner Session opened for a single Project does not automatically gain instance administration. Ask the Agent to open the full administration target. If an action is missing, check the current identity, scope, and deployed version first.

## Continue by goal

- [Workspaces and Projects](./projects.md): Project notes, column labels, creation, archiving, and other actions within your permissions.
- [Members, invitations, and administrators](./members.md): collaborators and direct or inherited access.
- [Owner getting started](../deployment/index.md): instance settings, Public Join, device recovery, and permanent cleanup.

You can ask the Agent to handle management directly. If you want to use the Web UI, [open the full online app](../integrations/webui.md); the local workbench focuses on daily tasks. If saving fails or its result is uncertain, ask the Agent to verify the original operation before repeating an invitation, deletion, or permission change.

[Public CLI task guides](../cli/index.md) cover the same Service semantics from a terminal.
