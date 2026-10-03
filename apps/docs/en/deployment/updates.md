# Instance upgrades

This page covers the live Cloudflare instance. Local Skills, MCP, and host plugins have a separate [update workflow](../integrations/general.md); updating them does not upgrade the site.

## Check versions

```text
Use $cfkanban-deploy to check my local cfKanban Skills and <instance address>.
Show compatible stable updates without installing anything.
```

**In the Web UI:** The Owner can see the site's version under **Administration → Overview → Service information & access limits**. Ask the Agent to check the local Skill and actual running integration versions separately.

## Update local Skills

Use [General agents](../integrations/general.md) for local Skill updates, saved Git-source changes, and host reloads. For DSH profile installation and restart, see [DeepSeek Harness](../integrations/deepseek-harness.md).

## Upgrade the live site

```text
Use $cfkanban-deploy to prepare an upgrade of <instance address> to the latest stable release.
Explain the version, database changes, expected effects, and recovery options for my approval before execution.
```

You need current Owner access, Cloudflare account authority, and local maintenance records. On a new computer, first [connect the existing deployment](./attach.md). The Agent explains resource, data, and cost effects, then verifies the site's version, access, and original identity after upgrading.

Use an Agent to upgrade; there is no Web upgrade button. If older Skills cannot handle the new release, update the local Skills first using the installation guide.

## If an upgrade stops or fails

Keep the maintenance records and ask the Agent to [check and resume the original plan](./recovery.md). Do not redeploy an empty instance or delete the records.

Rolling back the application does not roll back its database. Database restoration can overwrite newer data and needs separate approval. New costs, domains, or permissions must also be explained first. Execution keeps the approved version instead of silently switching to a newer release.
