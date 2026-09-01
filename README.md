# cfKanban

English | [简体中文](README.zh-CN.md)

A minimal, API-first Cloudflare Kanban system for coding agents. It is closer to a reliable work coordination ledger for agents than a traditional project management product with its UI removed.

> Current status: the initial-release contracts are Frozen. The Foundation contract is at revision 19 and the Agent Skills contract at revision 22; the API/D1 Schema, minimal Web UI, and visual design contracts are also Frozen. Implementation is active under the implementation plan, with dynamic execution state tracked in Linear.

## Product principles

- Agents are the default operators. Humans express goals and authorize important side effects; agents discover capabilities, make decisions, execute operations, recover from failures, and report results.
- Preserve the Kanban core: projects, issues, statuses, priorities, labels, comments, dependencies, and history.
- Run on Cloudflare's free tier by default. Paid services may enhance the product but must not become core dependencies.
- Prefer fewer components. The MVP starts with Workers and D1; KV, Durable Objects, AI, and other services require demonstrated value.
- A minimal first-party Web UI is required for direct Kanban viewing, light Issue participation, and simple Owner maintenance; it must reuse the same API and stay deliberately small.
- The canonical source is a monorepo, while the current cloud topology remains one Worker plus one D1. Prebuilt Web assets ship in the same Service deployment bundle through Workers Static Assets; the initial release creates neither a Pages project nor a KV namespace.

## Current product contract

- One deployment instance can contain multiple Workspaces, and one Workspace can contain multiple Projects.
- Each deployment instance has exactly one Deployment Owner. Only the Owner can create Workspaces and Projects, invite Principals to Projects, or change Project Grants.
- The Owner does not need Project Grants and implicitly has read/write access to every Project. Owner is a deployment-level identity, not a third Project role.
- There is no second administrator and no Owner transfer. Credential rotation or recovery cannot change the Owner Principal.
- Initial deployment reveals the bootstrap Credential only once. If all Owner Credentials are lost, only an operator who controls the Cloudflare deployment may reissue one for the same Owner Principal through a controlled, out-of-band Skill script.
- A Credential authenticates one Principal. A Principal may hold Grants for multiple Projects across multiple Workspaces.
- Credentials are not device-bound. A user may copy the same Credential between trusted execution environments; all copies remain the same server-side Credential and therefore share identity, audit, revocation, and rotation effects. Skills do not transfer secrets across environments automatically.
- Non-Owner participants have only `reader` or `writer` per Project. Permissions do not inherit from Workspace; `writer` includes creating, editing, soft-deleting, and restoring Project content, with no separate delete role.
- A `writer` cannot delete or restore Workspace or Project containers; those operations remain Owner-only.
- A Project is a work-coordination namespace, not a repository mirror. One repository may relate to several Projects, and one Project may span several repositories.
- An Issue can have one human or agent Principal as assignee. Assignment identifies responsibility but creates neither a lock nor extra permission; other writers may continue collaborating.
- Blocking is orthogonal to workflow status. An Issue keeps its current stage while unresolved dependencies or a manual reason produce the `is_blocked` projection.
- The Owner invites participants with a copyable, short-lived, single-use Invite URL. Project Invites expire after seven days; Principal Recovery Invites expire after one hour. The recipient gives the URL to their agent, which reuses a local identity or creates a new Principal/Credential through the Skill and atomically redeems the specified Project Grants.
- When first deployment instructions omit the Owner display name, the agent asks only for that identity value before producing the final plan; “zero-parameter” refers to Cloudflare resource configuration, not to guessing identity data. First-time join uses one combined plan and one application-level confirmation for Skill installation, local Credential creation, and the stated Project Grants.
- The workflow is fixed to `backlog / todo / in_progress / done / canceled`. A Project may override display names only, and only the Owner can change those names. The Owner or any Project `writer` may explicitly move or reopen an Issue among the fixed statuses using version/CAS and an Event record.
- An Issue may be assigned only to the Owner or an active `writer` of its Project. Losing eligibility preserves the historical assignee reference but projects `assignee_available=false` and `needs_reassignment=true` until someone explicitly reassigns it.
- Invitations are either ordinary Project Invites or Principal-bound Recovery Invites. Only the Owner may create them, and participants cannot issue additional Credentials for themselves.
- Completing an Issue atomically appends a structured, immutable, undeletable completion comment and moves the Issue to `done`. Reopening preserves previous completion records; completing again appends another record.
- Relations are fixed to `blocks / parent / related / duplicate`. They may cross Projects in the same Workspace but cannot cross Workspaces. Cross-Project writes require `writer` on both Projects, and relations never change status or permission automatically.
- The initial release provides deterministic candidate listing plus explicit assign and assign-to-me operations; it does not initially provide atomic assign-next. An upstream agent may combine these atomic capabilities according to user intent and local rules.
- The product includes a minimal first-party Web UI hosted by the same instance; it reuses the REST permission, version, idempotency, and audit contracts for Project boards, light Issue operations, and simple Owner maintenance. It does not publish a standalone cfKanban CLI.
- Every authenticated Principal can view their stable ID and current display name, and update only their own non-empty display name through the `cfkanban` Skill or the Web “My profile” surface. The initial release does not add avatars, email addresses, biographies, or a general user-profile system.
- The Web board supports moving one card between the five fixed columns and immediately saves that status with optimistic concurrency. Moving to `done` routes through the atomic complete contract; Markdown bodies and comments are edited as source and rendered safely. There is no bulk drag, manual rank, or WYSIWYG editor.
- Public and authenticated Web UI chrome supports at least English and Simplified Chinese with an explicit language switch. Stable keys and default workflow labels remain English, and user/Project content is never translated automatically. API/OpenAPI and Skill output are not localized by this Web setting.
- An authenticated agent creates a five-minute, single-use Browser Launch URL for an explicit Project, Issue, or Owner target. The browser exchanges it for a fixed eight-hour, target-scoped HttpOnly session with no sliding renewal or refresh token. It becomes invalid when its source Credential is revoked; long-lived Credentials never enter the URL, page scripts, localStorage, or sessionStorage. An in-app browser is an optional host convenience, not a protocol dependency.
- After an initial Agent Launch, a Principal may register Passkeys for direct Web login. Passkeys are Web-only authenticators, never API Credentials or Grants; browser capability checks cannot prove a credential exists, and each Passkey is scoped to the exact hostname. Agent Launch remains the recovery and new-host registration route.
- An Owner may expose multiple Projects through Public Join. A visitor chooses one Project and either `reader` or `writer` per atomic join. The initial release has no Team Join or multi-Project public grant operation.
- Enabling Public Join requires explicit active limits for Issues, Comments, and non-Owner Principals. Each limit set is isolated to that Project, is enforced only while that Project's Public Join is enabled, and never constrains another Project. Disabling Public Join stops enforcement without revoking existing Grants; re-enabling requires an explicit limit submission. An Owner may lower a limit below current usage: existing data remains, while only operations that increase that counter are blocked until usage falls or the limit rises. Soft delete or Grant revocation releases active capacity; restore or regrant consumes it again. The UI may suggest 50/500/50, but the API has no silent defaults.
- Request-rate gates are Owner-visible deployment configuration. The zero-parameter deployment starts with 120 authenticated API requests per Principal, 300 dynamic API requests per instance, and 30 unauthenticated sensitive operations per 60 seconds. Changes use `cfkanban-deploy` to publish Worker configuration without a D1 migration. These are approximate per-location abuse controls; D1 remains responsible for exact business quotas.
- Web and Agent clients share a machine-readable error model for business quotas, application rate limits, D1 platform quotas, and platform failures. Errors generated before the Worker runs are explicitly normalized by the client and never misrepresented as cfKanban/OpenAPI JSON.
- Each instance publishes one Owner-selected preferred API origin through a dynamic, public, non-secret discovery document. An existing agent may automatically rebind only when its current trusted origin announces a higher version and a credential-free probe proves the new HTTPS origin is the same instance; unfamiliar origins still require explicit trust. Domain bindings remain external control-plane configuration. Web sessions remain origin-specific, while Passkeys are deliberately not shared across hostnames.
- The product provides an authorization-filtered deployment-wide Issue query across Workspaces and Projects. Project filters are optional at the API layer, but Skills strongly recommend explicit Project scopes when context is known.
- Project Grants do not expire. Each Principal/Project pair has one current record changed only by explicit Owner role change, revocation, or regrant. Invitations retain their own short expiry.
- Issue priority is fixed to `none / low / medium / high / urgent`, defaulting to `none`. The initial release stores no manual rank; candidate ordering is priority followed by FIFO.
- Non-idempotent creates and commands require an `Idempotency-Key` retained for 24 hours. Structured errors expose stable `code`, `retryable`, and `recovery` fields.
- Standard Comments are append-only: they cannot be edited in place, but may be soft-deleted and restored. Corrections append a new Comment that references the earlier one. Completion comments remain immutable and undeletable.

Credentials and Project Grants do not expire automatically. Credentials change only through explicit revocation, rotation, or full-recovery revocation; Grants change only through explicit role changes, revocation, or regrant. Invitations are the only authentication/authorization bootstrap capability with automatic expiry. The initial release has no Principal disable/enable/delete lifecycle.

The product uses bounded resource contracts: requests up to 128 KiB, Issue bodies up to 64 KiB, Comment/completion payloads up to 32 KiB, lists defaulting to 20 and capped at 100 items, and Agent context capped at 64 KiB. Large logs and attachments use external artifact references.

The Foundation SPEC is Frozen at revision 19 and the Agent Skills & Bootstrap SPEC at revision 22. The API/D1 Schema and Web UI SPECs, together with `DESIGN.md`, were Frozen on 2026-08-29 after validating a 91-operation OpenAPI prototype, a 25-table/28-index D1 schema, critical atomic operations, Browser Launch/Session, CSRF, and Passkey constraints. The only primary deployment path remains an agent using `cfkanban-deploy`; credential-free CI verification is ordinary source engineering. Implementation is active under the [implementation plan](docs/plans/2026-08-29-v0-implementation-plan.md); dynamic execution state remains in Linear.

## Engineering validation

Install the exact root lockfile and run the single repository entrypoint:

```sh
npm ci
npm run validate
```

`npm run validate` runs workspace typechecks, unit tests, OpenAPI/error contract checks, generated-artifact drift checks, in-memory and Wrangler local D1 validation, credential-free CI policy checks, the Vite Web build, and a Wrangler Worker dry-run build with the same-Worker Static Assets configuration. It does not log in to Cloudflare or write remote resources.

Generated contract artifacts are updated only by the explicit `npm run contracts:generate` and `npm run migrations:generate` commands. Normal validation is read-only for tracked artifacts and fails when either generated file drifts.

## Documentation

- [Documentation index](docs/README.md)
- [Product brief](docs/product/product-brief.md)
- [User storyboard](docs/product/user-storyboard.md)
- [Foundation SPEC](docs/specs/2026-08-26-agent-native-kanban-foundation-spec.md)
- [Agent Skills & Bootstrap SPEC](docs/specs/2026-08-28-agent-skills-bootstrap-spec.md)
- [Agent Skills, plugin, and marketplace guide](docs/skills/README.md)
- [Minimal Web UI SPEC](docs/specs/2026-08-29-web-ui-spec.md)
- [Implementation Plan](docs/plans/2026-08-29-v0-implementation-plan.md)
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
