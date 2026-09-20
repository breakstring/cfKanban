# Owner workflows

Language: [English](owner-workflows.md) | [简体中文](owner-workflows.zh-CN.md)

Read the relevant section only. Run `node scripts/cfkanban-tool.mjs help` once per installed release, or when inputs are unclear, to inspect the admin command surface. Use `api request` for ordinary REST operations, `invite create` and `web launch` for one-time capability delivery, and `owner rotate-credential` for secret rotation.

## Common Owner requests

Verify `is_owner=true` first. These are application operations, not Cloudflare deployment. Daily Issue work remains in `cfkanban` even for an Owner.

| User request | Expected result |
| --- | --- |
| “Create Release in workspace Product.” | Resolve existing names or create requested containers; read back UUIDs and report the Project. Open the board when requested. No automatic Issue, membership, or Public Join. |
| “Create a read-only invitation to Release.” | An explicit `reader` Invite delivered safely; no automatic sending to another person. |
| “Show who can access Release.” | Current Grants and Owner access, with stable Principal identifiers; no revocation or role changes. |
| “Explain the effects of enabling Public Join for Release.” | Explain that visitors can choose reader or writer and enabling requires three explicit quotas. No policy change is implied by explanation; disabling later does not revoke existing Grants. |
| “Show usage and remaining attachment capacity.” | Cache-aware refresh and a distinction between application reservations/limit and platform metrics; unknown is not zero and unlimited is not unset. |
| “Archive the old Release project.” | Reversible archive of the resolved Project. Restore warns about enabled Public Join resuming; permanent purge needs its separate preview and explicit authorization. |
| “Help this participant recover access.” | Resolve the stable Principal and exact recovery mode/revocation effects before creating a Recovery Invite. Total Owner Credential loss goes to `cfkanban-deploy`. |

## Common request pattern

Provide one JSON object on stdin, not in process arguments:

```json
{
  "instanceId": "11111111-1111-4111-8111-111111111111",
  "method": "GET",
  "apiPath": "/api/v1/admin/audit-events"
}
```

Use it with `node scripts/cfkanban-tool.mjs api request`. The command reads the current Owner Credential internally. Never add a Credential, pending secret, complete Invite URL, or recovery code to generic request input.

## First usable board after deployment

Deployment creates no application container automatically. For the common first-use request:

1. inspect local state and verify `/api/v1/me` returns the expected stable Principal with `is_owner=true`;
2. reuse supplied display names and any explicitly selected existing Workspace; ask together for missing names and resolve duplicate existing names before writing;
3. create a Workspace only when requested or needed for the first board, read its server-generated UUID, then create the requested Project under that UUID with a separate Idempotency Key and read it back;
4. run `web launch` with `target.kind=admin`; its default direct-browser delivery returns no one-time URL;
5. offer separate next actions: use `cfkanban` to create the first Issue, create an explicit-role Invite, or configure Public Join and all three quotas.

Names are not unique identifiers. Resolve existing containers through authorized reads and disambiguate duplicate names before writing; never guess a UUID. Do not silently create a default Project, Label, Grant, Issue, Invite, or Public Join policy. Project creation failure does not roll back a committed Workspace.

## Administration endpoint map

| Task | Method and path | Required checks |
| --- | --- | --- |
| Verify Owner | `GET /api/v1/me` | Require stable Principal ID and `is_owner=true`. |
| List/create Workspaces | `GET/POST /api/v1/workspaces` | Create using display names and read back server-generated UUIDs; names are not unique identifiers. |
| Read/rename/pause Workspace | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_id}` | Use current version for rename/delete. |
| Restore Workspace | `POST .../commands/restore` | Show every enabled Public Join Project that will resume first. |
| List/create Projects | `GET/POST /api/v1/workspaces/{workspace_id}/projects` | Create using display names and read back server-generated UUIDs; names are not unique identifiers. |
| Read/rename/pause Project | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_id}/projects/{project_id}` | The UUID never changes; rename/archive use the current version. |
| Restore Project | `POST .../commands/restore` | Show its resumed Public Join role/summary/limits. |
| Read/rename status display | `GET .../statuses`, `PATCH .../statuses/{status_key}` | Stable five keys and semantics cannot change. |
| List/create Invites | `GET /api/v1/admin/invitations`; dedicated `invite create` | Explicit kind, exact target(s), and explicit `reader | writer` per Project. |
| Read/revoke Invite | `GET/DELETE /api/v1/admin/invitations/{invitation_id}` | Use stable ID; never retain the complete Bearer URL. |
| List/read Principals | `GET /api/v1/admin/principals`, `GET .../{principal_id}` | Display names are non-unique and never identify a target. |
| List participant Credentials | `GET /api/v1/admin/principals/{principal_id}/credentials` | Show fingerprint/status, never secret. |
| Revoke participant Credential | `DELETE /api/v1/admin/credentials/{credential_id}` | Read back exact Credential and audit result. Owner Credentials are excluded. |
| Rotate Owner Credential | dedicated `credential prepare` + `owner rotate-credential` | See the rotation workflow below. |
| List/create Project Grants | `GET/POST /api/v1/admin/projects/{project_id}/grants` | One stable Principal and explicit role. |
| Read/change/revoke Grant | `GET/PATCH/DELETE /api/v1/admin/grants/{grant_id}` | Role changes/revocation do not erase assignment/history. |
| Read audit | `GET /api/v1/admin/audit-events` | Bounded pagination; optionally filter by one immutable `project_id` and/or `stream=domain|security`, and verify `resolved_filters`. |
| Read/change preferred origin | `GET/PUT /api/v1/admin/instance-origin` | Credential-free candidate probe, CAS, old/new discovery readback. |
| Manage Public Join | `GET/PUT/DELETE /api/v1/admin/projects/{project_id}/public-join` | Use `project.version` as `expected_version`, not `policy_version`; disable does not revoke Grants. |
| Read/change Project limits | `GET/PATCH /api/v1/admin/projects/{project_id}/resource-limits` | Use the returned `project.version`; submit explicit Issue/Comment/Principal limits. |
| Inspect rate gates | `GET /api/v1/admin/rate-limit-settings` | Read-only; deploy Skill changes bindings. |
| Revoke participant Passkey | `DELETE /api/v1/admin/passkeys/{passkey_id}` | Does not revoke API Credentials or Grants. |
| Open Owner Web | dedicated `web launch` with `target.kind=admin` | Choose an explicit section; default delivery opens the system browser without stdout capability output. |

## Invitations and recovery

Normal Project Invites are fixed seven-day, one-time capabilities. Every target Project includes an explicit `reader | writer`. If the upper-level request has no role, the Skill may recommend `writer`; explicit read-only intent resolves to `reader`. This recommendation never becomes an omitted API field.

Principal Recovery Invites are fixed one-hour capabilities. Before creation:

1. Select the exact stable Principal ID, not a display name.
2. Read current Grants, assignments/history continuity, and Credentials.
3. Choose immutable `rotation` or `full_recovery` and show the exact revocation scope.
4. Create one Invite with its own Idempotency Key through `invite create`, then read back by invitation ID.
5. Default to `delivery=clipboard`, which copies the one-time text without returning it on stdout. cfKanban does not send it to a third party; the user or Agent must paste it only to the intended recipient.

If no clipboard exists, stop before creation unless the user explicitly accepts host-retained output. The fallback requires `delivery=stdout_once` and the exact acknowledgement `I understand this one-time capability may be retained by the Agent host`. Its `sensitive_output` is shown once and must not be quoted, logged, journaled, receipted, saved, or repeated. An idempotent replay returns only safe metadata and cannot recover the URL.

## Owner Credential rotation

1. Verify `/api/v1/me` is the current Owner and read the current Credential fingerprint.
2. Run `credential prepare` with the same Owner Principal ID, a stable operation ID, an Idempotency Key, and `purpose=owner_rotation`. The replacement secret is written directly to the private pending slot.
3. Run `owner rotate-credential` with only `instanceId`. It authenticates with current secret, injects the pending secret into the rotation body, and keeps both out of stdout/stdin/arguments.
4. The command authenticates `/api/v1/me` with the replacement and promotes only when Principal ID and fingerprint match.
5. If commit state is uncertain, retain the same pending secret and rerun the same command. Do not generate another replacement.
6. Run `credential clear` only after remote non-commit is proven.

Web Sessions cannot rotate or revoke Owner Credentials. If all Owner Credentials are lost, use `cfkanban-deploy` for controlled out-of-band recovery of the same Owner Principal.

## Public Join and quotas

Before enabling or changing Public Join, read the Project, policy, active usage, and all three limits. The impact summary must include:

- public `writer` allows unknown internet participants to modify and soft-delete content and create D1 writes;
- one explicit public summary is displayed; internal Project context is not reused;
- Issue, Comment, and active non-Owner Principal limits are isolated to this Project and enforced only while its Public Join is enabled;
- 50/500/50 may be suggested but is never submitted silently;
- limits may be saved below current usage without deleting data or Grants; only operations that increase that counter are blocked;
- soft delete/Grant revoke releases active capacity, while restore/regrant consumes it;
- disabling stops new self-join and quota enforcement but does not revoke existing Grants;
- while a Project stays public, revoking a Grant does not create a rejoin blacklist.

The policy response deliberately exposes two revisions. `project.version` is the CAS value for Public Join enable/update/disable and resource-limit writes. `policy_version` describes the policy record's own history and must never be copied into `expected_version`. On `VERSION_CONFLICT`, refresh the Project/Policy facts and reassess the requested change. Ask only if concurrent changes materially alter its target or consequences; never retry with a guessed version.

## Tombstone and container recovery

Use a known stable identifier or an explicit paginated `deleted=only` view; there is no hidden “recently deleted” time window and no bulk restore endpoint. Restore one resource per atomic request.

Before restoring a Project or Workspace, list every still-enabled Public Join policy that will resume, including Project identity, role, public summary, limits, and active usage. Previously disabled policies remain disabled.

## Preferred origin and Owner Web

For preferred-origin changes, probe the proposed HTTPS origin without a Credential, update with the current expected version, then read the public discovery document from both old and new origins. Do not rely on cross-origin authenticated redirects.

### Resolve the instance and authenticated target

Run `web resolve` with known `instanceId` or `origin` (only the HTTPS origin, without path/query/fragment), and `repoRoot` when working in a Repo. This command reads only local trusted instance metadata/current-slot availability; it does not authenticate or expose secrets. Its status is `resolved`, `selection_required`, or `credential_required`. An explicitly referenced current browser origin is explicit context; an unrelated ambient tab is not a target. A matching explicit target wins, followed by one Repo-referenced instance, then one local current instance. Multiple Repo candidates stay ambiguous even if another local choice seems convenient. Show only candidate identifiers/origins and ask once; never pick the first, most recent, or Owner instance. An unknown explicit origin needs trusted registration/join or recovery, not fallback or Credential transmission to that origin.

After resolution, call `GET /api/v1/me` using the private current Credential. Invalid credentials stop the launch and require recovery. A verified Owner defaults to admin Overview through `cfkanban-admin`, unless the user specified a narrower target. For a participant without an explicit Project/Issue, read authorized Projects: use a unique accessible Project or ask which one; this selects the initial page. Updated Services exchange non-Owner launches into `project_selection` for live authorized Projects; existing fixed-scope Sessions and Owner Project/Issue Sessions stay fixed. Verify deployed support instead of assuming it from installed Skill metadata. Reuse an existing browser Session only if its Principal and target scope are verified. The completion check is the authenticated target page, not just an opened tab or a relay redirect.

### Deliver to IAB or another host-controlled browser

When the user requests IAB or a named browser controlled by the host, use `delivery=host_browser` after confirming the browser tool can reach this process's loopback interface. Start the CLI with a short shell yield so its process remains alive. The CLI streams a `browser_relay_ready` event containing `local_url`, then waits for the browser GET and emits the final result. Open that exact local URL immediately with the requested browser's navigation tool. Do not probe it with fetch, curl, a preview, or another browser: GET consumes this local handoff. Keep the CLI alive and collect its final result after navigation.

The random-path loopback handoff is single-use and expires after 60 seconds. It is a sensitive local capability briefly visible in host tool context: never repeat it to the user or persist it in a file, log, receipt, or report. The remote ticket URL/code remains only in process memory and is never printed. The remote ticket still lasts five minutes and the exchanged Session eight hours; the local 60-second handoff does not change either lifetime. If the requested browser is on a different host/network namespace or has no suitable navigation tool, stop and explain the delivery limitation before creating a ticket; do not silently switch browsers. A relay success proves handoff only: inspect the final page and report any unverified login. Default `system_browser` and explicitly acknowledged `stdout_once` retain their existing behavior.

An Owner Browser Launch uses the current Owner Credential only to create a five-minute opaque code. `web launch` defaults to a memory-only loopback relay that opens the system browser while keeping the remote URL out of stdout and process arguments. It exchanges into an instance-level admin Session, opens Overview, and does not prefetch all Issues. The user may then explicitly choose a Workspace/Project. The long-lived Credential never enters the browser. Headless output follows the same explicit `stdout_once` acknowledgement and no-retention rule as Invite delivery.

## Audit filters

Use `project_id` when the task concerns one known Project and `stream=domain|security` when only one event class is relevant. Omitting both is an intentional Instance-wide, both-stream read. The response repeats the normalized `project_id` and stream list in `resolved_filters`. Continue with `next_cursor` only while those filters stay unchanged; a changed filter invalidates the old cursor and starts a fresh sequence.

Use `subject.type` and `subject.id` to identify the resource whose lifecycle the Event records. Treat `authorized_via` and `grant_id` as historical authorization evidence. In particular, a participant's Issue, Comment, Label, or Relation Event can reference the Project Grant that authorized the write, while a Grant-management Event can use the same `grant_id` for its Grant subject. Filtering only by `grant_id` therefore mixes resource lifecycles; select Grant mutations with `subject.type=project_grant` and the exact `subject.id`, then inspect `grant_id` and `authorized_via` to explain how the operation was authorized.

## Error and readback rules

Use one Idempotency Key per atomic write and read back the mutated resource. Inspect relevant audit events when checking authorization or lifecycle history. Ordinary writes follow existing user/host authorization; this Skill does not impose a new approval for each call. Interpret errors by stable machine fields, not `message`. Earlier committed operations remain committed when a later step fails; report them separately rather than claiming rollback.

## Archived container purge

Archive (`DELETE`) remains reversible. Permanent removal is a separate Owner operation, limited to an archived Project or an archived Workspace with no non-purged Projects. Use the container path `/api/v1/workspaces/{workspace_id}` or its `/projects/{project_id}` child.

1. Read `GET {container_path}/purge-preview`. Show the exact target, content counts, cross-project relations, affected invitations and shared invitations. Stop if `can_purge=false`.
2. Obtain explicit authorization for the irreversible previewed removal. This clears Issues, completion and ordinary Comments, labels, relations, Grants, project sessions, and corresponding history/response caches. Shared pending invitations are revoked; existing Grants in other Projects remain. Minimal UUID tombstones and a compact purge audit remain; old cursors may require a fresh read. Do not promise an immediate reduction in Cloudflare storage metrics or deletion of platform backups.
3. Send `POST {container_path}/commands/purge` through `api request` with `expected_version=target.version`, `confirm_name=target.display_name`, `preview_digest` and one new Idempotency Key. A stale preview requires fresh review; an uncertain response requires the same request/key, not a newly authorized target.
4. Verify the `resource.purged=true` result and absence from the explicit `deleted=only` list/detail; optionally inspect the compact Owner audit. Purged containers cannot be restored. A new container may reuse the name and receives a different UUID. Never purge multiple containers implicitly or automatically.

## Owner usage and limits

Use `api request` with `POST /api/v1/admin/usage/refresh` to request the same Owner-only usage projection and shared cache as Web refresh. Attachment `reserved_bytes` includes pending, ready, soft-deleted and not-yet-reclaimed objects; it is an application reservation budget, not R2 billed capacity. Cloudflare metrics are optional and instance-scoped. Report `not_configured`, `pending`, `error`, `stale`, and null values explicitly; never replace unknown values with zero or derive account-wide remaining allowance from this instance. Daily operation counters use the UTC day; capacity is the latest observed bucket within 24 hours. Default to one short collection time; distinguish observation time and exact UTC windows when needed. Route analytics Token/resource configuration to cfkanban-deploy; attachment capacity remains an application setting below; no credentials belong in API request bodies or Issue records.

Every Skill usage query calls the same refresh endpoint as the Web refresh button. Both `{ "mode": "stale" }` and `{ "mode": "manual" }` reuse successful snapshots younger than 15 minutes; manual does not bypass the cache. Missing, expired, failed or interrupted collections may be retried subject to a shared 60-second attempt cooldown. Concurrent requests return the current projection with `refreshing`; do not poll. Attachment reservations and settings are read live on each response. This derived-cache refresh requires no Idempotency-Key or domain Event/Audit.

Run `node scripts/cfkanban-tool.mjs api request` with the resolved trusted instance ID on every usage query:

```json
{"instanceId":"<trusted-instance-uuid>","method":"POST","apiPath":"/api/v1/admin/usage/refresh","body":{"mode":"manual"}}
```

No preliminary GET is needed. Use `GET /api/v1/admin/usage` only for an explicitly requested stored snapshot. A refresh request may return the existing fresh cache: report the actual collection time, not the query time.

Report attachment `reserved_bytes`, `limit_configured`, and `limit_bytes`. Only when configured with a finite limit, calculate remaining application capacity as `max(0, limit_bytes - reserved_bytes)`; unlimited has no remaining-capacity number, and unconfigured pauses new uploads. Summarize D1 storage/daily rows read and written, and R2 storage/object count/daily operations when available. This API does not provide an account bill, account-wide free allowance, or Worker request metrics.

A `not_configured` result still contains useful attachment data; explain the missing or disabled analytics configuration without creating a Token or enabling collection. If `refreshing=true` or a cooldown retains the prior snapshot, report that fact without claiming a new collection succeeded. If the service does not support these endpoints (usage requires schema 6; capacity settings schema 7), report the unavailable feature and route a separately authorized upgrade to cfkanban-deploy. Do not fall back to direct Cloudflare queries or auto-upgrade.

## Attachment capacity setting

Read `GET /api/v1/admin/attachment-settings` as Owner before changing capacity. `configured=false` means the Owner has not chosen a policy; it is not unlimited, and new upload reservations remain paused. Submit `PATCH /api/v1/admin/attachment-settings` with `{limit_bytes: <positive safe integer bytes or null>, expected_version: <read version>}` and an independent Idempotency-Key, then read back the setting. Null is an explicit choice of unlimited capacity. This changes an application setting and follows ordinary domain-write permission, CAS and idempotency rules; it is not the usage-cache refresh exception. Never infer an unlimited policy or silently choose the former 1 GiB value. Migrating the former fixed policy requires a fresh Owner choice; deployment must not select or overwrite it. Existing bytes remain counted, including soft-deleted objects awaiting actual reclamation. Application capacity does not cap the Cloudflare bill.
