# Interruption and recovery

Distinguish interrupted deployment, device-connection failure, and identity loss first. Recovery checks the original operation and actual state rather than initializing an existing instance again.

## Resume deployment or upgrade

```text
Use $cfkanban-deploy to inspect my interrupted operation for <instance address or deployment target>.
Read its original plan and maintenance records, verify actual remote state, and continue where the original authorization remains valid and the plan has not drifted.
```

You need the original local plan, operation records, and relevant Cloudflare authority. The Agent checks resource ownership, current Worker deployment, migration ledger, and actual schema. If Owner initialization returned an uncertain result, it checks committed facts before deciding what remains.

The result may finish pending steps, verify steps already committed, or report the exact difference preventing safe continuation. A timeout does not prove nothing happened remotely. Do not change resource names or generate a fresh Credential just to try again.

An unchanged, fully approved plan can continue in the same authorized task. Plan changes, a different authorization context, or a narrower user limit require reviewing the exact current effects again. Do not delete pending state, maintenance records, or unknown lock files to bypass a stop.

**In the Web UI:** There is no deployment-resume button. The website can help show reachability, but cannot replace resource, migration, and Owner identity verification.

## Choose the right identity recovery

| Current situation | Route |
| --- | --- |
| The Owner API Credential still works and needs replacement | [Administration: ordinary rotation](../administration/devices.md) |
| Another device still works and a new computer needs access | [Administration: add an Owner device](../administration/devices.md) |
| Local secrets are lost, but a valid Owner admin browser Session remains and an API Credential is still unrevoked on the server | Approve a new device in Web, then verify it on that device |
| A participant loses identity access | Ask the Owner for a recovery invitation bound to that participant |
| No usable Owner connection path remains, or all old Owner API Credentials must be revoked | Out-of-band Owner recovery below |

## Total Owner Credential recovery

```text
All my Owner Credentials are lost and local records may also be missing.
Use $cfkanban-deploy to inspect recovery options and identify the exact instance in my confirmed Cloudflare account.
Show a recovery plan for the same Owner and the effects of revoking every old Owner API Credential. Do not execute it yet.
```

You need control of the Worker/D1 in the exact Cloudflare account; an old application Credential is not required. The Agent verifies cfKanban instance markers and public discovery in that account. A naming prefix is not identity evidence. Multiple candidates or incomplete checks require choosing the target instead of assuming it is unique.

The plan should explain that the same Owner Principal, name, business content, member access, assignments, and history remain. All previous Owner API Credentials and their derived browser access are revoked. Independent Passkeys and their independently authenticated Sessions remain. The replacement Credential is saved privately in the current local environment.

```text
I approve the Owner recovery plan for the exact instance just verified, including revoking all old Owner API Credentials while retaining independent Passkeys.
Use $cfkanban-deploy to execute it and verify the replacement for the same Owner.
```

Completion requires reading back the recovery operation and authenticating the replacement as the original Owner. Recovery does not create a new Owner, deploy a Worker, migrate the schema, or rebuild an empty database. Resume interruption with the same plan and replacement instead of issuing another Credential.

**In the Web UI:** Dedicated total-loss recovery has no anonymous or application recovery button. Even if Passkey sign-in works, this dedicated flow still needs Cloudflare authority. The Web device-approval alternative above is different from recovery that revokes every old API Credential.

## What recovery does not include

The Skill does not provide complete database export/import, one-click backup restoration, or automatic D1 Time Travel. Worker rollback does not roll back the database. Restoring a database with possible data loss is a separate operation requiring an exact target and reviewed impact.
