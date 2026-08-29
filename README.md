# cfKanban

English | [简体中文](README.zh-CN.md)

A minimal, API-first Cloudflare Kanban system for coding agents. It is closer to a reliable work coordination ledger for agents than a traditional project management product with its UI removed.

> Current status: the product and foundational architecture contracts are Frozen, while the API and D1 Schema contract is still being refined as a Draft. The repository contains documentation only; there is no application code or authorized implementation plan yet.

## Product principles

- Agents are the default operators. Humans express goals and authorize important side effects; agents discover capabilities, make decisions, execute operations, recover from failures, and report results.
- Preserve the Kanban core: projects, issues, statuses, priorities, labels, comments, dependencies, and history.
- Run on Cloudflare's free tier by default. Paid services may enhance the product but must not become core dependencies.
- Prefer fewer components. The MVP starts with Workers and D1; KV, Durable Objects, AI, and other services require demonstrated value.
- Human-facing maintenance should be limited to credential management, soft-delete recovery, health checks, and auditing.

## Current product contract

- One deployment instance can contain multiple Workspaces, and one Workspace can contain multiple Projects.
- Each deployment instance has exactly one Deployment Owner. Only the Owner can create Workspaces and Projects, invite Principals to Projects, or change Project Grants.
- The Owner does not need Project Grants and implicitly has read/write access to every Project. Owner is a deployment-level identity, not a third Project role.
- There is no second administrator and no Owner transfer. Credential rotation or recovery cannot change the Owner Principal.
- Initial deployment reveals the bootstrap Credential only once. If all Owner Credentials are lost, only an operator who controls the Cloudflare deployment may reissue one for the same Owner Principal through a controlled, out-of-band Skill script.
- A Credential authenticates one Principal. A Principal may hold Grants for multiple Projects across multiple Workspaces.
- Non-Owner participants have only `reader` or `writer` per Project. Permissions do not inherit from Workspace; `writer` includes creating, editing, soft-deleting, and restoring Project content, with no separate delete role.
- A `writer` cannot delete or restore Workspace or Project containers; those operations remain Owner-only.
- A Project is a work-coordination namespace, not a repository mirror. One repository may relate to several Projects, and one Project may span several repositories.
- An Issue can have one human or agent Principal as assignee. Assignment identifies responsibility but creates neither a lock nor extra permission; other writers may continue collaborating.
- Blocking is orthogonal to workflow status. An Issue keeps its current stage while unresolved dependencies or a manual reason produce the `is_blocked` projection.
- The Owner invites participants with a copyable, short-lived, single-use Invite URL. Project Invites expire after seven days; Principal Recovery Invites expire after one hour. The recipient gives the URL to their agent, which reuses a local identity or creates a new Principal/Credential through the Skill and atomically redeems the specified Project Grants.
- The v0 workflow is fixed to `backlog / todo / in_progress / done / canceled`. A Project may override display names only, and only the Owner can change those names. The Owner or any Project `writer` may explicitly move or reopen an Issue among the fixed statuses using version/CAS and an Event record.
- An Issue may be assigned only to the Owner or an active `writer` of its Project. Losing eligibility preserves the historical assignee reference but projects `assignee_available=false` and `needs_reassignment=true` until someone explicitly reassigns it.
- Invitations are either ordinary Project Invites or Principal-bound Recovery Invites. Only the Owner may create them, and participants cannot issue additional Credentials for themselves.
- Completing an Issue atomically appends a structured, immutable, undeletable completion comment and moves the Issue to `done`. Reopening preserves previous completion records; completing again appends another record.
- v0 relations are fixed to `blocks / parent / related / duplicate`. They may cross Projects in the same Workspace but cannot cross Workspaces. Cross-Project writes require `writer` on both Projects, and relations never change status or permission automatically.
- v0 provides deterministic candidate listing plus explicit assign and assign-to-me operations; it does not initially provide atomic assign-next. An upstream agent may combine these atomic capabilities according to user intent and local rules.
- The v0 management surface is API + Agent Skills. It does not require a deployed maintenance website and does not publish a standalone cfKanban CLI. Codex, Claude Code, Workbuddy, and similar tools are all user agents; deployment, coordination, and coding are task modes rather than product roles.
- v0 provides an authorization-filtered deployment-wide Issue query across Workspaces and Projects. Project filters are optional at the API layer, but Skills strongly recommend explicit Project scopes when context is known.
- Project Grants do not expire. Each Principal/Project pair has one current record changed only by explicit Owner role change, revocation, or regrant. Invitations retain their own short expiry.
- Issue priority is fixed to `none / low / medium / high / urgent`, defaulting to `none`. v0 stores no manual rank; candidate ordering is priority followed by FIFO.
- Non-idempotent creates and commands require an `Idempotency-Key` retained for 24 hours. Structured errors expose stable `code`, `retryable`, and `recovery` fields.
- Standard Comments are append-only: they cannot be edited in place, but may be soft-deleted and restored. Corrections append a new Comment that references the earlier one. Completion comments remain immutable and undeletable.

Credentials and Project Grants do not expire automatically. They change only through explicit revocation, rotation/regrant, or Principal disablement. Invitations are the only authentication/authorization bootstrap capability with automatic expiry.

v0 uses bounded resource contracts: requests up to 128 KiB, Issue bodies up to 64 KiB, Comment/completion payloads up to 32 KiB, lists defaulting to 20 and capped at 100 items, and Agent context capped at 64 KiB. Large logs and attachments use external artifact references.

The Foundation SPEC and Agent Skills & Bootstrap SPEC are Frozen, defining the foundational domain/API semantics and the agent usage, distribution, deployment, and credential experience. Freezing does not authorize implementation. Exact HTTP/OpenAPI fields, D1 DDL, indexes, and atomic write recipes remain in the Draft API & D1 Schema SPEC. Long-term physical retention of soft-deleted data remains deferred; v0 exposes no hard-delete API and no complete D1 export, import, or full-database disaster-recovery capability.

## Documentation

- [Documentation index](docs/README.md)
- [Product brief](docs/product/product-brief.md)
- [User storyboard](docs/product/user-storyboard.md)
- [Foundation SPEC](docs/specs/2026-08-26-agent-native-kanban-foundation-spec.md)
- [Agent Skills & Bootstrap SPEC](docs/specs/2026-08-28-agent-skills-bootstrap-spec.md)
- [API & D1 Schema SPEC](docs/specs/2026-08-28-api-schema-spec.md)
- [Cloudflare architecture baseline](docs/architecture/cloudflare-baseline.md)
- [Cloudflare platform snapshot](docs/research/cloudflare-platform-snapshot-2026-08-28.md)
- [Agent Skill platform snapshot](docs/research/agent-skill-platform-snapshot-2026-08-28.md)
- [Roadmap](docs/project/roadmap.md)
- [Decision register](docs/project/decision-register.md)
- [Open questions](docs/project/open-questions.md)
- [Linear workflow](docs/project/linear.md)

## Project tracking

Linear project: [cfKanban](https://linear.app/kennzhang/project/cfkanban-567c4995296f).

Linear stores execution state; repository documents remain the source of truth for product and technical contracts. No implementation Issues are being bulk-created merely to populate the board.
