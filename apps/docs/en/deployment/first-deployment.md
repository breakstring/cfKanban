# First deployment

Create a cfKanban site in your own Cloudflare account. Joining an existing project does not require deployment.

## Ask your Agent

```text
Use $cfkanban-deploy to deploy cfKanban with the latest stable release and default core configuration.
Use <your name> as my Owner display name. Check readiness and explain resources, costs, and access changes for my approval before execution.
```

You need an Agent environment supporting cfKanban Skills, persistent private storage, and control of a Cloudflare account. Follow [Deployment preparation](./setup.md) if tools or sign-in are missing.

## Review the deployment plan

The default uses one Cloudflare Worker, one D1 database, and a `workers.dev` address, including the website and documentation. Attachment storage and custom domains are separate choices.

Before execution, check:

- The Cloudflare account, release, and resource names.
- Your Owner name and the site's address.
- Required installations, possible charges, and additional permissions.

The default configuration does not guarantee zero charges; actual allowances and costs depend on your Cloudflare account. If a site already exists, [connect the existing deployment](./attach.md) instead of initializing it again.

## After deployment

The Agent provides the site address and verifies availability and your Owner identity. Credentials are stored privately on your computer; do not paste them into chat. If interrupted, keep maintenance records and use [Interruption and recovery](./recovery.md).

Next, create your first board:

```text
Use $cfkanban-admin to create DemoProject in the Product workspace.
Create the workspace if it does not exist, then open my first board.
```

You can then [create issues](../usage/issues.md) or [invite members](../administration/members.md). Cloudflare sign-in may need browser interaction; cfKanban itself has no Web deployment button.
