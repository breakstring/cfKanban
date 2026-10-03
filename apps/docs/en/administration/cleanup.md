# Archive, restore, and permanent cleanup

Archiving pauses access to a project or workspace while preserving its content and permissions. Permanent deletion is a separate, irreversible operation whose effects must be reviewed first.

## Archive an old Project or Workspace

```text
Use $cfkanban-admin to archive <project name> in <workspace name> and verify the result.
```

The Owner can archive Workspaces and Projects. A Workspace administrator can archive child Projects while the Workspace is active. Project administrators cannot archive their Project. Archiving a Workspace pauses data access and inherited management for all child Projects; archiving a Project pauses access to that Project.

**In the Web UI:** The Owner chooses **Archive** for the exact target under **Administration → Workspaces & Projects**. Workspace administrators use the Project list or open **Project settings → Management** from the board. Content and permissions remain, while the archived project or workspace leaves the active list.

## Restore access

```text
Use $cfkanban-admin to check which access and Public Join policies would resume when restoring <project name>.
Verify the exact Project, then restore it.
```

Restore permissions match archive permissions. If the parent Workspace is archived, the Owner must restore it first. Any previously enabled Public Join policy resumes; disabled policies stay disabled. The Agent or page explains the public effects before restoration.

**In the Web UI:** The Owner opens **Administration → Archived**, expands the relevant Workspace, and chooses **Restore** for the Project or Workspace. Workspace administrators use **Projects → Show archived projects** in Workspace management, then open the archived Project's management page to restore it.

Restoration preserves the original content and access. See [Usage](../usage/index.md) to restore individual issues or comments.

## Preview permanent deletion

```text
Use $cfkanban-admin to preview permanent deletion of the archived <project name> without executing it.
Show the exact target, content counts, cross-Project relations, and invitations and sessions that will be invalidated.
```

Only the Owner can permanently delete an archived project or workspace. Every project in a workspace must be permanently deleted before the workspace itself can be deleted. Handle each project separately; there is no bulk permanent deletion.

The preview covers Issues, ordinary Comments and completion records, Labels, relations, grants, Project sessions, and relevant history. Unredeemed invitations containing the Project are invalidated, including shared multi-Project invitations. Existing grants in other Projects remain. Attachment objects follow their reclamation workflow; immediate release of budget or platform storage is not guaranteed.

## Confirm irreversible cleanup

```text
I confirm permanent deletion of <the exact archived target just previewed> and understand that it cannot be undone.
Use $cfkanban-admin to verify that the preview has not changed, delete the target, and confirm the result.
```

Authorization to archive does not authorize permanent deletion. Changes to the target or preview require a fresh review of the effects.

**In the Web UI:** Open **Administration → Archived → Delete permanently**. Review the exact name, parent Workspace, expandable full ID, and impact counts. Enter the complete display name and confirm. The target then leaves the archive list and cannot be restored.

Permanent deletion does not erase Cloudflare backups or copies others have already saved, and may not free all storage immediately.

## Failure or uncertain results

If the result is uncertain, use **Retry same request** to check it. Permanent deletion cannot be undone in the application; do not start another deletion to guess the outcome.
