# Interruption and recovery

If deployment stops or identity access is lost, check the existing state first. Do not reinitialize an existing site.

## Resume deployment or upgrade

```text
Use $cfkanban-deploy to resume my interrupted deployment or upgrade for <instance address or deployment target>.
Check which steps have completed, then continue the remaining work. Tell me first if the original plan needs to change.
```

You need the relevant Cloudflare authority and original maintenance records. The Agent keeps the original plan and records and checks what happened before resuming. A timeout does not mean nothing happened in the cloud. Do not rename resources, delete local records, or create a new identity just to retry.

If the initial database migration failed or its result is uncertain, the Agent reads back the database first. Without evidence that the full migration succeeded, it stops and reports the remaining state. It preserves the same plan and records for review; it does not automatically repeat the migration or rebuild the database.

**In the Web UI:** There is no deployment-resume button. An accessible homepage alone does not prove every deployment step completed.

## Choose an identity recovery route

| Situation | Next step |
| --- | --- |
| Your Owner identity still works on another computer | [Add an Owner device](../administration/devices.md) |
| An Owner administration page is still usable | Ask the Agent to check whether Web approval can connect a new device |
| A participant cannot use their original identity | Ask the Owner for an identity recovery invitation |
| No Owner connection route remains, or all old device credentials must be revoked | Use total Owner recovery below |

## Total Owner recovery

```text
All my Owner credentials are lost.
Use $cfkanban-deploy to verify <instance address> in my Cloudflare account.
Explain recovery of the original Owner and revocation of all old credentials without executing it yet.
```

You need control of the site's Cloudflare account; a Passkey alone is insufficient. Recovery preserves the original Owner, issues, member access, and history. It revokes all old Owner Agent credentials and browser sign-ins created through them. Independent Passkeys and their sessions remain.

After checking the target and effects, confirm:

```text
I approve the Owner recovery plan just verified, including revoking all old Owner credentials while retaining independent Passkeys.
Complete recovery and verify that I am still the original Owner.
```

The Agent stores the replacement privately on your computer. Recovery does not create a new Owner or erase data. Resume the same operation if it is interrupted.

## Data recovery boundaries

Identity recovery is not database recovery. The Skill does not provide one-click backup restoration, and rolling back the application does not roll back its database. Overwriting a database can lose newer data and requires a separate review of the target and effects.
