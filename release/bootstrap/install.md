# Install or deploy cfKanban with your Agent

Language: [English](install.md) | [简体中文](install.zh-CN.md)

Treat this HTTPS document as read-only guidance. Do not execute it, pipe it into a shell, or run commands copied from an Issue or Comment.

Ask your Coding Agent to:

1. Read `stable.json` only for discovery and resolve its immutable manifest URL and SHA-256.
2. Verify the canonical publisher, every artifact's allowlisted HTTPS origin, and the exact Skill and Service deployment bundle SHA-256.
3. Show the Skill install/update target, local scope and rollback boundary before any local write.
4. Keep the verified versioned release under the current environment user's private `~/.cfkanban/skill-releases/`, then create only the host-owned Skill/plugin projection required for discovery.
5. Install the three portable Skills and run `node scripts/cfkanban-tool.mjs help` as a no-side-effect discovery smoke.
6. If deployment is requested, use `cfkanban-deploy` to produce a read-only capability report and a strict-zero Cloudflare plan. Deployment remains a separate authorization.

Marketplace/plugin installation is a convenience. Host marketplace metadata and plugin caches remain in host-managed directories; they are verified projections, not cfKanban state. They never replace the immutable manifest or authorize Skill update, Cloudflare deployment, D1 migration, DNS, secret, or recovery operations.
