# First deployment

Create an independent instance in your Cloudflare account from a verified stable release. You do not need this workflow to join an existing Project.

## Ask your Agent

```text
Use $cfkanban-deploy to deploy cfKanban for me using the latest stable release and the default core configuration.
Use <your name> as my Owner display name. Check readiness and show the exact deployment plan before I approve execution.
```

You need a compatible Agent environment, a user home that can persist private state, and control of the target Cloudflare account. If tools or authentication are missing, the Agent explains the required preparation and its effects; see [Deployment preparation](./setup.md). You choose the Owner's display name. It is not inferred from your operating system or Git identity.

## What the plan should include

The default configuration contains one Worker, one D1 database, the bundled website, and a `workers.dev` address. Documentation and Web assets ship with the Service. It does not automatically enable R2 attachments, a custom domain, or other optional products. Actual platform allowances and charges depend on your Cloudflare account.

The plan identifies:

- The exact release, source, and verification results.
- The Cloudflare account, new Worker and D1 names, and evidence that those names are unused.
- The Owner name, instance identity, migrations, and request-rate settings.
- Necessary local installations, private Credential storage, and the full deployment scope.

If only a prerelease is available or the source cannot be verified, the Agent explains the limitation. It does not substitute a prerelease, plugin cache, or source checkout for a stable release, nor adopt an unknown existing resource with the same name.

## Execution and completion

After approval of the exact plan, the Agent creates resources, applies and verifies migrations, generates the deployment configuration, validates the Worker bundle, deploys it, and initializes the Owner. Safe helpers save the Credential directly under the current environment user's private `~/.cfkanban/` directory. You do not paste a secret into chat.

The completion report should provide a working instance address and verified instance, Service/schema, and Owner identity. A successful command, an accessible homepage, or a created database alone does not prove complete deployment. If interrupted, preserve the plan and state and use [Interruption and recovery](./recovery.md).

**In the Web UI:** cfKanban does not create Cloudflare resources through its application UI. Cloudflare sign-in or consent may happen in a browser, but this is separate from cfKanban sign-in. The deployed website provides application management.

## Create your first board

Deployment creates the instance and Owner, without adding Workspaces, Projects, or Issues. After successful verification, ask the administration Skill:

```text
Use $cfkanban-admin to create DemoProject in the Product workspace and open my first board.
```

The Agent verifies the Owner, creates or resolves the exact containers, then opens an authenticated page. Next, [create an Issue](../usage/issues.md) or [invite members](../administration/members.md). These application actions are separate from deployment and follow your explicit request.

## Common questions

**Why verify a release after installing a plugin?** A plugin lets the host discover Skills. Deployment requires verified, immutable artifacts from the canonical release.

**What if an instance already exists?** Use [Connect an existing deployment](./attach.md), without reinitializing it through first deployment.

**Does the default mean there can never be charges?** It selects the core components, without guaranteeing account costs. Optional paid capabilities, subscriptions, and domain changes require their own disclosed scope and authorization.
