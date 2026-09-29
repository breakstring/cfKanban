# Deployment

Use `cfkanban-deploy` for local Skill installation and updates, Cloudflare deployment and upgrades, connecting an existing deployment, and out-of-band Owner recovery. Joining someone else's Project or using a board does not require your own deployment.

## Start with your goal

```text
Use $cfkanban-deploy to check what I still need to deploy cfKanban. Keep this check read-only.
```

The Agent checks verified stable releases, tools, and environment capabilities, then explains readiness and missing prerequisites. Checking does not automatically install software, sign in to Cloudflare, or create resources.

| Goal | Workflow | Required access |
| --- | --- | --- |
| Install or update local Skills | [Preparation](./setup.md), [Updates](./updates.md) | Local installation; no Cloudflare access |
| Create your instance | [First deployment](./first-deployment.md) | Control of the exact Cloudflare account |
| Upgrade a running instance | [Updates and upgrades](./updates.md) | Maintenance record, Owner and Cloudflare access |
| Manage the application from another computer | [Owner devices](../administration/devices.md) | Approval by an existing Owner |
| Maintain deployment from another computer | [Connect an existing deployment](./attach.md) | Current Owner and exact Cloudflare access |
| Resume work or recover the Owner | [Interruption and recovery](./recovery.md) | The relevant plan and recovery authority |
| Configure domains, R2, metrics, or rate limits | [Optional configuration](./optional.md) | Explicit deployment and external-effects scope |

The Owner controls the application. Cloudflare authentication controls infrastructure. Both are verified separately; one identity does not imply the other authority.

## Default deployment and releases

The core configuration uses one Worker, one D1, and bundled Web assets on `workers.dev`. Optional capabilities such as attachment storage need explicit plans. The Skill discovers the latest stable release, then pins its version, verifies artifacts and compatibility, and keeps that target fixed throughout execution.

Prereleases and source evaluation require an explicit choice. A local marketplace version only describes Skill discovery or installation. It does not prove that the corresponding Service was released, deployed, or loaded by the current Agent conversation.

**In the Web UI:** Administration shows the instance version, usage, and selected application settings. cfKanban does not provide a cloud deployment console. Deployment uses the Agent and verified tools. A browser may participate in Cloudflare authentication or consent, without replacing the deployment plan.

## Expected delivery

Review exact resources and effects before execution, then receive the instance address and verification results. Upgrade and recovery reports should explain identity and data continuity and identify anything unverified. If interrupted, keep the private maintenance records and read back the actual state before resuming.
