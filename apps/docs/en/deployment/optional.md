# Domains, attachments, metrics, and request limits

Enable these features when needed. Ask the Agent to explain resource, cost, and permission effects before deciding to proceed.

## Custom domains

```text
Use $cfkanban-deploy to check how <instance address> can use <target domain>.
Explain the domain setup, effects, and verification steps without changing anything yet.
```

You need the relevant Cloudflare and domain authority. The default site uses `workers.dev`. Adding or moving a domain requires separate planning and is not part of an ordinary upgrade.

The Skill and public CLI already support automated `deploy public-access inspect`, `plan`, and `apply` workflows. For an approved new Worker custom domain, Cloudflare manages its DNS and certificate provisioning. A separate optional WAF plan creates the instance's own custom rule for the exact hostname; it is not a Cloudflare Managed Rules configuration.

**In the Web UI:** The domain and protection details in **Administration → Usage & limits** read current Zone/custom-rule state on demand with verified authorization. Domain and WAF writes still use the deployment plan. The domain plan verifies the same instance, preferred origin, and safe local rebind before disabling business access through `workers.dev` and previews. Zone rules do not protect `workers.dev`, so closing alternate entry points is an explicit effect of that plan. Passkeys are bound to their domain, so arrange an available Owner recovery method before moving. Changing an application address alone does not migrate a domain. Domain operations do not silently redeploy the Worker; the declaration updates with the next authorized deployment.

No deployment-tool configuration record does not mean there is no custom domain or WAF. Legacy or manually configured domains can work normally; ordinary upgrades preserve them without taking ownership or installing new rules. WAF is not required to use a custom domain. Inspect existing protection by selecting the domain's Zone in Cloudflare and opening **Security → WAF**. Before tool-managed changes, ask the Agent to inspect the current mapping and rules read-only and agree on an explicit connection plan for an existing domain without an ownership receipt. Keep that domain in place: do not delete and recreate it to satisfy the new-domain workflow. Rerunning domain installation does not take over legacy resources.

WAF is a separate opt-in and can be disabled independently. The Free profile manages only its own custom rule for this instance hostname, preserves other rules, and never upgrades a paid plan. Free rate rules cannot constrain hostname, so no counting rule is installed across a shared Zone. Insufficient rule slots stop the plan with an explanation. Normal Agent APIs, login, invitations, and recovery remain accessible. Turnstile and Bot Fight Mode are not enabled in this scope.

## Enable attachments

```text
Use $cfkanban-deploy to prepare attachment storage for <instance address>.
Explain the Cloudflare R2 subscription, permissions, and possible charges without enabling or deploying anything yet.
```

Attachments use private Cloudflare R2 storage and require extra subscription and permission checks. After plan approval and deployment, the Owner must choose [attachment capacity](../administration/settings.md) under **Administration → Usage & limits → Set limit** before uploads can begin.

Each file can be up to 10 MiB, with at most 20 active attachments per issue. Unlimited total capacity does not remove these limits. Deleting a file does not immediately release storage capacity.

## View Cloudflare usage

```text
Use $cfkanban-deploy to check how to enable Cloudflare usage metrics for this instance.
Explain the permissions and safe setup steps without changing anything yet.
```

Metrics are optional; leaving them unconfigured does not prevent task collaboration. The unified connection needs read-only analytics permissions. The deployment Skill does not write the secret automatically. The Owner saves one Token in **Administration → Overview**; the API stores it as a Worker Secret and verifies configuration and analytics separately. Do not paste Tokens into chat or ask the Agent to print them.

**In the Web UI:** **Administration → Usage & limits** shows status and lets you refresh data; Overview keeps only a short summary. Observations may be delayed and are neither a real-time bill nor your account's remaining allowance.

A deployment plan can select the exact Worker, Free/Paid basis, verified UTC billing cycle day, warning threshold, and explicitly enabled account totals. The Owner usage page also supports a reviewed plan for the statistics switches, Free/Paid declaration, cycle day, account totals, and reminder threshold. It derives account, Worker, and database from fixed deployment targets; these cannot be redirected by the form. Without a verified cycle, monthly values stay unknown rather than assuming a calendar month. Workers requests and cumulative CPU, D1 daily/cycle rows, and R2 Class A/B operations remain distinct; unknown or truncated operations do not appear as complete billable totals. R2 free allowances apply only to Standard storage. Allowance comparisons require the Owner to verify that the entire instance or account measurement scope is Standard-only.

Daily history is a separate opt-in, disabled by default. The **Daily usage history** section offers 7/30/90 complete UTC days with nulls and missing dates preserved as gaps. Enabling it requires a configuration plan and apply; it preserves account-total and plan choices. Collection reuses an existing maintenance trigger, with no added default Cron. An Owner can manually collect one of the last seven complete UTC days if needed. Capacity points retain actual observation times and are not daily consumption or GB-month billing.

### Cloudflare analytics configuration and budget alerts

The billing cycle aligns with [Cloudflare Billable Usage](https://developers.cloudflare.com/billing/manage/billable-usage/), not a separate cfKanban cycle or an assumed calendar month. In Cloudflare **Billing → Billable Usage**, verify the actual window and the Workers/D1 plan. Free daily allowances use the UTC day; monthly metrics need the correct cycle. An R2 storage observation is not GB-month billable usage.

Inspect or edit non-secret analytics settings under **Workers & Pages → the target Worker → Settings → Variables and Secrets**, then deploy to apply them. Alternatively, a deployment tool supporting these fields can prepare a `usageAnalytics` plan for verification and publication. Viewing existing daily metrics requires no reinstall, service activation, or configuration change.

| Variable | Meaning |
| --- | --- |
| `USAGE_BILLING_PLAN` | Verified Workers/D1 plan: `free` or `paid`; leave unknown when unverified |
| `USAGE_BILLING_CYCLE_DAY` | Actual Cloudflare billing start day in UTC, 1–31; shorter months use their last day |
| `USAGE_WORKER_NAME` | This instance's exact Worker name for optional Workers metrics |
| `USAGE_WARNING_PERCENT` | cfKanban usage reminder threshold, 1–100; default 80 |
| `USAGE_ACCOUNT_TOTALS_ENABLED` | Explicitly opt in with `true`; disabled by default |
| `USAGE_R2_STANDARD_ONLY_SCOPE` | `unknown`, `instance`, or `account`; declare only after verifying the entire measured scope is Standard |

The panel derives usage reminders from fresh snapshots without sending emails or adding frequent collection. `USAGE_WARNING_PERCENT` compares usage contribution with shared allowances; it is not a USD spending budget or remaining quota.

Cloudflare **Billing → Billable Usage → Budget alerts** separately notifies selected email recipients when cumulative usage-based account charges exceed a USD budget threshold. The public API contract has not confirmed the USD fields or budget editing operation, so cfKanban reports this limitation and links to the official dashboard. With verified Notifications authorization, it reads policy names, enabled states, alert types, and email recipients for the Owner; it does not interpret generic filters such as `limit` as a USD amount. A read denial does not mean no budget policy is configured. View and manage USD budgets in [Cloudflare Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/); alerts do not stop usage or cap charges. The application attachment budget remains separate.

### Cloudflare connection Token permissions

For a new deployment, prepare only the minimum permissions for optional capabilities you selected; default deployment does not request every billing or security permission. An ordinary upgrade preserves the existing authorization and supported live settings. Older instances need an approved upgrade to inject the fixed control account, Worker, and database targets. Before enabling an additional capability, identify its targets and missing permissions, then agree on the minimum additional authorization. Tools do not create Tokens, automatically grant permissions, or create a Global API Key.

Wrangler OAuth login does not create an API key or automatically add Billing, Notifications, or Zone WAF authorization to the Web controls. Do not use a Global API Key or export deployment OAuth credentials. The Web connection remains separate from the Wrangler deployment identity.

Enter one API Token in the authenticated **Administration → Overview → Cloudflare connection** form on the current HTTPS instance. This dedicated form is the supported secret transport; generic CLI/Agent JSON operations do not accept Cloudflare Tokens. Never send them to chat or store them in browser storage, the repository, command arguments, shell environment variables, or plaintext Worker variables. Account, Worker, and database are fixed deployment targets. Set the relevant Zone under **Usage and limits → Domain and access protection**.

Open [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens), choose the exact Account shown on the page, and follow **Manage Account → Account API Tokens → Create Token**. Creating an [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) requires account Super Administrator or API Token Provisioning authority. This is the creator's authority; the connection Token does not need **API Tokens Write** or other Token-management permissions.

Add the following permissions to the same Token. The page's **Create a Token and check permissions** guide shows the current Worker and target Account next to the corresponding selections.

#### Required permissions

| Scope | Cloudflare selection | Use |
| --- | --- | --- |
| **Specified Workers** → select the current existing Worker shown on the page | **Developer Platform → Individual Workers → Editor** | Save the connection and change request-rate or usage settings. Editor also grants this Worker's code, deployment, Secret, and configuration modification authority. Do not select account-wide **Workers Editor** or **Admin**. |
| Target Account shown on the page only | **Analytics & Logs → Account Analytics → Read** | Read Workers, D1, and R2 usage; no D1 SQL or R2 object editing permissions are required. Actual datasets are verified through usage reads. |

#### Optional read permissions

| Scope | Cloudflare selection | Use |
| --- | --- | --- |
| Target Account only | **Account & Billing → Billing → Read** | Read billing and plan information. |
| Target Account only | **Account & Billing → Notifications → Read** | Read existing notification policies. Account-owned Token compatibility requires an actual read check. |
| Specified Zone for the current domain only | **DNS & Zones → Zone → Read** | Verify the selected Zone belongs to the target Account and domain. |
| The same specified Zone for the current domain | **App Security → Zone WAF Rules → Read** | Read existing Zone WAF rules. Select **Zone WAF Rules**, not Account WAF. |

Optional capabilities require no Edit permissions. The Owner usage page reads notification and WAF data on demand. Missing optional permissions or unsupported Token compatibility affect only the corresponding capability; other verified capabilities remain available. A Token or a permission selection alone does not prove an endpoint or budget-policy type is available.

The [Workers permission guide](https://developers.cloudflare.com/workers/authorization/workers/) explains Editor scoped to one Worker, and the [analytics guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/) documents Account Analytics Read. Do not broaden account-wide editing privileges to clear a status warning. Domain and WAF writes retain the separate deployment plan workflow, including its Worker routing, Zone, DNS, and rule-edit requirements.

Choose **Save connection** to write the Token once to `CFKANBAN_API_TOKEN`, an ordinary encrypted [Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/), supported on Free without Secrets Store. Initial setup and rotation both use the entered Token to save itself, so expired old authorization does not block a valid replacement. The input clears after submission, including failure, without a restored draft. Once readback and capabilities are verified, the Owner can use another device without entering it again.

The unified authorization takes precedence. Instances without it continue to use the legacy `CFKANBAN_CONFIGURATION_TOKEN`, `CFKANBAN_CONTROL_TOKEN`, and `USAGE_ANALYTICS_TOKEN` for their original purposes. Saving the unified Token does not delete them; upgrades preserve live settings and both unified and legacy Secrets. An existing read-only analytics Token cannot write Worker settings; select or create replacement authorization scoped to this Worker's Editor capability.

Secret presence alone does not prove deployment or capability success. **Pending** and **Unknown** require **Verify current state**, without blindly repeating a save or apply. Verify replacement authorization before revoking the old Token; use the deployment recovery flow if the instance is unavailable. The API verifies required capabilities and target bindings but cannot prove the Token has no additional permissions. Cloudflare's official Worker Secret input remains a platform configuration route; saving/deploying it applies a Worker configuration change.

Worker configuration changes, including `USAGE_*` variables, Secrets, rate-limit bindings, and CPU limits, require a Worker version deployment to take effect. Changing a WAF rule or Budget Alerts policy in the provider control plane does not itself require redeploying the Worker; read back the provider state after saving. D1-backed application settings need no Worker redeployment after a successful save. Subsequent requests follow the relevant read and cache rules, and the page may need refreshing; see [Instance settings](../administration/settings.md).

## Adjust request-rate limits

```text
Use $cfkanban-deploy to investigate too-many-requests errors at <instance address>.
Given <time and symptoms>, assess whether limits need changing. Do not deploy yet.
```

The Owner can view and adjust supported limits in **Overview → Request-rate limits**, after verifying configuration authorization in the same page's Cloudflare connection. Request-rate limits differ from [public project membership and content quotas](../administration/public-join.md); throttling does not necessarily mean a project is full.

**Where to change them:** Worker **Settings → Variables and Secrets** shows `RATE_LIMIT_*_LIMIT` and `RATE_LIMIT_*_PERIOD_SECONDS`, but these variables only supply display values and error information. Enforcement uses `simple.limit` / `simple.period` in `ratelimits` bindings; [Cloudflare Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are not shown in the Dashboard. The deployment tool must update both together and verify the readback. Do not edit only the variables. Per-principal / per-isolate query concurrency limits are fixed in service code.

The Owner page supports instance API, single identity, unauthenticated sensitive actions, anonymous login, and counts/title search. Enter a positive integer and a 10- or 60-second window, preview the plan, review before/after values, then apply. The service preserves other settings and updates the matching binding and display variables together. It rejects deployment drift and pending operations; an unknown result needs verification, not automatic replay. This form does not edit CPU limits or query concurrency.

New deployments also protect anonymous login and counts/title search, with concurrency limits for expensive queries. Clients honor Retry-After and backoff; do not evade limits by switching identities, repeatedly retrying, or replaying writes automatically. Platform throttles are best-effort per PoP, not an account billing cap. A Paid CPU limit must be selected and verified in a plan; it never purchases or upgrades the subscription.

Upgrades should preserve existing optional settings. Disabling a feature does not automatically delete cloud resources or stop their charges.
