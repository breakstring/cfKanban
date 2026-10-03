# Prepare for deployment

You need a Cloudflare account, an Owner display name, and an Agent environment that can retain private identity and maintenance records. The Agent checks Skills, compatible tools, and sign-in during deployment; you do not need to install everything separately first.

## Check before deciding

```text
Read the official cfKanban installation guide and check whether this computer is ready to deploy:
https://github.com/breakstring/cfKanban/releases/latest/download/install.md
Only inspect readiness. List missing tools, sign-in, or storage requirements; do not install anything or create resources.
```

The Agent reuses compatible Skills and tools where possible. When you start [First deployment](./first-deployment.md), it can prepare missing Skills as part of the workflow. It explains the impact before installing tools or changing the environment. If you want to prepare your Agent environment in advance, see [Installation and connections](../integrations/index.md).

## Three things to confirm

1. **Which Cloudflare account to use.** Specify the target if you have several. When sign-in is needed, complete it on Cloudflare's official page in your browser. Do not paste tokens into chat.
2. **The Owner display name.** This names your identity in the new instance, which you will manage after deployment.
3. **Whether local records will persist.** Choose private storage you can access later. Temporary containers, remote environments, and WSL are separate environments and need their own checks.

Signing in to Cloudflare does not immediately create resources. Review the resources, costs, and permissions after the Agent presents a deployment plan. For an existing instance, use [Connect an existing deployment](./attach.md) to avoid initializing another one.

If you only want to use someone else's project, go straight to [Joining and signing in](../usage/access.md). No Cloudflare setup is needed.
