# Owner workflows

Language: [English](owner-workflows.md) | [简体中文](owner-workflows.zh-CN.md)

Run `node scripts/cfkanban-tool.mjs help` from the Skill directory to inspect the installed admin command surface. Use `api request` for ordinary REST operations and the dedicated `owner rotate-credential` command for secret rotation.

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

## Administration endpoint map

| Task | Method and path | Required checks |
| --- | --- | --- |
| Verify Owner | `GET /api/v1/me` | Require stable Principal ID and `is_owner=true`. |
| List/create Workspaces | `GET/POST /api/v1/workspaces` | Creation uses explicit immutable key, display name, and Idempotency Key. |
| Read/rename/pause Workspace | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_key}` | Use current version for rename/delete. |
| Restore Workspace | `POST .../commands/restore` | Show every enabled Public Join Project that will resume first. |
| List/create Projects | `GET/POST /api/v1/workspaces/{workspace_key}/projects` | Creation does not imply Grants, Labels, or another Project. |
| Read/rename/pause Project | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_key}/projects/{project_key}` | Project key never changes. |
| Restore Project | `POST .../commands/restore` | Show its resumed Public Join role/summary/limits. |
| Read/rename status display | `GET .../statuses`, `PATCH .../statuses/{status_key}` | Stable five keys and semantics cannot change. |
| List/create Invites | `GET/POST /api/v1/admin/invitations` | Explicit kind, exact target(s), and explicit `reader | writer` per Project. |
| Read/revoke Invite | `GET/DELETE /api/v1/admin/invitations/{invitation_id}` | Use stable ID; never retain the complete Bearer URL. |
| List/read Principals | `GET /api/v1/admin/principals`, `GET .../{principal_id}` | Display names are non-unique and never identify a target. |
| List participant Credentials | `GET /api/v1/admin/principals/{principal_id}/credentials` | Show fingerprint/status, never secret. |
| Revoke participant Credential | `DELETE /api/v1/admin/credentials/{credential_id}` | Read back exact Credential and audit result. Owner Credentials are excluded. |
| Rotate Owner Credential | dedicated `credential prepare` + `owner rotate-credential` | See the rotation workflow below. |
| List/create Project Grants | `GET/POST /api/v1/admin/projects/{project_id}/grants` | One stable Principal and explicit role. |
| Read/change/revoke Grant | `GET/PATCH/DELETE /api/v1/admin/grants/{grant_id}` | Role changes/revocation do not erase assignment/history. |
| Read audit | `GET /api/v1/admin/audit-events` | Bounded pagination and explicit filters. |
| Read/change preferred origin | `GET/PUT /api/v1/admin/instance-origin` | Credential-free candidate probe, CAS, old/new discovery readback. |
| Manage Public Join | `GET/PUT/DELETE /api/v1/admin/projects/{project_id}/public-join` | One Project and explicit role; disable does not revoke Grants. |
| Read/change Project limits | `GET/PATCH /api/v1/admin/projects/{project_id}/resource-limits` | Explicit Issue/Comment/Principal limits and current usage. |
| Inspect rate gates | `GET /api/v1/admin/rate-limit-settings` | Read-only; deploy Skill changes bindings. |
| Revoke participant Passkey | `DELETE /api/v1/admin/passkeys/{passkey_id}` | Does not revoke API Credentials or Grants. |
| Open Owner Web | `POST /api/v1/web-launches` with `target.kind=admin` | Choose explicit section; defaults to Overview behavior. |

## Invitations and recovery

Normal Project Invites are fixed seven-day, one-time capabilities. Every target Project includes an explicit `reader | writer`. If the upper-level request has no role, the Skill may recommend `writer`; explicit read-only intent resolves to `reader`. This recommendation never becomes an omitted API field.

Principal Recovery Invites are fixed one-hour capabilities. Before creation:

1. Select the exact stable Principal ID, not a display name.
2. Read current Grants, assignments/history continuity, and Credentials.
3. Choose immutable `rotation` or `full_recovery` and show the exact revocation scope.
4. Create one Invite with its own Idempotency Key, then read back by invitation ID.
5. Return copyable invitation text only to the user; cfKanban does not send it to a third party and the Agent does not log it.

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

## Tombstone and container recovery

Use a known stable identifier or an explicit paginated `deleted=only` view; there is no hidden “recently deleted” time window and no bulk restore endpoint. Restore one resource per atomic request.

Before restoring a Project or Workspace, list every still-enabled Public Join policy that will resume, including Project identity, role, public summary, limits, and active usage. Previously disabled policies remain disabled.

## Preferred origin and Owner Web

For preferred-origin changes, probe the proposed HTTPS origin without a Credential, update with the current expected version, then read the public discovery document from both old and new origins. Do not rely on cross-origin authenticated redirects.

An Owner Browser Launch uses the current Owner Credential only to create a five-minute opaque code. It exchanges into an instance-level admin Session, opens Overview, and does not prefetch all Issues. The user may then explicitly choose a Workspace/Project. The long-lived Credential never enters the browser.

## Error and readback rules

Use one Idempotency Key per atomic write. Read back the mutated resource and relevant audit event. Interpret errors by stable machine fields, not `message`. Earlier committed operations remain committed when a later step fails; report them separately rather than claiming rollback.
