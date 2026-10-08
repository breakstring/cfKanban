# Domains, attachments, metrics, and request limits

Enable these features when needed. Ask the Agent to explain resource, cost, and permission effects before deciding to proceed.

## Custom domains

```text
Use $cfkanban-deploy to check how <instance address> can use <target domain>.
Explain the domain setup, effects, and verification steps without changing anything yet.
```

You need the relevant Cloudflare and domain authority. The default site uses `workers.dev`. Adding or moving a domain requires a separate deployment plan and is not part of an ordinary upgrade. The Skill and public CLI support `deploy public-access inspect`, `plan`, and `apply`; Cloudflare manages DNS and certificate provisioning for an approved new Worker custom domain.

The plan verifies the same instance, preferred origin, and safe local connection before closing business access through `workers.dev` and previews. Passkeys are bound to their domain, so arrange an available Owner recovery method before moving. Changing the application's preferred address alone does not configure a domain. Domain operations do not silently redeploy the Worker; the declaration updates with the next authorized deployment. The Web **Overview → Service information** shows instance addresses.

WAF management has been removed from the Owner page and normal Agent/CLI setup. Upgrades preserve existing rules and ownership records; they do not install or delete rules. A legacy or manually configured custom domain can continue working without being recreated or taken over. An explicitly approved rollback of a tool-owned domain can remove only its verified, unchanged, tool-owned WAF rule under the original safety plan. It preserves the shared ruleset and other rules. Unknown earlier operations must be resolved from their original records before proceeding; missing records or similar rule names do not establish ownership.

## Enable attachments

```text
Use $cfkanban-deploy to prepare attachment storage for <instance address>.
Explain the Cloudflare R2 subscription, permissions, and possible charges without enabling or deploying anything yet.
```

Attachments use private Cloudflare R2 storage and require subscription and permission checks. After plan approval and deployment, the Owner chooses [attachment capacity](../administration/settings.md) under **Administration → Usage & quotas → Attachment storage limit** before uploads can begin.

Each file can be up to 10 MiB, with at most 20 active attachments per issue. Unlimited total capacity does not remove these limits. Deleting a file releases capacity only after cleanup succeeds.

## View Cloudflare usage

```text
Use $cfkanban-deploy to check the fixed Cloudflare targets and analytics configuration for this instance.
Explain anything missing and the safe setup steps without changing anything yet.
```

Metrics are optional; leaving them unconfigured does not prevent task collaboration. Open **Administration → Usage & quotas**, enter one Cloudflare API Token at the top, and choose **Save**. The page confirms the save, checks capabilities, and loads each section automatically. Overview contains a usage summary and a link to this page.

The page shows today's UTC usage, daily history, attachment capacity, then request frequency. Workers requests and CPU, D1 rows, and R2 operations use their actual measurement windows. Billing-cycle totals and exact observation times are in **Data details**. Observations may be delayed and are neither a real-time bill nor the account's remaining allowance. Unknown values are not zero; observed storage is not daily consumption or GB-month billing.

Daily history starts disabled. Enable it explicitly from its setting on this page and confirm the change. It offers 7/30/90 complete UTC days, excluding today, and preserves gaps. Enabled collection reuses an existing maintenance trigger without adding a default Cron. On entering or returning to the page, the app may collect at most one missing day among the last seven complete UTC days, subject to a 60-second cooldown. It does not continually backfill history. If the response is lost, it reads the result without resubmitting the collection. An Agent can still request one eligible day explicitly.

### Analytics settings

Open the relevant setting in **Data details** to edit it in place. Review the before/after values and confirm. The account, database, and Worker come from fixed deployment targets; the form cannot redirect them. Existing `USAGE_*` targets remain compatible when they match the instance, and absent targets use the fixed deployment values. An explicit `USAGE_ANALYTICS_ENABLED=false` remains off.

**Cloudflare plan** and **billing cycle** describe the Cloudflare configuration you verified, not a cfKanban subscription. Verify the actual window in [Cloudflare Billable Usage](https://developers.cloudflare.com/billing/manage/billable-usage/). Without a verified cycle, monthly totals stay unknown; actual daily metrics can still load. Account totals require a separate opt-in. R2 allowance comparisons also require verification that the entire measured scope uses Standard storage.

For deployment or recovery, these non-secret variables remain available under **Workers & Pages → the target Worker → Settings → Variables and Secrets**, followed by Deploy:

| Variable | Meaning |
| --- | --- |
| `USAGE_ANALYTICS_ENABLED` | Set `false` to disable analytics explicitly |
| `USAGE_HISTORY_ENABLED` | Set `true` only when daily history has been enabled |
| `USAGE_BILLING_PLAN` | Verified Workers/D1 plan: `free` or `paid`; unknown if unverified |
| `USAGE_BILLING_CYCLE_DAY` | Actual UTC billing start day, 1–31; shorter months use their last day |
| `USAGE_WORKER_NAME` | This instance's exact Worker; defaults to the fixed deployment target |
| `USAGE_ACCOUNT_TOTALS_ENABLED` | Explicitly opt in with `true`; off by default |
| `USAGE_R2_STANDARD_ONLY_SCOPE` | `unknown`, `instance`, or `account`, based on verified Standard-only scope |

Budget notifications and notification-policy reads are no longer part of cfKanban. Existing `USAGE_WARNING_PERCENT` values are preserved for compatibility but do not produce reminders. Attachment storage limits remain available independently.

### Save a Cloudflare Token

Use the dedicated form on the current HTTPS instance. Never paste Tokens into chat or store them in browser storage, the repository, command arguments, shell environment variables, or plaintext Worker variables. Generic Agent/CLI JSON operations do not accept Cloudflare Tokens. Wrangler OAuth remains a separate deployment identity; do not export it or use a Global API Key for this form.

Open [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens), choose the exact Account shown on the page, then **Manage Account → Account API Tokens → Create Token**. Creating an [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) requires Super Administrator or API Token Provisioning authority. The resulting connection Token does not need Token-management permissions.

| Scope | Cloudflare selection | Use |
| --- | --- | --- |
| **Specified Workers** → the current existing Worker shown on the page | **Developer Platform → Individual Workers → Editor** | Save the Token and change usage settings or request frequency. Editor also grants this Worker's code, deployment, Secret, and configuration modification authority. |
| Only the displayed Account | **Analytics & Logs → Account Analytics → Read** | Read usage; no D1 SQL or R2 object editing permission is needed. Actual datasets are checked through reads. |

Do not select account-wide Workers Editor or Admin to clear a warning. Normal setup does not require Billing, Notifications, Zone, or WAF permissions. Domain changes and legacy rule cleanup retain their separate, explicit deployment permissions. See the [Workers permission guide](https://developers.cloudflare.com/workers/authorization/workers/) and [analytics permission guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).

Choose **Save** to store the Token in the encrypted [Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/) `CFKANBAN_API_TOKEN`, supported on Free without Secrets Store. Initial setup and replacement use the newly entered Token to save itself, so an expired or read-only old Token does not block a valid replacement. The form clears after submission and does not restore a Token draft. A persistent **Token saved** status distinguishes an existing saved value from the empty input. Entering a new Token replaces it; leaving the input blank keeps it.

Configuration and analytics are checked independently and automatically. A saved Token can remain saved while one capability is unavailable. Status includes text as well as an icon; permission paths and evidence boundaries are in details. A configuration read does not prove every write permission, and one dataset check does not prove all analytics are available. Opening or returning to the page updates the state with bounded checks; there are no separate check or load buttons.

### If saving is unavailable

Use a replacement Token with the required permissions. If the Web form cannot complete the change, open **Cloudflare → Workers & Pages → this Worker → Settings → Variables and Secrets**, add or replace **`CFKANBAN_API_TOKEN` as a Secret**, then **Deploy**. Return to the usage page; it checks the current state automatically. An existing cached success is invalidated when the saved Token changes.

The page distinguishes rejection, confirmation in progress, and unavailable usage data. It never automatically resends the Token. An unconfirmed operation keeps changes locked while the system checks the original record; a record not yet found does not prove a save never happened. If that state remains unresolved, ask the Agent to recover the original operation instead of submitting another save. Confirm the replacement is active before revoking the old Token. If the instance is unavailable, use [recovery](recovery.md).

The unified Token takes precedence over legacy `CFKANBAN_CONFIGURATION_TOKEN`, `CFKANBAN_CONTROL_TOKEN`, and `USAGE_ANALYTICS_TOKEN`. Older Secrets and supported live settings are preserved during upgrades. Older instances without fixed control targets need an approved upgrade. Worker variables, Secrets, and rate-limit bindings take effect through a Worker version deployment; D1 application settings need no redeployment. See [Instance settings](../administration/settings.md).

## Adjust request-rate limits

```text
Use $cfkanban-admin to inspect request frequency for <instance address>.
Given <time and symptoms>, explain whether a limit should change and show the proposed before/after values.
```

Use **Administration → Usage & quotas → Request frequency** at the bottom of the page. The page loads current limits and checks the Token automatically. It supports instance API, single identity, unauthenticated sensitive actions, anonymous login, and counts/title search. Choose **Change limit**, enter a positive integer and a 10- or 60-second window, review the changes, then **Confirm save**.

The service preserves other settings and updates the corresponding native binding and display variables together. Changing only `RATE_LIMIT_*_LIMIT` or `RATE_LIMIT_*_PERIOD_SECONDS` in the Dashboard does not change enforcement: [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) use `simple.limit` and `simple.period`. Use the page or an approved deployment plan to keep them aligned. CPU and query-concurrency limits are not edited here.

Request limits differ from [project membership and content quotas](../administration/public-join.md). Clients honor Retry-After and backoff; do not evade limits by switching identities or replaying writes. Platform throttles are best-effort per PoP, not an account billing cap. A Paid CPU limit requires an explicit verified plan and never purchases or upgrades a subscription. Disabling a feature does not automatically delete cloud resources or stop their charges.
