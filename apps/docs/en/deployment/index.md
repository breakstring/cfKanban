# Getting started as an Owner

Start here if you want to deploy your own cfKanban site or already maintain one as its Owner. If you only want to use a team's board or administer an authorized workspace or project, see [Join and use](../usage/index.md). You do not need a Cloudflare account.

## Your first deployment

Start with [First deployment](./first-deployment.md). Prepare a Cloudflare account and Owner display name, then give the deployment request to your Agent. **Skills are installed during the workflow when needed; you do not need another installation tutorial first.** The default setup uses one Worker, one D1 database, and a `workers.dev` address, including the Web UI and docs.

```text
I want to deploy my own cfKanban site. First check readiness using the official installation guide:
https://github.com/breakstring/cfKanban/releases/latest/download/install.md
Tell me what I need to prepare. Do not install anything or create resources yet.
```

See [Prepare for deployment](./setup.md) for local, account, and persistent storage requirements. Before execution, the Agent shows the specific resources, version, and cost implications for your confirmation.

## Already an Owner?

| What you want to do | Read |
| --- | --- |
| Create workspaces and organize projects and members | [Manage workspaces and projects](../administration/index.md) |
| Change site text, inspect usage, or publish notices | [Instance settings and usage](../administration/settings.md) |
| Allow visitors to join selected projects | [Public Join and quotas](../administration/public-join.md) |
| Add Owner devices or recover participant identities | [Devices and identity recovery](../administration/devices.md) |
| Archive, restore, or permanently remove content | [Archive and cleanup](../administration/cleanup.md) |
| Upgrade the online version | [Instance upgrades](./updates.md) |
| Maintain deployment from another computer | [Connect another computer](./attach.md) |
| Resume interrupted work or recover the Owner | [Interruptions and recovery](./recovery.md) |
| Configure domains, attachment storage, or other options | [Domains and optional features](./optional.md) |

**In the Web UI:** The full online app's management center provides application settings within your permissions. The Agent handles creating cloud resources and upgrading or recovering deployments; the Web UI is not a deployment console.

Your Owner identity lets you manage cfKanban; Cloudflare account permissions let you maintain its cloud resources. They are checked separately. Moving to another computer only to manage the application does not require taking over cloud deployment too. To update only Agent Skills or the DSH plugin, see [Installation and connections](../integrations/index.md); this does not upgrade the online instance.

[Public CLI task guides](../cli/index.md) cover the same Service semantics from a terminal.
