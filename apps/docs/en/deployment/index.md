# Deployment

Use `cfkanban-deploy` for Cloudflare deployment and upgrades, deployment maintenance on another computer, and out-of-band Owner recovery. Host Skill/MCP/plugin installation is covered by [Agent integrations](../integrations/index.md). Joining someone else's Project or using a board does not require your own deployment.

## Start with your goal

```text
Use $cfkanban-deploy to check what I still need to deploy cfKanban. Keep this check read-only.
```

The Agent checks verified stable releases, tools, and environment capabilities, then explains readiness and missing prerequisites. Checking does not automatically install software, sign in to Cloudflare, or create resources.

| Goal | Workflow | Required access |
| --- | --- | --- |
| Install or update host Skills, MCP, or plugins | [Agent integrations](../integrations/index.md) | Local installation; no Cloudflare access |
| Create your instance | [First deployment](./first-deployment.md) | Control of the exact Cloudflare account |
| Upgrade a running instance | [Updates and upgrades](./updates.md) | Maintenance record, Owner and Cloudflare access |
| Manage the application from another computer | [Owner devices](../administration/devices.md) | Approval by an existing Owner |
| Maintain deployment from another computer | [Connect an existing deployment](./attach.md) | Current Owner and exact Cloudflare access |
| Resume work or recover the Owner | [Interruption and recovery](./recovery.md) | The relevant plan and recovery authority |
| Configure domains, R2, metrics, or rate limits | [Optional configuration](./optional.md) | Explicit deployment and external-effects scope |

The Owner controls the application. Cloudflare authentication controls infrastructure. Both are verified separately; one identity does not imply the other authority.

## Default deployment and releases

The default uses one Worker, one D1 database, and a website at a `workers.dev` address. It selects the latest stable release. Attachments, custom domains, and prereleases are explicit choices.

**In the Web UI:** Administration shows the instance version, usage, and selected application settings. cfKanban does not provide a cloud deployment console. Deployment uses the Agent and verified tools. A browser may participate in Cloudflare authentication or consent, without replacing the deployment plan.

## Expected delivery

Review resources and effects before execution, then receive the site address and verification results. If interrupted, keep maintenance records and ask the Agent to check before resuming.
