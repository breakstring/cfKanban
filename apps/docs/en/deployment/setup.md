# Preparation and Skill installation

Installing Skills does not require a Cloudflare account. Hosting or maintaining your own site does.

## Check readiness

```text
Use $cfkanban-deploy to check whether this computer is ready to deploy cfKanban without changing anything.
Explain any missing tools, sign-in, or local storage requirements.
```

The Agent checks and reuses compatible tools where possible. It explains required installations or environment changes first. For containers, remote sessions, or temporary environments, make sure private identity and maintenance records survive after you leave. Native Windows and WSL need separate preparation.

## Install the Skills

```text
Install the official stable cfKanban Skills for this Agent host.
Explain the local changes and verify that the Skills can be loaded afterward.
```

The Agent first identifies your host and its supported installation method, then discovers and verifies the official stable release. The full bundle includes daily use, administration, deployment, Howto guidance, and a shared runtime that must stay with the Skills.

A compatible Git plugin or marketplace source can follow the repository’s default `main` branch, which contains published stable releases. Codex with plugin support is one example: ordinary installation omits `--ref`, even though the Agent fixes an exact version and digest for installation verification. A host that loads local Skill directories installs the complete verified bundle using its own supported directory layout. Both paths verify the selected release, actual installed content, and saved update source.

You may need a new conversation after installation. An existing compatible version can be reused without reinstalling each time. Only a Git-based installation pinned to an old tag needs the one-time source change described in [Skill updates](./updates.md).

## Sign in to Cloudflare

```text
Use $cfkanban-deploy to check my current Cloudflare sign-in and target account.
Explain any new sign-in or extra permissions for my approval first.
```

**In the browser:** Review the account and permissions on Cloudflare's official page before signing in. Choose the correct deployment account if you have several. Do not paste Cloudflare Tokens or cfKanban credentials into chat.

cfKanban Owner access and Cloudflare authority are separate. Signing in to Cloudflare does not immediately create resources. Continue with [First deployment](./first-deployment.md).

If you only want to use someone else's board, see [Joining and signing in](../usage/access.md).
