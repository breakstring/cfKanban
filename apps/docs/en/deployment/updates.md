# Skill updates and instance upgrades

Local Skills and the deployed Service have separate update paths. Checking both does not update either one. Updating Skills does not automatically upgrade an instance.

## Check versions only

```text
Use $cfkanban-deploy to check my local cfKanban Skills, the version loaded by this conversation, and the version at <instance address>.
Compare them with the latest stable release and explain compatibility without updating anything.
```

Expect separately identified versions and available updates. The Agent verifies the canonical release and compatibility matrix. If a newer Skill cannot operate an older instance, it retains a trusted compatible installation or proposes an exact compatible version instead of forcing a server upgrade.

**In the Web UI:** The Owner can view the instance release, API, and schema under **Administration → Overview → Service information & access limits**. The website cannot report or update every local Agent's installation and loaded version.

## Update local Skills

```text
Use $cfkanban-deploy to update my local cfKanban Skills to the latest compatible stable release.
Update only the local Skills and the agreed host entry, without upgrading the deployed instance.
```

This needs local installation authorization, not Cloudflare login. The Agent pins and verifies the target, installs the complete bundle into an isolated version directory, verifies it, then switches while keeping the previous known-good release.

The result distinguishes the canonical bundle, host projection, and current conversation loading. Updating the host entry does not reload an existing conversation. Start a new one when needed to verify discovery. A failure preserves or restores the previous version according to the plan and does not change the remote database.

## Upgrade an instance

```text
Use $cfkanban-deploy to plan an upgrade of <instance address> to the latest stable release.
Verify the exact resources, current version, migrations, and recovery evidence, then show the effects for my approval.
```

You need an exact maintenance record, current Owner access, and authority over the target Cloudflare account. On a new computer without that record, first [connect the existing deployment](./attach.md). The plan identifies Worker/D1 resources, current bindings, target artifacts, database migrations, restore evidence when required, and preservation of optional R2 and analytics configuration.

After approval, the Agent checks the migration manifest, applied ledger, and actual schema, executes planned migrations and Worker deployment, and verifies health, discovery, Service/schema, instance identity, and the unchanged Owner identity. Local Skill updates remain separate.

**In the Web UI:** There is no instance-upgrade button. Use administration to inspect the deployed version and application behavior afterward; the deployment Agent provides remote verification evidence.

## Recovery boundaries

Database migrations, Worker code, and static assets must remain compatible. Unknown baselines, ledger or checksum drift, partially applied schema, unexpected bindings, or missing required restore evidence stop the workflow for investigation.

Rolling back a Worker does not roll back D1. D1 restoration may overwrite data, is never automatic, and is not the default response to an upgrade failure. Incompatible changes, resource replacement, domains, costs, or permission changes require a newly explained exact plan.

## Common questions

**What if another version is released after the check?** An approved plan pins one exact version. Execution does not silently follow a newer release; assess that target separately.

**Why does the Agent still use an old version after installation succeeds?** Host projection and current conversation loading may lag. Verify them separately and start a new conversation if the host requires it.

**Was the upgrade interrupted?** Preserve the same plan and maintenance records and use [Interruption and recovery](./recovery.md) to inspect actual state. Do not restart first deployment.
