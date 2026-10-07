# Domains, attachments, metrics, and request limits

Enable these features when needed. Ask the Agent to explain resource, cost, and permission effects before deciding to proceed.

## Custom domains

```text
Use $cfkanban-deploy to check how <instance address> can use <target domain>.
Explain the domain setup, effects, and verification steps without changing anything yet.
```

You need the relevant Cloudflare and domain authority. The default site uses `workers.dev`. Adding or moving a domain requires separate planning and is not part of an ordinary upgrade.

**In the Web UI:** **Overview → Usage & limits** shows the last deployment's domain and WAF declaration and an Agent guide; deployment tools inspect live cloud state. The domain plan verifies the same instance, preferred origin, and safe local rebind before disabling business access through `workers.dev` and previews. Passkeys are bound to their domain, so arrange an available Owner recovery method before moving. Changing an application address alone does not migrate a domain. Domain operations do not silently redeploy the Worker; the declaration updates with the next authorized deployment.

WAF is a separate opt-in and can be disabled independently. The Free profile manages only its own custom rule for this instance hostname, preserves other rules, and never upgrades a paid plan. Free rate rules cannot constrain hostname, so no counting rule is installed across a shared Zone. Insufficient rule slots stop the plan with an explanation. Normal Agent APIs, login, invitations, and recovery remain accessible. Turnstile and Bot Fight Mode are not enabled in this scope.

## Enable attachments

```text
Use $cfkanban-deploy to prepare attachment storage for <instance address>.
Explain the Cloudflare R2 subscription, permissions, and possible charges without enabling or deploying anything yet.
```

Attachments use private Cloudflare R2 storage and require extra subscription and permission checks. After plan approval and deployment, the Owner must choose [attachment capacity](../administration/settings.md) under **Administration → Overview → Usage & limits → Set limit** before uploads can begin.

Each file can be up to 10 MiB, with at most 20 active attachments per issue. Unlimited total capacity does not remove these limits. Deleting a file does not immediately release storage capacity.

## View Cloudflare usage

```text
Use $cfkanban-deploy to check how to enable Cloudflare usage metrics for this instance.
Explain the permissions and safe setup steps without changing anything yet.
```

Metrics are optional; leaving them unconfigured does not prevent task collaboration. Setup needs additional read-only analytics authorization. The deployment Skill does not write the analytics secret automatically; follow the Agent's guidance for a secure Cloudflare configuration entry. Do not paste tokens into chat or ask the Agent to print them.

**In the Web UI:** **Overview → Usage & limits** shows status and lets you refresh data. Observations may be delayed and are neither a real-time bill nor your account's remaining allowance.

A deployment plan can select the exact Worker, Free/Paid basis, verified UTC billing cycle day, warning threshold, and explicitly enabled account totals. Without a verified cycle, monthly values stay unknown rather than assuming a calendar month. Workers requests and cumulative CPU, D1 daily/cycle rows, and R2 Class A/B operations remain distinct; unknown or truncated operations do not appear as complete billable totals. R2 free allowances apply only to Standard storage. Allowance comparisons require the Owner to verify that the entire instance or account measurement scope is Standard-only.

The panel derives threshold warnings from fresh snapshots, without sending messages or adding frequent collection. The Owner can separately configure [Cloudflare Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) for billing email. Those alerts report account costs; they do not stop usage or cap the bill. The application attachment budget remains separate.

## Adjust request-rate limits

```text
Use $cfkanban-deploy to investigate too-many-requests errors at <instance address>.
Given <time and symptoms>, assess whether limits need changing. Do not deploy yet.
```

The Owner can inspect limits under **Overview → Service information & access limits**. Changing them needs Cloudflare deployment authority. Request-rate limits differ from [public project membership and content quotas](../administration/public-join.md); throttling does not necessarily mean a project is full.

New deployments also protect anonymous login and counts/title search, with concurrency limits for expensive queries. Clients honor Retry-After and backoff; do not evade limits by switching identities, repeatedly retrying, or replaying writes automatically. Platform throttles are best-effort per PoP, not an account billing cap. A Paid CPU limit must be selected and verified in a plan; it never purchases or upgrades the subscription.

Upgrades should preserve existing optional settings. Disabling a feature does not automatically delete cloud resources or stop their charges.
