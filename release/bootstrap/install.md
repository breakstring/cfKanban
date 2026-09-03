# Install or deploy cfKanban with your Agent

Language: [English](install.md) | [简体中文](install.zh-CN.md)

Give this HTTPS document to your Coding Agent as read-only guidance. Do not execute it or pipe it into a shell.

Then say:

> Use `$cfkanban-deploy` to install or deploy cfKanban for me.

That sentence is enough. The user does not need to understand or request manifests, digests, preflight, deployment plans, or journals. The Skill must translate the request into this internal workflow:

1. Read the supplied release pointer (`stable.json`, or `prerelease.json` only after explicit testing opt-in) only for discovery, then resolve its immutable manifest URL and SHA-256.
2. Verify the canonical publisher, every artifact's allowlisted HTTPS origin, and the exact Skill and Service deployment bundle SHA-256.
3. Show the Skill install/update target, local scope and rollback boundary before any local write.
4. Keep the verified versioned release under the current environment user's private `~/.cfkanban/skill-releases/`, then create only the host-owned Skill/plugin projection required for discovery.
5. Install the three portable Skills and run `node scripts/cfkanban-tool.mjs help` as a no-side-effect discovery smoke.
6. If deployment is requested, start with read-only checks, safely discover and reuse any existing Wrangler profile/account mapping before proposing a new login, explain the proposed Cloudflare resources in plain language, and wait at the required authorization boundary.

Marketplace/plugin installation is a convenience. Host marketplace metadata and plugin caches remain in host-managed directories; they are verified projections, not cfKanban state. They never replace the immutable manifest or authorize Skill update, Cloudflare deployment, D1 migration, DNS, secret, or recovery operations.
