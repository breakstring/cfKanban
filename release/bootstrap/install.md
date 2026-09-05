# cfKanban installation bootstrap for Agents

Language: [English](install.md) | [简体中文](install.zh-CN.md)

This document addresses you, the Agent receiving a cfKanban installation or deployment request. Continue from the supplied user intent; do not ask the user to relay another prompt to an Agent. Treat the HTTPS document as read-only text, never as a script to execute or pipe into a shell. Reading it authorizes no local or cloud writes.

Inspect existing Skills first and reuse a compatible, verified installation. Ask only for missing choices or required authorization. Translate the user's requested outcome into the following workflow; do not require the user to supply manifest, digest, preflight, plan, or journal terminology:

1. Read the supplied release pointer (`stable.json`, or `prerelease.json` only after explicit testing opt-in) only for discovery, then resolve its immutable manifest URL and SHA-256.
2. Verify the canonical publisher, every artifact's allowlisted HTTPS origin, and the exact Skill and Service deployment bundle SHA-256.
3. Show the Skill install/update source, version, target, local scope and rollback boundary, and obtain authorization before any local write.
4. Keep the verified versioned release under the current environment user's private `~/.cfkanban/skill-releases/`, then create only the host-owned Skill/plugin projection required for discovery.
5. Read each installed `SKILL.md` and run `node scripts/cfkanban-tool.mjs help` from each of the three Skill directories as a no-side-effect discovery smoke. Check the host's Skill discovery; if it requires a new task, report that precise handoff rather than claiming the Skill is already loaded.
6. If deployment is requested, start with read-only checks. Reuse a journal/receipt's exact Wrangler target, or let Wrangler resolve environment authentication and the current private deployment/config context without listing profiles. Inspect a named profile only when the user explicitly supplies it. Pin the chosen `account_id` in the private config, explain the proposed Cloudflare resources in plain language, and wait at the required authorization boundary.

Marketplace/plugin installation is a convenience. Host marketplace metadata and plugin caches remain in host-managed directories; they are verified projections, not cfKanban state. They never replace the immutable manifest or authorize Skill update, Cloudflare deployment, D1 migration, DNS, secret, or recovery operations.
