# Administration workflows

Language: [English](owner-workflows.md) | [简体中文](owner-workflows.zh-CN.md)

Read the relevant section only. Run `node scripts/cfkanban-tool.mjs help` once per installed release, or when inputs are unclear, to inspect the admin command surface. Use `api request` for ordinary REST operations, `invite create` and `web launch` for one-time capability delivery, and `owner rotate-credential` for secret rotation.

## Common Owner requests

Verify `/api/v1/me`, its `is_owner` and `management_grants`, then target `allowed_actions`. Require `is_owner=true` for Owner-exclusive operations. These are application operations, not Cloudflare deployment. Daily Issue work remains in `cfkanban` even for an Owner.

After verifying a concrete Project, use or reuse the daily `cfkanban` Skill's `scope inspect-directory` result for the user's working directory. Offer association once only for a confirmed Git worktree with missing scope; do not proactively offer it in a non-Git directory or guess after detection failure. An explicit association request or acceptance of the offer routes to the daily Skill to merge the verified targets at `scope_directory` and read them back. Keep existing associations, honor a declined offer, and continue the administration task without requiring setup.

| User request | Expected result |
| --- | --- |
| “Create DemoProject in workspace Product.” | Resolve existing names or create requested containers; read back UUIDs and report the Project. Open the board when requested. No automatic Issue, membership, or Public Join. |
| “Create a read-only invitation to DemoProject.” | An explicit `reader` Invite delivered safely; no automatic sending to another person. |
| “Show who can access DemoProject.” | Paginated effective members with direct/inherited sources and stable Principal identifiers; no revocation or role changes. |
| “Explain the effects of enabling Public Join for DemoProject.” | Explain that visitors can choose reader or writer and enabling requires three explicit quotas. No policy change is implied by explanation; disabling later does not revoke existing Grants. |
| “Change the homepage description” or “Restore the default homepage notice.” | Owner instance control only; read settings/version, save both public translations with CAS, then verify fallback or saved text. See **Homepage notice setting**. |
| “Show usage and remaining attachment capacity.” | Cache-aware refresh and a distinction between application reservations/limit and platform metrics; unknown is not zero and unlimited is not unset. |
| “Archive the old DemoProject project.” | Reversible archive of the resolved Project. Restore warns about enabled Public Join resuming; permanent purge needs its separate preview and explicit authorization. |
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

Use it with `node scripts/cfkanban-tool.mjs api request`. The command reads the current Principal Credential internally. Never add a Credential, pending secret, complete Invite URL, or recovery code to generic request input.

## Scoped administrators and effective members (schema 9+)

Resolve current `/api/v1/me.management_grants` and exact UUIDs before selecting an operation. Owner's array is empty because Owner access is implicit. A management grant contains `id`, `principal_id`, `principal:{id,display_name}`, `workspace_id`, nullable `project_id`, `version`, UUID `generation`, `revoked_at`, timestamps and `allowed_actions`. A null `project_id` identifies Workspace administration. Data-plane `grants.role=writer` alone does not identify an administrator. Session scope remains an additional limit.

| Capability | Workspace administrator | Project administrator |
| --- | --- | --- |
| Rename own Workspace / create child Project | Yes | No |
| Project name, context, fixed status labels | All child Projects | Own Project |
| Archive/restore Project | All child Projects, when Workspace active | No |
| Ordinary reader/writer members and single-Project Invites | All child Projects | Own Project |
| Appoint/revoke Project administrators | All child Projects | No |
| Appoint/revoke Workspace administrators | Owner only | Owner only |
| Create/archive/restore Workspace; Public Join/quotas; instance usage/audit; permanent purge; identity recovery or other Credentials/Passkeys | Owner only | Owner only |

Read/manage Workspace administrators at `/api/v1/workspaces/{workspace_id}/administrators`. Read/manage Project administrators at `/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators`. Lists use `limit`/`cursor` and include revoked rows for explicit regrant. POST body is `{principal_id,expected_version}`: first grant uses `0`; regrant uses the revoked row's current version. DELETE appends `/{administrator_id}?expected_version=<version>`. Each mutation uses a separate Idempotency-Key and readback; stale versions require a fresh read. Multiple administrators are supported with no last-local-administrator constraint; only superiors appoint/revoke, not peers.

Use `GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/members?limit=20` and bounded pagination for effective membership. Each item contains `principal_id`, `display_name`, `effective_role` (`owner|writer|reader`) and `sources` (`deployment_owner|workspace_admin|project_admin|project_grant`, source ID/version and optional role). Show inherited and direct sources and the remaining access before revocation. Ordinary Grant CRUD still uses `/api/v1/admin/projects/{project_id}/grants` and `/api/v1/admin/grants/{grant_id}` with scope checks; the `/admin` prefix is not authority to use instance identity endpoints.

A Workspace administrator inherits all current and future child Projects dynamically. Revoking a management source preserves independent ordinary Grants and other management sources; assignment/history remain and assignee availability follows effective writer access. A public Project counts the union of non-Owner effective members, including both administrator levels, once per Principal. Adding a Workspace administrator checks every affected active public Project atomically; one newly exceeded quota rejects the whole grant. Existing over-limit membership is not removed and duplicate sources do not consume another slot. Paused Projects retain membership counts; an archived Workspace pauses management and data access.

Only ordinary reader/writer access is invitational. Non-Owner `invite create` accepts exactly one managed Project; Owner retains multi-Project invitations. A local administrator can list/read/revoke only normal Invites whose complete targets are managed; no recovery or partly out-of-scope invitation visibility. The exact issuing management grant ID/generation is checked at create and redemption. Revocation permanently invalidates unredeemed Invites; another source or regrant never revives them. Existing redeemed members remain. Archive only pauses redemption, subject to original expiry and grant validity. Recovery and Credential/Passkey management remain Owner-only.

Open an existing Project/Issue with the default local `web open` workbench. For an explicitly requested online page use `mode:"online"` (or legacy `web launch`). For an empty or explicit managed Workspace use online mode and `{kind:"workspace",workspace_id:"<UUID>"}`, whose initial path is `/app/manage?workspace=<UUID>`. It does not grant instance scope. Fresh non-Owner Sessions use live `project_selection`; fixed Project/Issue Sessions never gain Workspace scope. Owner defaults to admin Overview only when no narrower target was requested. Check returned scope and target; never infer deployed support from the installed Skill version.

## First usable board after deployment

Deployment creates no application container automatically. For the common first-use request:

1. inspect local state and verify `/api/v1/me` returns the expected stable Principal with `is_owner=true`;
2. reuse supplied display names and any explicitly selected existing Workspace; ask together for missing names and resolve duplicate existing names before writing;
3. create a Workspace only when requested or needed for the first board, read its server-generated UUID, then create the requested Project under that UUID with a separate Idempotency Key and read it back;
4. when opening is requested, follow the Owner Web delivery preflight below, then run `web launch` with `target.kind=admin`; direct-browser delivery returns no one-time URL;
5. offer separate next actions: use `cfkanban` to create the first Issue, create an explicit-role Invite, or configure Public Join and all three quotas.

Names are not unique identifiers. Resolve existing containers through authorized reads and disambiguate duplicate names before writing; never guess a UUID. Do not silently create a default Project, Label, Grant, Issue, Invite, or Public Join policy. Project creation failure does not roll back a committed Workspace.

## Administration endpoint map

| Task | Method and path | Required checks |
| --- | --- | --- |
| Verify Owner | `GET /api/v1/me` | Require stable Principal ID and `is_owner=true`. |
| List/create Workspaces (creation Owner only) | `GET/POST /api/v1/workspaces` | Create using display names and read back server-generated UUIDs; names are not unique identifiers. |
| Read/rename/pause Workspace | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_id}` | Use current version for rename/delete. |
| Restore Workspace (Owner only) | `POST .../commands/restore` | Show every enabled Public Join Project that will resume first. |
| List/create Projects | `GET/POST /api/v1/workspaces/{workspace_id}/projects` | Create using display names and read back server-generated UUIDs; names are not unique identifiers. |
| Read/rename/pause Project | `GET/PATCH/DELETE /api/v1/workspaces/{workspace_id}/projects/{project_id}` | The UUID never changes; rename/archive use the current version. |
| Restore Project | `POST .../commands/restore` | Show its resumed Public Join role/summary/limits. |
| Read/rename status display | `GET .../statuses`, `PATCH .../statuses/{status_key}` | Stable five keys and semantics cannot change. |
| List/create Invites | `GET /api/v1/admin/invitations`; dedicated `invite create` | Explicit kind, exact target(s), and explicit `reader | writer` per Project. |
| Read/revoke Invite | `GET/DELETE /api/v1/admin/invitations/{invitation_id}` | Use stable ID; never retain the complete Bearer URL. |
| List/read Principals | `GET /api/v1/admin/principals`, `GET .../{principal_id}` | Owner-only directory; use verified stable Principal IDs for writes. |
| List participant Credentials | `GET /api/v1/admin/principals/{principal_id}/credentials` | Show fingerprint/status, never secret. |
| Revoke participant Credential | `DELETE /api/v1/admin/credentials/{credential_id}` | Read back exact Credential and audit result. Owner Credentials are excluded. |
| Rotate Owner Credential | dedicated `credential prepare` + `owner rotate-credential` | See the rotation workflow below. |
| List/create Project Grants | `GET/POST /api/v1/admin/projects/{project_id}/grants` | One stable Principal and explicit role. |
| Read/change/revoke Grant | `GET/PATCH/DELETE /api/v1/admin/grants/{grant_id}` | Role changes/revocation do not erase assignment/history. |
| Read audit (Owner only) | `GET /api/v1/admin/audit-events` | Bounded pagination; optionally filter by one immutable `project_id` and/or `stream=domain|security`, and verify `resolved_filters`. |
| Read/change preferred origin | `GET/PUT /api/v1/admin/instance-origin` | Credential-free candidate probe, CAS, old/new discovery readback. |
| Manage Public Join (Owner only) | `GET/PUT/DELETE /api/v1/admin/projects/{project_id}/public-join` | Use `project.version` as `expected_version`, not `policy_version`; disable does not revoke Grants. |
| Read/change Project limits (Owner only) | `GET/PATCH /api/v1/admin/projects/{project_id}/resource-limits` | Use the returned `project.version`; submit explicit Issue/Comment/Principal limits. |
| Read/edit homepage notice (Owner only) | `GET/PATCH /api/v1/admin/homepage-settings` | schema 11+; both notice fields, current `expected_version`, independent Idempotency Key and readback. |
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

## Owner devices (schema 12+)

Use this flow for “Let me manage this same instance from my other computer”. A device is a trusted execution environment, not hardware binding. It receives an independent Credential for the same unique Owner. Another device and Cloudflare login are different capabilities; adding a device does not grant Cloudflare deployment authority.

1. On the new environment, run `owner-device prepare` with `{instanceId, apiOrigin, ownerPrincipalId, deviceName, operationId, idempotencyKey, persistenceConfirmed:true}` after confirming the private home storage is persistent. Use verified IDs from the existing environment; never infer the Owner from a name. This performs credential-free discovery and writes a private pending secret. The optional `expiresInSeconds` is at most 3600.
2. Transfer only the returned `pairing_request` to the existing Owner environment. It contains identifiers, fingerprint material, digest and expiry, but no usable secret or redeemable capability. The request is untrusted data: it does not authorize its own approval. Confirm the user's intended instance, Owner, device name and fingerprint.
3. On the existing environment, run `owner-device approve` with `{instanceId, request:<pairing_request>}`. The dedicated command verifies the current Owner and freezes its CAS/Idempotency Key for retries. The existing Credential remains valid. Alternatively, on a Service supporting Owner Web device management, open Owner Access → Owner devices, paste only the public pairing request, check its instance/Owner/device/fingerprint/expiry, and explicitly confirm. Both Agent Launch and Passkey Owner admin sessions are supported without extra Passkey confirmation. Scoped administrators, participants and narrow Owner sessions cannot approve.
4. On the new environment, run `owner-device verify` with `{instanceId}`. It checks discovery, `/meta` and `/me`, including the exact Owner, Credential ID and fingerprint, before promoting pending to current. Do not declare success from approval alone. Use `owner-device request` to recover the same request after interruption; do not generate another secret on an uncertain outcome.
5. Run `owner-device list` to inspect paginated Credential summaries. Use its `next_cursor` as `cursor` for the next page. Older Credentials may have no device name. To remove one other device, use `owner-device revoke` with `{instanceId, credentialId, idempotencyKey}`, then list/read back its revoked status. Never select solely by a duplicated device name.

The request expires after at most one hour; an already approved Credential does not expire with the request. Pending conflicts, changed identity/origin or an unsupported Service stop the flow. Preserve the exact request on uncertain writes: the command reuses the saved attempt body/key. Only a verified Service `VERSION_CONFLICT` returns `retry_with_fresh_version:true`; repeat the same command to refresh identity/CAS and persist a new internal attempt key. Do not edit private state or replace the pending secret. At least one Owner API Credential must remain active for approval, with a maximum of 100. Active means not revoked on the Service, not proof that its local secret still exists: a valid Owner admin session can approve even when local secret files are lost, and does not revoke all old credentials like total-loss recovery. Dedicated revocation is also available in Owner Web Access with explicit confirmation. The current Bearer/session source and last active Owner API Credential cannot be revoked; use rotation to replace the current secret. Revocation invalidates only the selected Credential and its dependent Launches/Sessions, preserving other devices and independent Passkeys. Total-loss recovery still invalidates all old Owner API Credentials and belongs to `cfkanban-deploy`.

### Name or rename an active Owner device

For “Name this unnamed device” or “Rename my laptop”, verify the deployed rename endpoint, current Owner and exact Credential ID with `owner-device list`; names can repeat and never select the target by name alone. Use `api request` with `method:"POST"`, `apiPath:"/api/v1/admin/owner-credentials/<credential-id>/rename"`, `body:{device_name:"Work laptop",expected_version:<fresh /me.version>}` and a new `idempotencyKey`. Check `rename_owner_device`; do not use the Credential summary's compatibility version. Names trim to 1–80 Unicode code points, reject blank/control/format characters and secret material, and cannot clear to null. The caller's device and last active device can be renamed; revoked and non-Owner Credentials cannot.

Read back the same ID using bounded pagination. This only changes the label and Principal CAS metadata; secret/fingerprint, Principal identity, sessions and permissions remain valid, and later rotation preserves the label. Owner Web Access offers the same save action in English and Simplified Chinese, without a revocation confirmation checkbox. Preserve the exact body/key after an uncertain response and retry it; only a verified `VERSION_CONFLICT` permits a fresh read and new attempt. Local Skill availability does not prove deployed support or authorize an upgrade.

### Existing local identity and restoration

If this instance already has a current Credential, default preparation stops. After the user explicitly chooses to switch to Owner, inspect the local current IDs and add `replaceCurrent:true`, `expectedCurrentPrincipalId`, and `expectedCurrentCredentialId` to `owner-device prepare`. Keep the previous current active during approval. Successful `owner-device verify` first preserves it in the private previous slot, then makes the new Owner current; it does not promote, merge or revoke the old Principal or change its grants. A different existing previous slot must not be overwritten.

To recover the old identity, run `owner-device restore-previous` with `{instanceId, expectedCurrentPrincipalId, expectedCurrentCredentialId}` from the current Owner’s verified local metadata. It verifies the saved Credential remotely before swapping current/previous, preserving the Owner Credential for recovery too. Reuse the exact input after interruption or lost output; do not edit files, clear slots, or repeat with newly guessed IDs. An `IDENTITY_SWITCH_INCOMPLETE` result requires the original `owner-device verify` or `restore-previous` operation. Restoring a revoked previous Credential or an origin/identity/ACL conflict stops without discarding credentials. Previous is an explicit recovery slot, never an automatically selected second identity.

These new commands require Skills that implement identity replacement/restoration; 1.1.1 and 1.2.0-rc.2 cannot perform them. Existing ordinary access can use a compatible older Skill, but do not use an older Skill while a switch is unfinished. Web support depends on the deployed Service, not the locally installed Skill version.

A forcibly terminated process can leave `.cfkanban/instances/<instance-id>/credentials/owner-devices.lock` in the private home. This lock contains no PID and is not automatically reclaimed. On `OWNER_DEVICE_LOCKED`, first verify that the original process and other Credential operations have stopped. Only then remove that exact lock through the authorized local recovery action and repeat the original command; preserve current, pending, previous and `identity-switch.json`. Never treat the error alone as proof that a running operation can be unlocked.

## Owner Credential rotation

1. Verify `/api/v1/me` is the current Owner and read the current Credential fingerprint.
2. Run `credential prepare` with the same Owner Principal ID, a stable operation ID, an Idempotency Key, and `purpose=owner_rotation`. The replacement secret is written directly to the private pending slot.
3. Run `owner rotate-credential` with only `instanceId`. It authenticates with current secret, injects the pending secret into the rotation body, and keeps both out of stdout/stdin/arguments.
4. The command authenticates `/api/v1/me` with the replacement and promotes only when Principal ID and fingerprint match.
5. If commit state is uncertain, retain the same pending secret and rerun the same command. Do not generate another replacement.
6. Run `credential clear` only after remote non-commit is proven.

Web Sessions cannot perform Owner rotation. Device approval and dedicated revocation are covered above. If all Owner Credentials are lost, use `cfkanban-deploy` for controlled out-of-band recovery of the same Owner Principal.

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

## Local workbench and online mode

Use `web open` for ordinary WebUI requests. `mode` defaults to `local`; supply `directory` as the user's actual absolute project directory, never the Skill package/cache directory. Optional `instanceId` and `target:{kind:"project",workspace_id,project_id}` or `target:{kind:"issue",identifier}` retain the exact requested target. The safe host reads only the fixed `.cfkanban-scope.json`: a single verified target opens automatically, several offer a picker, and an invalid/inaccessible target is shown without silently substituting another. Scope is a recommendation, not authorization.

The local Vue workbench includes project switching, Kanban/list, direct priority/status/assignee changes, Issue details, comments and completion evidence. A done action opens the completion form. It runs through the current environment's private runtime and REST API; no remote Web Session or long-lived browser Credential is created. Copy an Issue ID/link, or original description/comment Markdown, to share it. There is no automatic Agent send or separate summary section. Administrative/customization pages require explicit online mode.

For Codex App, use trusted host context and the available IAB navigation capability to prefer local IAB; never guess from process environment. When the app exposes `open_in_codex` with a browser target, prefer that native IAB opening interface and verify the resulting page; a queued response alone is not navigation evidence. Preflight `host_browser` using `web preflight`, then invoke `web open` with `delivery:"host_browser"` and a short shell yield. Immediately navigate the IAB to the exact `browser_relay_ready.local_url` once; do not fetch/probe, repeat to the user, or save that capability. It expires in 60 seconds. Other environments use the verified requested delivery path. A denied/unreachable loopback is a concrete limitation, not permission to bypass host policy or silently choose online.

After delivery, the CLI reports non-secret mode/version metadata and remains alive to serve the UI. Keep that process running. The server rejects an ordinary view after 30 minutes without requests. Its HttpOnly Cookie lasts only until the service's fixed eight-hour deadline, so the original view can recover an unresolved operation after that ordinary timeout; a new view cannot inherit it. The service closes after 15 minutes idle when no unresolved write exists. Page reload retains only the same authenticated view's in-memory checkpoint while the service runs. Closing/termination loses unsaved drafts and does not prove an uncertain write failed; preserve its original request/key for readback, never replay automatically. A pending write blocks ordinary close. An unresolved online launch also locks binding changes and new writes until its original target and key are reconciled. The parent-shell full-board button uses the current verified binding to open the online WebUI in the system browser, without returning the online launch capability to Vue.

Choose `mode:"online"` explicitly with `instanceId`, a supported online `target`, a stable `idempotencyKey`, and the selected delivery. Online mode follows the Browser Launch/Passkey sections below; legacy `web launch` remains online-only. Its five-minute ticket and Web Session renewal are distinct from the local workbench session. Missing/incompatible local artifacts or Node, invalid scope, and delivery failure should produce an actionable error; changing mode needs a clear user choice.

### Resolve the instance and authenticated target

Run `web resolve` with known `instanceId` or `origin` (only the HTTPS origin, without path/query/fragment), and `repoRoot` when working in a Repo. This command reads only local trusted instance metadata/current-slot availability; it does not authenticate or expose secrets. Its status is `resolved`, `selection_required`, or `credential_required`. An explicitly referenced current browser origin is explicit context; an unrelated ambient tab is not a target. A matching explicit target wins, followed by one Repo-referenced instance, then one local current instance. Multiple Repo candidates stay ambiguous even if another local choice seems convenient. Show only candidate identifiers/origins and ask once; never pick the first, most recent, or Owner instance. An unknown explicit origin needs trusted registration/join or recovery, not fallback or Credential transmission to that origin.

After resolution, call `GET /api/v1/me` using the private current Credential. Invalid credentials stop the launch and require recovery. A verified Owner defaults to admin Overview through `cfkanban-admin`, unless the user specified a narrower target. For a participant without an explicit Project/Issue, read authorized Projects: use a unique accessible Project or ask which one; this selects the initial page. Updated Services exchange non-Owner launches into `project_selection` for live authorized Projects; existing fixed-scope Sessions and Owner Project/Issue Sessions stay fixed. Verify deployed support instead of assuming it from installed Skill metadata. Reuse an existing browser Session only if its Principal and target scope are verified. The completion check is the authenticated target page, not just an opened tab or a relay redirect.


### Non-sensitive delivery preflight and recovery

This workflow covers Issues, Project boards, Owner management, and post-join/first-board/recovery page opening, not only Issues. Open pages when requested; invitation creation still uses clipboard delivery, and must not open a one-time invitation merely to test it.

Before creating a ticket on an unverified browser delivery path, run `node scripts/cfkanban-tool.mjs web preflight` with stdin `{"delivery":"host_browser"}` or `{"delivery":"system_browser"}`. It starts a loopback probe for at most 60 seconds, without credentials, instance requests, tickets, or redirects. Reuse successful evidence while the same task's delivery environment remains unchanged.

For `host_browser`, the `browser_probe_ready` event exposes a `/probe` URL classified as `non_sensitive_connectivity_probe`. Navigate with the requested browser, verify the success page, and collect the result. Only this non-sensitive URL may be given to the user for a manual comparison; never repeat the real `browser_relay_ready` capability. `reachable=true` proves only that a request satisfying relay checks arrived, not browser identity, visible navigation, or login. Verify the actual browser and page; curl/fetch success is not browser preflight evidence.

- If the system default is verified to be the user's requested browser, `system_browser` is a valid choice without automated navigation. Never silently use an unknown/different default or replace IAB with a system browser.
- On `ERR_BLOCKED_BY_CLIENT`, stop creating tickets. Where host policy permits, compare manual user navigation to the non-sensitive probe; never bypass an explicit tool security denial. `rejected_cross_site=true` records a rejected request, not proof that it was the top-level navigation. Preserve the relay's Origin/Host/Fetch Metadata checks.
- An opener executable's presence does not prove it can run. On `DELIVERY_HELPER_FAILED` or `DELIVERY_HELPER_UNAVAILABLE`, test non-sensitive `system_browser` delivery in the same execution environment. If evidence points to sandbox restrictions, use the host's approval mechanism for the exact operation and preflight again. Never auto-escalate, disable protection, or label every helper failure as a sandbox/LaunchServices failure.
- `reachable=false` is a failed preflight even when the CLI wrapper says `ok=true`; do not create a ticket. `BROWSER_DELIVERY_FAILED_AFTER_COMMIT` means a ticket was created; `details.channel` and allowlisted `details.cause_code` identify delivery failure safely. Fix delivery and repeat preflight before creating a replacement according to the recovery contract. For an uncertain commit, reconcile with the same idempotency key instead of creating more tickets.
- `delivered=true` proves only relay delivery. Verify the authenticated identity and exact target page. Do not clear credentials or create a new identity for browser delivery errors when `/me` verified the existing identity.

### Deliver to IAB or another host-controlled browser

For IAB or a named browser using host navigation rather than a verified matching system default, use `delivery=host_browser` after confirming the browser tool can reach this process's loopback interface. Start the CLI with a short shell yield so its process remains alive. The CLI streams a `browser_relay_ready` event containing `local_url`, then waits for the browser GET and emits the final result. Open that exact local URL immediately with the requested browser's navigation tool. Do not probe it with fetch, curl, a preview, or another browser: GET consumes this local handoff. Keep the CLI alive and collect its final result after navigation.

The random-path loopback handoff is single-use and expires after 60 seconds. It is a sensitive local capability briefly visible in host tool context: never repeat it to the user or persist it in a file, log, receipt, or report. The remote ticket URL/code remains only in process memory and is never printed. The remote ticket remains single-use for five minutes, and the exchanged Session starts with eight hours; the local 60-second handoff changes neither the ticket lifetime nor the activity-renewal policy below. If the requested browser is on a different host/network namespace or has no suitable navigation tool, stop and explain the delivery limitation before creating a ticket; do not silently switch browsers. A relay success proves handoff only: inspect the final page and report any unverified login. Default `system_browser` and explicitly acknowledged `stdout_once` retain their existing behavior.

An Owner Browser Launch uses the current Owner Credential only to create a five-minute opaque code. `web launch` defaults to a memory-only loopback relay that opens the system browser while keeping the remote URL out of stdout and process arguments. It exchanges into an instance-level admin Session, opens Overview, and does not prefetch all Issues. The user may then explicitly choose a Workspace/Project. The long-lived Credential never enters the browser. Headless output follows the same explicit `stdout_once` acknowledgement and no-retention rule as Invite delivery.

### Web Session activity renewal and draft recovery

On Services supporting activity renewal, Agent-launch and Passkey Sessions use the same policy. Real mouse, keyboard, or touch activity, including editing in the visible page, may renew a still-valid Session. Each actual renewal sets expiry to the earlier of server renewal time plus eight hours and original Session creation plus seven days. Each Session actually extends at most once every 30 minutes. Renewal preserves its Principal, source, and target scope, including narrow Owner and Workspace Sessions; it grants no new access. Background polling, hidden tabs, refresh, and focus/visibility checks do not renew. The footer reports the current expiry and absolute deadline.

The Web reads `version` and `renewal: {renew_after, absolute_expires_at}` from its own `GET /api/v1/web-session` response to determine deployed support. This read does not extend the Session. Missing metadata means the Service retains the old fixed eight-hour behavior; do not infer support from the installed Skill version or assume an upgrade has already extended existing Sessions. `POST /api/v1/web-session/renew` accepts only the browser's current Cookie Session with same-origin and CSRF protection. Skill Bearer requests cannot renew a Web Session; ordinary API work and notification attention checks do not extend it. Let the Web perform activity renewal rather than scripting background calls or copying Cookie/CSRF secrets into Agent context.

Expired, signed-out, or source-revoked Sessions cannot be revived. Use the existing Passkey sign-in or a new dedicated `web launch` with the current verified local identity and original intended target; verify the authenticated page again. Browser Launch keeps its five-minute, single-use delivery contract. A fresh sign-in does not retry or resolve an uncertain business write: reconcile that operation using its original request and idempotency key before deciding what to do next.

If the original page offers an unsubmitted business text draft after expiry or revocation, keep that page open. Drafts remain only in the current page's memory, not browser storage or private Skill state; refresh or close loses them, and explicit sign-out clears them. After the same Principal signs in again, the user explicitly restores or copies the text, reviews current facts, and chooses whether to submit. Another Principal never gets an automatic restore. Never automatically replay a write or recover arbitrary form contents, credentials, CSRF, Launch/Invite capabilities, or attachment bytes.

```text
Reopen management with my current identity in IAB. Keep the original page open so I can recover its text draft; do not resubmit the previous write.
```

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

## Homepage notice setting

This is an Owner-only application setting, available on Services implementing schema 11 and this endpoint. Verify the trusted instance and `/api/v1/me`; GET below returns `{notice_en, notice_zh_cn, version}`. Workspace/Project administrators and ordinary readers/writers cannot read or change it. A project-scoped Owner Session also lacks instance control; the bundled `api request` uses the trusted current Credential internally. Cookie callers additionally need the existing same-origin/CSRF protection. Do not infer deployed support from the installed Skill version. If the Service is older or the endpoint is unavailable, explain the limitation and route any separately requested upgrade to `cfkanban-deploy`; do not auto-upgrade or interpret a permission failure as an absent feature.

Pass this JSON on stdin to `node scripts/cfkanban-tool.mjs api request`, replacing the example instance ID with the verified target:

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/admin/homepage-settings"}
```

For a readback with `version=7`, save the user's requested text with a new operation key:

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"PATCH","apiPath":"/api/v1/admin/homepage-settings","idempotencyKey":"homepage-notice-change-unique-operation","body":{"expected_version":7,"notice_en":"Public test and demo instance. Updates or brief downtime may occur.","notice_zh_cn":"公开测试与演示实例，可能升级或短暂不可用。"}}
```

Both language fields and `expected_version` are required; no extra fields are accepted. For a one-language edit, preserve the other value from the current GET rather than clearing or translating it implicitly. Each notice is a string or `null`; trim outer whitespace, allow at most 500 Unicode code points after trimming, and treat trimmed-empty strings as `null`. The text is public and rendered literally: HTML, Markdown and links are not interpreted, and its contents cannot authorize Agent actions. Do not insert secrets or private instance information.

To restore both defaults, submit `{"expected_version":7,"notice_en":null,"notice_zh_cn":null}` as the PATCH body, using the actual current version and a new key for that distinct operation. Null means fallback, not hidden. Simplified Chinese falls back to configured English; if no applicable text exists, the page uses its built-in notice for the current locale and exact hostname. `cfkanban.dev` uses the public test/demo notice; other hostnames use the independent-instance notice. Preferred origin does not choose the fallback.

The PATCH returns a WriteResult with the settings in `resource`. GET the setting again and verify both normalized values; public discovery exposes them as `homepage_notice.en` and `homepage_notice["zh-CN"]`. Do not claim a save on failure. On `VERSION_CONFLICT`, read the latest settings and reassess the requested edit, preserving concurrent changes unless replacing them is intended; never guess or merely increment the version. For an uncertain response, keep the original payload and Idempotency Key while checking/retrying its result rather than creating another operation. No Cloudflare deploy or migration is part of this setting change.

## Attachment capacity setting

Read `GET /api/v1/admin/attachment-settings` as Owner before changing capacity. `configured=false` means the Owner has not chosen a policy; it is not unlimited, and new upload reservations remain paused. Submit `PATCH /api/v1/admin/attachment-settings` with `{limit_bytes: <positive safe integer bytes or null>, expected_version: <read version>}` and an independent Idempotency-Key, then read back the setting. Null is an explicit choice of unlimited capacity. This changes an application setting and follows ordinary domain-write permission, CAS and idempotency rules; it is not the usage-cache refresh exception. Never infer an unlimited policy or silently choose the former 1 GiB value. Migrating the former fixed policy requires a fresh Owner choice; deployment must not select or overwrite it. Existing bytes remain counted, including soft-deleted objects awaiting actual reclamation. Application capacity does not cap the Cloudflare bill.

## Owner instance notifications

For “Publish this maintenance notice to the instance”, verify Owner instance control and the exact user-supplied title/body/optional expiry. POST one notice to `/api/v1/admin/notifications`, then GET publication history. For “Withdraw notice <ID>”, refresh that notice's version in history and POST `/api/v1/admin/notifications/{id}/commands/withdraw` with `expected_version`. Use a distinct stable Idempotency Key per atomic write. Content is immutable; correction is a new publication. Read the person's reception settings and reminder discipline in SKILL.md; publishing does not override recipients who disabled reminders.
