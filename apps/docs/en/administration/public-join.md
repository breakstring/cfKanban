# Public Join and quotas

Public Join lets visitors choose a Project on the instance homepage and join with read-only or writer access. The Owner decides whether a Project should accept unknown participants.

## Inspect the public scope

```text
Use $cfkanban-admin to check Public Join status, current usage, and resource limits for <project name>.
Explain the access and effects of enabling it without changing anything.
```

This requires Owner instance administration. The Agent explains whether Public Join is enabled, which summary visitors can see, and the usage and quotas for issues, comments, and non-Owner members. Internal project notes are not published automatically.

Visitors may choose reader or writer access. Writers can edit and delete project content. Public Join needs no individual approval, so enable it only when the project welcomes unknown participants.

## Enable or adjust Public Join

```text
Use $cfkanban-admin to enable Public Join for <project name>.
Use “<an introduction suitable for all visitors>” as the public summary.
Set active limits to 50 Issues, 500 Comments, and 50 non-Owner members.
Check current usage and explain the effects before applying these settings.
```

The `50 / 500 / 50` values are an example choice, not defaults applied automatically. All three limits must be explicit when enabling. A limit may be lower than current usage: existing content and access remain, while operations that increase the corresponding count are blocked.

**In the Web UI:** As Owner, open **Administration → Workspaces & Projects**, then the Project row's more-actions menu → **Public Join**. Review the risk explanation, public summary, current usage, and three quotas, then confirm enabling or updating the policy.

Membership includes ordinary members, direct Project administrators, and inherited Workspace administrators. Each non-Owner identity counts once. Soft-deleting content or revoking the relevant membership can free active capacity; restoration or regranting consumes it again. These quotas are enforced while Public Join is enabled for the Project.

## Disable Public Join

```text
Use $cfkanban-admin to disable Public Join for <project name> and verify the result.
Keep existing member access.
```

**In the Web UI:** Open the same **Public Join** dialog and choose **Disable**. New self-joins stop and Public Join quota enforcement stops. Existing membership is not automatically revoked. Use [Member management](./members.md) separately to remove existing access.

## Common questions

**Why can a removed member join again?** Public Join does not maintain a per-person rejoin blocklist. While the Project remains public, they can join again.

**Will restoration make an archived Project public again?** It resumes any previously enabled policy. The restore preview explains affected Projects and effects; see [Archive and restore](./cleanup.md).

**Why am I rate-limited when the quota is not full?** Active resource quotas and Worker request-rate limits are separate mechanisms. The Owner can inspect and adjust request limits in **Usage & quotas**; see [Request-rate limits](../deployment/optional.md). A rate-limit response does not mean a member or Issue quota is full.
