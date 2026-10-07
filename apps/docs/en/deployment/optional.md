# Domains, attachments, metrics, and request limits

Enable these features when needed. Ask the Agent to explain resource, cost, and permission effects before deciding to proceed.

## Custom domains

```text
Use $cfkanban-deploy to check how <instance address> can use <target domain>.
Explain the domain setup, effects, and verification steps without changing anything yet.
```

You need the relevant Cloudflare and domain authority. The default site uses `workers.dev`. Adding or moving a domain requires separate planning and is not part of an ordinary upgrade.

The Skill and public CLI already support automated `deploy public-access inspect`, `plan`, and `apply` workflows. For an approved new Worker custom domain, Cloudflare manages its DNS and certificate provisioning. A separate optional WAF plan creates the instance's own custom rule for the exact hostname; it is not a Cloudflare Managed Rules configuration.

**In the Web UI:** **Administration → Usage & limits → Domain & access protection** shows the last deployment's declaration and an Agent guide. **Administration → Cloudflare connection** separately reads current Zone/custom-rule state with verified authorization. Domain and WAF writes still use the deployment plan. The domain plan verifies the same instance, preferred origin, and safe local rebind before disabling business access through `workers.dev` and previews. Zone rules do not protect `workers.dev`, so closing alternate entry points is an explicit effect of that plan. Passkeys are bound to their domain, so arrange an available Owner recovery method before moving. Changing an application address alone does not migrate a domain. Domain operations do not silently redeploy the Worker; the declaration updates with the next authorized deployment.

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

Metrics are optional; leaving them unconfigured does not prevent task collaboration. Setup needs additional read-only analytics authorization. The deployment Skill does not write the analytics secret automatically. After configuration authorization is verified, the Owner can save the analytics Token under **Administration → Cloudflare connection**; the API stores it as a Worker Secret. Do not paste Tokens into chat or ask the Agent to print them.

**In the Web UI:** **Administration → Usage & limits** shows status and lets you refresh data; Overview keeps only a short summary. Observations may be delayed and are neither a real-time bill nor your account's remaining allowance.

A deployment plan can select the exact Worker, Free/Paid basis, verified UTC billing cycle day, warning threshold, and explicitly enabled account totals. The Owner connection page also supports a reviewed plan for the statistics switches, Free/Paid declaration, cycle day, account totals, and reminder threshold. It derives account, Worker, and database from fixed deployment targets; these cannot be redirected by the form. Without a verified cycle, monthly values stay unknown rather than assuming a calendar month. Workers requests and cumulative CPU, D1 daily/cycle rows, and R2 Class A/B operations remain distinct; unknown or truncated operations do not appear as complete billable totals. R2 free allowances apply only to Standard storage. Allowance comparisons require the Owner to verify that the entire instance or account measurement scope is Standard-only.

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

### Optional control-plane permissions

For a new deployment, prepare only the minimum permissions for optional capabilities you selected; default deployment does not request every billing or security permission. An ordinary upgrade preserves the existing authorization and supported live settings. Older instances need an approved upgrade to inject the fixed control account, Worker, and database targets. Before enabling an additional capability, identify its targets and missing permissions, then agree on the minimum additional authorization. Tools do not create Tokens, automatically grant permissions, or create a Global API Key.

Use an API Token restricted to the exact account or Zone, with permissions selected for the requested operation:

| Optional operation | Restricted permission |
| --- | --- |
| Read account billing data | Account **Billing Read** |
| Read notification policies | Account **Notifications Read** |
| Verify Zone ownership | Zone **Zone Read** for the selected Zone |
| Inspect Zone WAF rules | Zone **Zone WAF Read** |
| Read analytics | Account **Account Analytics Read**, restricted to the current Account |

The Owner connection page only reads notification and WAF policy data; it does not require Notifications Edit or Zone WAF Edit. Domain/WAF write plans retain their separate Worker routing, Zone, DNS, and rule-edit requirements. Verify actual provider responses; a Token or a permission selection alone does not prove an endpoint or budget-policy type is available.

Wrangler OAuth login does not create an API key. The project's current OAuth login scopes do not cover Billing, Notifications, or Zone WAF; logging in again does not add these permissions. Do not use a Global API Key or export deployment OAuth credentials. The existing `USAGE_ANALYTICS_TOKEN` authorization is not automatically reused for control purposes; a compatible value can be saved for another purpose only after that purpose's capability check. Analytics collection and deployment authentication retain separate purposes.

Use the authenticated Owner page on the current HTTPS instance for Token input. This dedicated form is the supported secret transport; generic CLI/Agent JSON operations do not accept Cloudflare Tokens. Never send them to chat or store them in browser storage, the repository, command arguments, shell environment variables, or plaintext Worker variables. The account, Worker, and database are read-only deployment targets; only the relevant Zone selection can be saved on this page.

Configuration, feature, and analytics are separate authorization purposes. A compatible Token can serve multiple purposes, each verified separately; it is still saved in each purpose's own Secret. Tokens are stored long-term only in encrypted ordinary [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/). The feature Token uses the minimum read permissions above; the analytics Token uses [Account → Account Analytics → Read](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/), scoped only to the displayed Account. Saving first verifies the D1 analytics interface; availability of other configured datasets is established by subsequent usage reads, rather than the permission label alone. The configuration Token must be account-owned and restricted to **Editor for this Worker only**, including code and deployment authority, rather than account-wide Workers Editor or Admin. Ordinary Worker Secrets support Free without Secrets Store. These Tokens remain separate from the Wrangler OAuth deployment identity; the analytics Secret remains `USAGE_ANALYTICS_TOKEN`.

For the configuration Token, open [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens), select the displayed Account, then follow **Manage Account → Account API Tokens → Create Token → Specified Workers → this existing Worker → Editor**. The person creating an [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) needs account Super Administrator or API Token Provisioning authority; do not add Token-management permissions to the business Token. Cloudflare lists Editor for the selected Worker as the minimum role for managing its Secrets in [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/). Open **Administration → Cloudflare connection**, enter this Token, and choose **Save and apply configuration**. First setup uses the entered Token to save itself as a Worker Secret; subsequent Token saves use the stored configuration Token. Inputs clear after submission, including failure, and are never restored as drafts. After verified setup, an Owner can sign in from another device and use the supported controls without importing Tokens again.

For feature reads, use [My Profile → API Tokens → Create Token → Create Custom Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/). Restrict Account Resources to the displayed Account; add WAF read permissions only after identifying the exact domain Zone and restrict Zone Resources to that Zone, never all Zones. The [permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) lists the read permission names above. For analytics, the [official guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/) starts at Account API Tokens → Create Token → Custom token. Configure and verify the Worker configuration Token first, then save each optional Token separately. Account-owned Notifications compatibility is not guaranteed; a read-only purpose may require a compatible user Token, while the configuration purpose must retain the account-owned single-Worker Editor scope.

A configured Secret does not itself prove deployment or capability success. **Verified** requires service readback; **Pending** and **Unknown** require **Verify current state**, without blindly repeating the save or apply. For rotation, verify the replacement before revoking the old Token. If the stored configuration Token is lost or expired, enter a valid replacement configuration Token; if the instance is unavailable, use the deployment recovery flow. The API verifies required capability and target bindings, but does not prove the Token has no additional permissions. Supported upgrades preserve live settings and all three Secrets. Cloudflare's official Worker Secret input remains a platform configuration route; saving/deploying it applies a Worker configuration change.

Worker configuration changes, including `USAGE_*` variables, Secrets, rate-limit bindings, and CPU limits, require a Worker version deployment to take effect. Changing a WAF rule or Budget Alerts policy in the provider control plane does not itself require redeploying the Worker; read back the provider state after saving. D1-backed application settings need no Worker redeployment after a successful save. Subsequent requests follow the relevant read and cache rules, and the page may need refreshing; see [Instance settings](../administration/settings.md).

## Adjust request-rate limits

```text
Use $cfkanban-deploy to investigate too-many-requests errors at <instance address>.
Given <time and symptoms>, assess whether limits need changing. Do not deploy yet.
```

The Owner can inspect limits under **Overview → Service information & access limits**, and prepare supported changes under **Cloudflare connection → Native request limits**. Request-rate limits differ from [public project membership and content quotas](../administration/public-join.md); throttling does not necessarily mean a project is full.

**Where to change them:** Worker **Settings → Variables and Secrets** shows `RATE_LIMIT_*_LIMIT` and `RATE_LIMIT_*_PERIOD_SECONDS`, but these variables only supply display values and error information. Enforcement uses `simple.limit` / `simple.period` in `ratelimits` bindings; [Cloudflare Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are not shown in the Dashboard. The deployment tool must update both together and verify the readback. Do not edit only the variables. Per-principal / per-isolate query concurrency limits are fixed in service code.

The Owner page supports instance API, single identity, unauthenticated sensitive actions, anonymous login, and counts/title search. Enter a positive integer and a 10- or 60-second window, preview the plan, review before/after values, then apply. The service preserves other settings and updates the matching binding and display variables together. It rejects deployment drift and pending operations; an unknown result needs verification, not automatic replay. This form does not edit CPU limits or query concurrency.

New deployments also protect anonymous login and counts/title search, with concurrency limits for expensive queries. Clients honor Retry-After and backoff; do not evade limits by switching identities, repeatedly retrying, or replaying writes automatically. Platform throttles are best-effort per PoP, not an account billing cap. A Paid CPU limit must be selected and verified in a plan; it never purchases or upgrades the subscription.

Upgrades should preserve existing optional settings. Disabling a feature does not automatically delete cloud resources or stop their charges.
