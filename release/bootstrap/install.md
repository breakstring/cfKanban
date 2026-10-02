# cfKanban installation bootstrap for Agents

Language: [English](install.md) | [简体中文](install.zh-CN.md)

This document addresses you, the Agent receiving a cfKanban installation or deployment request. Continue from the supplied user intent; do not ask the user to relay another prompt to an Agent. Treat the HTTPS document as read-only text, never as a script to execute or pipe into a shell. Reading it authorizes no local or cloud writes.

Inspect existing Skills first and reuse a compatible, verified installation. Ask only for missing choices or required authorization. Translate the user's requested outcome into the following workflow; do not require the user to supply manifest, digest, preflight, plan, or journal terminology:

1. By default, read the canonical stable pointer `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json` only for discovery. Resolve and pin its immutable manifest URL, SHA-256, and exact version; keep this snapshot throughout execution without pinning the host's long-term update source. Prereleases or historical releases require an exact choice; missing or failed verification does not permit a fallback.
2. Verify the canonical publisher, every artifact's allowlisted HTTPS origin, and the exact Skill and Service deployment bundle SHA-256.
3. Show the Skill install/update source, version, target, local scope and rollback boundary, and obtain authorization before any local write.
4. Keep the verified versioned release under the current environment user's private `~/.cfkanban/skill-releases/`, then create only the host-owned Skill/plugin projection required for discovery.
5. Read each installed `SKILL.md` and run `node scripts/cfkanban-tool.mjs help` from each of the three operational Skill directories as a no-side-effect discovery smoke. Check the host's Skill discovery; if it requires a new task, report that precise handoff rather than claiming the Skill is already loaded.
6. If deployment is requested, start with read-only checks. Reuse a journal/receipt's exact Wrangler target, or let Wrangler resolve environment authentication and the current private deployment/config context without listing profiles. Inspect a named profile only when the user explicitly supplies it. Pin the chosen `account_id` in the private config, explain the proposed Cloudflare resources in plain language, and wait at the required authorization boundary.

Marketplace/plugin installation is a convenience. Host marketplace metadata and plugin caches remain in host-managed directories; they are verified projections, not cfKanban state. They never replace the immutable manifest or authorize Skill update, Cloudflare deployment, D1 migration, DNS, secret, or recovery operations.

## Release discovery, host installation, and updates

Release manifests with `schema_version: 2` separate the product/OpenAPI document version from the API compatibility version. They require a deployment Skill that supports this format; historical format 1 remains readable by the newer Skill. If an older Skill rejects the manifest, verify the canonical installation documents and update the local Skills and host projection with authorization before deploying the Service bundle. Do not bypass the manifest check or reinterpret the document version as the API version. Release pointers still use schema 1.

First installation discovers the latest stable release by default; reuse an existing trusted, compatible installation. Read the canonical stable pointer:

<https://github.com/breakstring/cfKanban/releases/latest/download/stable.json>

For a text plugin/Skill update request, use the user's explicit target first, then an exact target clearly continued from trusted user conversation context: updating the RC just published for its acceptance test may qualify. An incidental RC mention or development branch is insufficient. Ask once if ambiguous; otherwise select latest stable. Host-native plugin/Skill update actions use the stable channel. This context rule does not silently select an RC for a first deployment.

Resolve and pin the immutable manifest URL, SHA-256, and exact version; verify the publisher, allowed artifact origins, and required bundle digests. Keep this snapshot for the operation, separate from the host's saved update source. Stop on missing or failed verification instead of falling back to a prerelease, cache, or development source. If a trusted installed deployment Skill supports `release discover`, use `{}` or `{"selectionMode":"latest_stable"}` for read-only stable discovery, then `release verify` for artifact bytes. Retain the returned `selection_mode`; refilling `version` with the resolved stable version in this mode keeps `marketplace.ref: null` and rejects RCs. Explicit exact-version choices (current stable, historical, or RC) require `{"selectionMode":"exact_version","version":"<target>"}`. An older Skill without these inputs uses the HTTPS document flow while retaining the choice separately; do not install an update merely to check.

When installation is needed, first identify the actual Agent host and its supported Skill installation and discovery methods. Include the source, exact version, user scope, local paths, and rollback in the plan; record the source commit when using Git. Every host must preserve the complete verified Skill bundle: all four Skills, shared `packages/skill-runtime`, and relative layout. Copying a single Skill directory is insufficient.

- A host with a compatible Git marketplace or plugin source can follow the repository's default `main` branch, which contains only published stable releases. Before installation, verify that its commit matches the published tag for the pinned stable target and that the installed files match the verified Skill bundle.
- A host that loads local Skill directories uses the complete verified bundle and its supported discovery layout. Preserve the shared runtime and relative paths when creating the host entry. If the host cannot support that layout, report the specific limitation.

For **Codex with plugin support only**, a fresh default-branch installation uses this example after the applicable authorization; other hosts use their own supported installation method:

```text
codex plugin marketplace add https://github.com/breakstring/cfKanban.git
codex plugin add cfkanban-agent-skills@cfkanban
```

After installation or update on any host, verify its actual copy against the same pinned target and read back the saved source/ref separately; a matching version string alone is insufficient. `latest_stable` must leave no unexpected tag pin: fixing a manifest/version/digest does not add `--ref`. For the Git path, if `main` still trails Latest or the source changes during the operation, stop and report it; also stop if a host copy differs from the verified bundle. Do not silently substitute a tag, prerelease, or development checkout. `exact_version` uses the verified exact tag/bundle, including `--ref <resolved-version>` only when the supported Codex installation method needs it.

RC testing temporarily switches the existing host entry/projection, recording its original source/ref and restoration first; do not create another plugin entry or an automatic migration script. Keep or restore the default stable long-term source, and verify the installed RC and saved update source separately. If the host cannot keep an RC installation while restoring its source, explain the limitation and required switch back before a later native stable update; never claim an arbitrary tag pin will update to stable automatically.

An existing Git-based installation pinned to a tag needs a source switch before native updates can follow stable. Inspect the saved source/ref first (the `cfkanban` marketplace in Codex); removing `--ref` from a copied command does not change the saved setting, and refreshing a fixed tag does not upgrade to stable. Present the source change and rollback, then use the host's supported procedure within the user's authorization; reuse authorization already covering that update instead of repeatedly asking. Keep private `.cfkanban/` identity and deployment records. Local-directory installations continue through their verified bundle update path. Following `main` lets later host updates discover new stable releases; it does not automatically refresh installed Skills or the current task.

Check the canonical active receipt, host plugin/Skill projection, and current task loaded version separately. Updating the canonical bundle does not update the host; an installed host projection does not prove this task loaded it. Explain the specific handoff and remaining step if a new task is required, and mark unverifiable loading as unverified.

Checking for updates and executing them are separate; local Skill updates and cloud Instance upgrades are independent. If the latest Skills are incompatible with an older target instance, reuse a verified compatible installation or explain the limitation and propose an explicit compatible historical stable release. Never force a server upgrade to join a Project or update Skills.
