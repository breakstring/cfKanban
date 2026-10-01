# Members, invitations, and administrators

Use `cfkanban-admin` to invite collaborators and manage ordinary Project access separately from administration.

## Create a Project invitation

```text
Use $cfkanban-admin to create a read-only invitation to DemoProject in the Product workspace.
Verify the Project and reader role, and deliver the invitation safely to me so I can send it to its recipient.
```

You need Owner access, administration of the parent Workspace, or administration of the Project. Ordinary invitations grant `reader` or `writer` access, never administration. Scoped administrators invite to one managed Project at a time; the Owner can include several Projects with an explicit role for each.

An invitation expires after 7 days and can be redeemed once. The Agent verifies its status and, by default, copies the one-time invitation text to the clipboard without putting the complete link in ordinary output. Creating an invitation does not send it to another person. If safe delivery is unavailable, resolve delivery first; do not save the link in an Issue, log, or public document.

**In the Web UI:** As Owner, open **Administration → Members & access → Invite**, select the Project and role, then save. Copy the one-time invitation and choose **I saved it · Done**. Scoped administrators open **Project settings → Management** from the relevant board and use its invitation area. Invitation history shows status and lets you revoke unredeemed invitations; it cannot reveal a previously delivered secret link again.

Recipients follow [Join and sign in](../usage/access.md). An already signed-in non-Owner participant can verify their current identity and accept an ordinary invitation on a Service supporting that flow. New identities, identity recovery, and Owner devices use their corresponding Agent workflows.

## Inspect or change membership

```text
Use $cfkanban-admin to show DemoProject's effective members and each person's direct and inherited permission sources.
```

```text
Use $cfkanban-admin to change <member name>'s ordinary Project access in DemoProject to reader.
If this person also has administrator access, explain the access that would remain first.
```

You need the same management access as for invitations. Verify the intended person when names are ambiguous.

**In the Web UI:** The Owner can select a Project under **Members & access → Project access**, or use **Workspaces & Projects → Administrators and members**. On Project management pages, **Effective members and permission sources** shows access sources. **Direct memberships** offers name search, role changes, removal, and regranting. Invite new members who do not appear among visible candidates.

Effective permissions combine all active sources. Removing ordinary membership does not remove direct Project administration or inherited Workspace administration. A `reader` grant cannot reduce existing administration. Check every source before removing all access. If Public Join remains enabled, a removed member can join again.

## Appoint or remove administrators

```text
Use $cfkanban-admin to make <member name> an administrator of the Product workspace.
First explain the existing Projects affected and the access inherited by future Projects.
```

```text
Use $cfkanban-admin to make <member name> an administrator of DemoProject.
```

The Owner appoints and removes Workspace administrators. The Owner or a parent Workspace administrator appoints and removes Project administrators. Peers cannot appoint or remove each other. Workspace administrators manage all current and future child Projects; Project administrators manage only their Project. A scope can have several administrators or none, with its higher authority retaining control.

**In the Web UI:** Open **Administrators** on the relevant Workspace or Project management page, find a person by name, and review the effects before granting or revoking. Ordinary readers and writers can be promoted. People who already have administrative access are excluded from the add candidates.

Public Project membership quotas include non-Owner administrators, counting each person once. If adding a Workspace administrator would exceed any affected public Project's quota, the entire grant fails. It does not grant access to only some Projects.

## Invitation expiry and revocation

```text
Use $cfkanban-admin to revoke DemoProject's unredeemed invitation <invitation record ID>, then verify its status.
```

Unused invitations can become permanently invalid when their issuer loses the management access used to create them; create a new invitation if needed. Members who already joined are not automatically removed.

To recover the same person's identity, use [Devices and identity recovery](./devices.md). An ordinary Project invitation cannot replace a recovery invitation.
