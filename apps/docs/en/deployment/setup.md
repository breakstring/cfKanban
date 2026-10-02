# Prepare for deployment

Hosting or maintaining your own cfKanban instance requires Cloudflare authority and persistent private maintenance records. Connecting an Agent to an existing board is covered by [Agent integrations](../integrations/index.md).

## Check readiness

```text
Use $cfkanban-deploy to check whether this computer is ready to deploy cfKanban without changing anything.
Explain any missing tools, sign-in, or local storage requirements.
```

The Agent checks the selected release, tools, execution environment, and storage, reusing compatible tools where possible. It explains required installations or environment changes first. For containers, remote sessions, or temporary environments, make sure private identity and maintenance records survive after you leave. Native Windows and WSL need separate preparation.

## Install the Skills

Install and verify the `cfkanban-deploy` entry as part of the complete four-Skill bundle using [General installation](../integrations/general.md#install-the-skills), or the [DeepSeek Harness plugin](../integrations/deepseek-harness.md) if that is your host. Local installation and updates need no Cloudflare account and do not create or upgrade an instance.

## Sign in to Cloudflare

```text
Use $cfkanban-deploy to check my current Cloudflare sign-in and target account.
Explain any new sign-in or extra permissions for my approval first.
```

**In the browser:** Review the account and permissions on Cloudflare's official page before signing in. Choose the correct deployment account if you have several. Do not paste Cloudflare Tokens or cfKanban credentials into chat.

cfKanban Owner access and Cloudflare authority are separate. Signing in does not immediately create resources. Continue with [First deployment](./first-deployment.md).

If you only want to use someone else's board, see [Join and sign in](../usage/access.md).
