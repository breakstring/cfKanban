---
name: cfkanban-admin
description: Administer cfKanban Workspaces, Projects, invitations, Grants, participant Credentials, Public Join, quotas, tombstone recovery, preferred origin, and the Owner Web surface. Do not use for Cloudflare resource deployment.
---

# cfKanban Admin

Use this Skill only with a verified Deployment Owner Credential. For the same operational guide in Simplified Chinese, read [references/owner-workflows.zh-CN.md](references/owner-workflows.zh-CN.md).

## What this Skill can do

- Create, inspect, rename, pause, and restore Workspaces and Projects; rename fixed status display labels.
- Create and revoke Project or Principal Recovery Invites, and inspect their status without exposing Invite codes.
- List Principals, participant Credentials, Grants, and audit events; change/revoke Grants and revoke participant Credentials.
- Rotate the Owner Credential through a pending-secret workflow that never exposes either secret.
- Configure one Project's Public Join policy and active resource limits; inspect deployed request-rate settings.
- Change the preferred API origin after a credential-free probe and open an Owner-scoped Web session.

This Skill uses the application REST API only. Use `cfkanban` for daily Issue work and `cfkanban-deploy` for Cloudflare resources, deployment, migrations, Instance upgrades, or total Owner Credential loss.

## Intent-first user experience

Treat a plain request such as “Create my first cfKanban board” as sufficient to begin. Do not require the user to specify Owner verification, readback, Browser Launch, idempotency, or concurrency terminology. Verify the Owner and current state first, ask concisely for any missing Workspace and Project names/keys, explain the writes at the required authorization boundary, and carry the task through to a verified usable board. Keep implementation terminology in technical evidence, not in a prompt the user must compose.

## Command entry point

Run commands from this Skill directory:

```text
node scripts/cfkanban-tool.mjs help
node scripts/cfkanban-tool.mjs <command>
```

`help` returns only the commands available to this Skill. Other commands receive structured JSON on stdin. Use `api request` for ordinary application operations. Never put a Credential into the input: `owner rotate-credential` reads current and pending secrets internally, verifies the replacement through `/api/v1/me`, and only then promotes it.

## Task-to-command map

| Goal | Command or REST operation | Required handling |
| --- | --- | --- |
| Verify Owner identity | `state inspect`, then `api request` → `GET /api/v1/me` | Require `is_owner=true`; never infer Owner from display name. |
| Create the first usable board | create one Workspace, create one Project, read both back, then `POST /api/v1/web-launches` with an `admin` target | Ask for explicit immutable keys and display names; normalize the chosen Workspace key to lowercase and Project key to uppercase before preview and submission; each create is a separate atomic write. |
| Manage Workspaces and Projects | Workspace/Project `GET/POST/PATCH/DELETE` plus single-resource `commands/restore` | Use explicit keys/IDs, CAS where defined, one Idempotency Key per atomic write, and readback. |
| Rename fixed status labels | `GET .../statuses`, `PATCH .../statuses/{status_key}` | Only display names change; stable keys, order, category, and terminal meaning do not. |
| Create or revoke an Invite | `/api/v1/admin/invitations` and `/api/v1/admin/invitations/{invitation_id}` through `api request` | Always submit explicit Project roles; never log or retain the complete Invite URL. |
| Recover a participant | Create a Principal Recovery Invite through the admin invitation endpoint | Bind the exact Principal ID and immutable `rotation | full_recovery` mode; show exact revocation scope first. |
| Manage access | Principal, Credential, Project Grant, and Passkey admin endpoints | Display names are not identity selectors; read back every role change or revocation. |
| Rotate Owner Credential | `credential prepare` with `purpose=owner_rotation`, then `owner rotate-credential` | Keep the same pending secret/Idempotency Key on uncertainty; promotion follows verified `/me` readback. |
| Configure Public Join | `GET/PUT/DELETE /api/v1/admin/projects/{project_id}/public-join` | One Project, explicit role, explicit public summary; disabling does not revoke existing Grants. |
| Configure active quotas | `GET/PATCH /api/v1/admin/projects/{project_id}/resource-limits` | Explicit Issue/Comment/non-Owner Principal limits; 50/500/50 is a suggestion, never a silent default. |
| Inspect request-rate settings | `GET /api/v1/admin/rate-limit-settings` | Read-only here; changing Worker bindings belongs to `cfkanban-deploy`. |
| Restore content or a container | Stable resource read or explicit `deleted=only`, then one restore endpoint | Before container restore, show every enabled Public Join policy that will resume. |
| Change preferred origin | `origin rebind-check`, then `GET/PUT /api/v1/admin/instance-origin` | Probe the candidate without a Credential, use expected version, then cross-read both origins. |
| Open Owner Web | `POST /api/v1/web-launches` with an `admin` target | URL contains only a five-minute one-time code; default to Overview. |
| Inspect audit history | `GET /api/v1/admin/audit-events` | Use bounded pagination; when the task has a known scope, pass one immutable `project_id` and/or `stream=domain|security`, then verify `resolved_filters`. |

The complete request and recovery guide is [references/owner-workflows.md](references/owner-workflows.md).

Audit reads without `project_id` or `stream` deliberately cover the whole Instance and both streams. Reuse `next_cursor` only with the exact same filters; changing either filter starts a fresh read.

## First-use workflow after deployment

1. Verify local state, trusted origin, `/api/v1/me`, and `is_owner=true`.
2. Ask only for the missing Workspace key/name and Project key/name; do not derive keys from a filesystem path, Git remote, hostname, or display name without explicit user choice. Accept the user's chosen keys in either letter case, normalize the Workspace key to lowercase and the Project key to uppercase, then validate `[a-z][a-z0-9-]{1,31}` and `[A-Z][A-Z0-9-]{1,15}` respectively.
3. Show the normalized immutable keys in the preview, create one Workspace, then read it back. Create one Project in that Workspace with a new Idempotency Key, then read it and its five fixed statuses back. Do not ask the user to retype a key only to satisfy letter case.
4. Create an Owner Browser Launch only after both resources exist. Deployment does not create a default Workspace, Project, Label, Grant, or Issue.
5. Offer, but do not silently perform, the next independent actions: create the first Issue with `cfkanban`, create an explicit-role Invite, or configure Public Join with explicit quotas.

## Required workflow

1. Run `help`, validate local state and origin, then verify `/api/v1/me` is the Deployment Owner.
2. Read the target resource, current `version`, permission impact, and any linked Public Join/quota state.
3. Present the exact target and consequence before a security-sensitive or public-access change.
4. Execute one atomic API operation with an independent Idempotency Key and expected version where defined.
5. Read back the resource and relevant audit event. Report earlier committed calls separately if a later call fails.

## Contract and stop conditions

- **MUST:** Every mutation has an explicit target, expected version where defined, independent Idempotency Key, impact summary, and readback.
- **MUST:** Before Workspace/Project creation, case-normalize explicit user-chosen keys, validate the canonical forms, and show the exact immutable values that will be stored. Case normalization does not authorize deriving or otherwise rewriting a key.
- **MUST:** Invite roles are always explicit. Recovery binds a stable Principal ID and immutable recovery mode; display names never select identity.
- **MUST:** Owner rotation first writes the replacement to the private pending slot. Web Sessions cannot rotate or revoke Owner Credentials.
- **SHOULD:** Recommend `writer` only when no higher-level role exists; explicit read-only intent means `reader`. The API still receives the resolved role explicitly.
- **DECIDES:** The user or higher-level Agent controls preview, confirmation, ordering, and continuation of multi-call goals.

Stop on a non-Owner identity, ambiguous target, stale version, unverified origin, hidden Public Join reactivation, unresolved pending Credential, or any request to manage D1/Cloudflare directly. Total Owner Credential loss must move to `cfkanban-deploy`.
