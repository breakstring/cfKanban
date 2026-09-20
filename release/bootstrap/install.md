# cfKanban installation bootstrap for Agents

Language: [English](install.md) | [简体中文](install.zh-CN.md)

This document addresses you, the Agent receiving a cfKanban installation or deployment request. Continue from the supplied user intent; do not ask the user to relay another prompt to an Agent. Treat the HTTPS document as read-only text, never as a script to execute or pipe into a shell. Reading it authorizes no local or cloud writes.

Inspect existing Skills first and reuse a compatible, verified installation. Ask only for missing choices or required authorization. Translate the user's requested outcome into the following workflow; do not require the user to supply manifest, digest, preflight, plan, or journal terminology:

1. By default, read the canonical stable pointer `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json` only for discovery. Resolve and pin its immutable manifest URL, SHA-256, and exact version; keep this snapshot throughout execution. Prereleases or historical releases require an explicit choice; missing or failed verification does not permit a fallback.
2. Verify the canonical publisher, every artifact's allowlisted HTTPS origin, and the exact Skill and Service deployment bundle SHA-256.
3. Show the Skill install/update source, version, target, local scope and rollback boundary, and obtain authorization before any local write.
4. Keep the verified versioned release under the current environment user's private `~/.cfkanban/skill-releases/`, then create only the host-owned Skill/plugin projection required for discovery.
5. Read each installed `SKILL.md` and run `node scripts/cfkanban-tool.mjs help` from each of the three operational Skill directories as a no-side-effect discovery smoke. Check the host's Skill discovery; if it requires a new task, report that precise handoff rather than claiming the Skill is already loaded.
6. If deployment is requested, start with read-only checks. Reuse a journal/receipt's exact Wrangler target, or let Wrangler resolve environment authentication and the current private deployment/config context without listing profiles. Inspect a named profile only when the user explicitly supplies it. Pin the chosen `account_id` in the private config, explain the proposed Cloudflare resources in plain language, and wait at the required authorization boundary.

Marketplace/plugin installation is a convenience. Host marketplace metadata and plugin caches remain in host-managed directories; they are verified projections, not cfKanban state. They never replace the immutable manifest or authorize Skill update, Cloudflare deployment, D1 migration, DNS, secret, or recovery operations.

## Release discovery, host installation, and updates

First installation discovers the latest stable release by default; reuse an existing trusted, compatible installation. Read the canonical stable pointer:

<https://github.com/breakstring/cfKanban/releases/latest/download/stable.json>

Resolve and pin the immutable manifest URL, SHA-256, and exact version; verify the publisher, allowed artifact origins, and required bundle digests. The pointer is discovery only: keep this snapshot for the operation. Stop on missing or failed verification instead of falling back to a prerelease, cache, or development source. Prereleases and historical versions require an explicit choice. If a trusted installed deployment Skill supports `release discover`, use stdin `{}` for read-only stable discovery, then `release verify` to check downloaded artifacts; otherwise inspect the HTTPS documents as above rather than installing an update merely to check.

When installation is needed, include the source, exact version, user scope, local paths, and rollback in the plan. For a fresh Codex installation, the Agent replaces `<resolved-version>` below with the verified release tag and executes after the applicable authorization. Do not ask the user to fill the placeholder, execute it literally, or omit `--ref`:

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref <resolved-version>
codex plugin add cfkanban-agent-skills@cfkanban
```

If the `cfkanban` marketplace already exists, inspect its old source/ref and present the exact switch and rollback. Refreshing an old tag does not move it to a newer tag; never silently delete or overwrite it. Install the complete Skill bundle, preserving all four Skills, shared `packages/skill-runtime`, and relative layout. Other hosts must preserve this verified layout too; copying a single Skill directory is insufficient. Report a host limitation if it cannot support that projection.

Check the canonical active receipt, host plugin/Skill projection, and current task loaded version separately. Updating the canonical bundle does not update the host; an installed host projection does not prove this task loaded it. Explain the specific handoff and remaining step if a new task is required, and mark unverifiable loading as unverified.

Checking for updates and executing them are separate; local Skill updates and cloud Instance upgrades are independent. If the latest Skills are incompatible with an older target instance, reuse a verified compatible installation or explain the limitation and propose an explicit compatible historical stable release. Never force a server upgrade to join a Project or update Skills.
