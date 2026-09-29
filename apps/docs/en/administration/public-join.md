# Public Join and quotas

Public Join lets visitors choose a Project on the instance homepage and join with read-only or writer access. The Owner decides whether a Project should accept unknown participants.

## Inspect the public scope

```text
Use $cfkanban-admin to inspect DemoProject's Public Join status, current usage, and resource limits.
Explain the access and effects of enabling it without changing anything.
```

This requires Owner instance administration. The result includes public status, an explicitly public summary, and usage and quotas for Issues, Comments, and non-Owner members. It does not automatically publish internal Project notes.

Visitors can choose `reader` or `writer`. Public writers can edit and soft-delete content and generate database writes. Public Join is not an application queue requiring individual administrator approval.

## Enable or adjust Public Join

```text
Use $cfkanban-admin to enable Public Join for DemoProject.
Use “<an introduction suitable for all visitors>” as the public summary.
Set active limits to 50 Issues, 500 Comments, and 50 non-Owner members.
Check current usage and explain the effects before applying this scope.
```

The `50 / 500 / 50` values are an example choice, not defaults applied automatically. All three limits must be explicit when enabling. A limit may be lower than current usage: existing content and access remain, while operations that increase the corresponding count are blocked.

**In the Web UI:** As Owner, open **Administration → Workspaces & Projects → Public Join** for the Project. Review the risk explanation, public summary, current usage, and three quotas, then confirm enabling or updating the policy.

Membership includes ordinary members, direct Project administrators, and inherited Workspace administrators. Each non-Owner identity counts once. Soft-deleting content or revoking the relevant membership can free active capacity; restoration or regranting consumes it again. These quotas are enforced while Public Join is enabled for the Project.

## Disable Public Join

```text
Use $cfkanban-admin to disable Public Join for DemoProject and verify the result.
Keep existing member access.
```

**In the Web UI:** Open the same **Public Join** dialog and choose **Disable**. New self-joins stop and Public Join quota enforcement stops. Existing membership is not automatically revoked. Use [Member management](./members.md) separately to remove existing access.

## Common questions

**Why can a removed member join again?** Public Join does not maintain a per-person rejoin blocklist. While the Project remains public, they can join again.

**Will restoration make an archived Project public again?** It resumes any previously enabled policy. The restore preview explains affected Projects and effects; see [Archive and restore](./cleanup.md).

**Why am I rate-limited when the quota is not full?** Active resource quotas and Worker request-rate limits are separate mechanisms. The Owner can inspect request limits in Overview; changes use [Deployment configuration](../deployment/optional.md). A rate-limit response does not mean a member or Issue quota is full.
