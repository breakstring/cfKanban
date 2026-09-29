# Preparation and Skill installation

Inspect the environment and reuse compatible tools first. Local Skill installation does not require Cloudflare sign-in; hosting or maintaining an instance does.

## Check the environment

```text
Use $cfkanban-deploy to inspect this environment, Node, Wrangler, and available stable releases without making changes.
Explain what can be reused and what is still required before deployment.
```

Expect a compatibility and host-capability report. The Agent checks Node and Wrangler against the target release's supported range rather than assuming the latest version is suitable. It reuses compatible existing Wrangler or a cfKanban private Tool Runtime and proposes a pinned installation only when needed.

Your execution environment needs persistent private storage in the user's home. Confirm persistence for containers, remote sessions, or temporary environments. Native Windows and WSL are separate environments; they do not automatically share tools, Cloudflare authentication, or Credentials.

**In the Web UI:** There is no environment-check or local-tool installation page. Use an Agent. If Node is missing, you choose its installation method. The workflow does not silently change global Node, PATH, or shell settings.

## Install or expose the Skills

```text
Install the stable cfKanban Skills for this Agent host.
Verify the official release, compatibility, and installation directory, explain the local changes, and complete installation and verification within my approval.
```

The bundle includes three operational Skills, `cfkanban`, `cfkanban-admin`, and `cfkanban-deploy`, plus the read-only guide `cfkanban-howto`. If your host cannot discover the deployment Skill yet, use its supported plugin or Skill installation flow to load the official entry point before continuing release verification.

Installation uses the complete verified bundle, including shared runtime modules and relative paths. Canonical Skills and cfKanban maintenance state live under private `~/.cfkanban/`; the host's own plugin directories expose Skills to the host. They serve different purposes. Copying a single `SKILL.md` does not install the complete bundle.

The result should separately report whether the canonical Skill bundle switched, the host entry updated, and the current Agent conversation loaded the new version. Some hosts require a new conversation to discover updated Skills.

## Prepare Cloudflare authority

```text
Use $cfkanban-deploy to inspect the available Cloudflare authentication and target account.
If a new sign-in is necessary, show its method, permissions, and local effects before asking me to approve it.
```

The Agent first reuses the verified maintenance record or current Wrangler authentication context. You choose among ambiguous accounts; it does not enumerate unrelated profiles to guess an identity. An application Owner Credential is not Cloudflare authority.

When browser authentication is needed, the Agent discloses the exact permissions, profile operation, and possible system-keyring effects. Remote environments with unreachable browser callbacks need a supported authentication path. A failure does not authorize switching browsers or broadening permissions. Do not paste Cloudflare Tokens, Owner Credentials, or OAuth results into chat.

**In the browser:** Review the account and permissions on Cloudflare's official sign-in and consent pages. After successful login, the Agent still verifies the exact account. Sign-in alone creates no Worker, D1, or board.

## Common questions

**Only joining someone else's Project?** Use [Join and sign in](../usage/access.md), without a personal Cloudflare account or deployment.

**Must I reinstall an existing plugin?** Trusted compatible installations can be reused. The Agent checks provenance, canonical installation, and host loading instead of forcing an update for daily work.

**Do I need optional Cloudflare Skills?** They can help with platform questions but are not cfKanban dependencies. They do not replace release and plan verification and are not installed automatically during deployment.
