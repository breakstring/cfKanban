# Instance settings and usage

These capabilities require Owner instance administration. Workspace and Project administrators do not have global settings, usage, or security audit access.

## When configuration takes effect

- D1-backed application settings, including the homepage notice, attachment capacity, Public Join configuration, and permissions, need no Worker redeployment after a successful save. Subsequent requests use the new configuration according to the relevant read and cache rules; the page may need refreshing.
- Worker configuration changes, including `USAGE_*` variables, Secrets, rate-limit bindings, and CPU limits, require a Worker version deployment.
- WAF rules and Budget Alerts policies changed in the provider control plane do not themselves require redeploying the Worker. Read back the provider state after saving.

## Homepage instance notice

```text
Use $cfkanban-admin to update the homepage instance notice:
English: <public English notice>
Simplified Chinese: <public Simplified Chinese notice>
Verify both languages after saving.
```

The notice is public to signed-out visitors. Each language accepts up to 500 Unicode characters and displays plain text. An empty value uses fallback text. Missing Chinese falls back to configured English, then the built-in notice. When editing one language, the Agent preserves the current value of the other.

**In the Web UI:** **Administration → Overview → Homepage instance notice** provides both language fields, saving, and restoring defaults. Restoring defaults clears the draft; save it to apply the change.

After saving, the Agent verifies both language versions and the homepage shows the corresponding text. Keep private project details, credentials, and recovery links out of the notice.

## Publish an instance notification

```text
Use $cfkanban-admin to publish this notice to the instance:
Title: Planned maintenance
Body: Tonight 22:00–22:30, the site may be briefly unavailable.
Expiry: <selected date and time with timezone, optional>
Verify the publication in Owner history.
```

**In the Web UI:** Open **Notifications** from the account area or management overview → **Published by Owner**. Enter a title, body, and optional future expiry, then **Publish announcement**. Select **Withdraw announcement** for an exact published notice to stop reminders. Publication and withdrawal require Owner instance administration; a browser opened for one project or a scoped administrator cannot use them.

Title accepts up to 200 Unicode characters and body up to 4000. Published text cannot be edited: publish a new notice to correct it. Expired or withdrawn notices remain in history with their body and status. Do not include credentials or private project content in an instance-wide notice. The publisher does not receive its own automatic reminder. The Owner cannot override a person's choice to disable reception; there is no per-person reading report. See [Owner notifications](../usage/notifications.md) for recipient controls and confirmation.

## Announce successful upgrades automatically

**In the Web UI:** **Administration → Overview → Version updates** includes **Automatically announce verified upgrades**. It starts off. Save the setting to enable or disable it; Owner instance administration is required.

```text
Use $cfkanban-admin to turn on automatic announcements after verified site upgrades.
Check and verify the saved setting.
```

```sh
cfkanban admin upgrade-notification show --json --no-interactive
cfkanban admin upgrade-notification configure --enabled true --expected-version <current-version> --json --no-interactive
```

After an approved upgrade succeeds and its actual release is verified, a compatible deployment runtime publishes one bilingual notice with the old/new versions, exact Release link, and local Skill update guidance. Forward stable and `rc.N` upgrades qualify; alpha, beta and other prerelease channels are skipped with `unsupported_channel`. Failed upgrades, first deployment, same-version redeployment, rollback, and local Skill-only updates do not publish. Each release gets at most one automatic notice, including when a site rolls back and later returns to that release. Recipient preferences and history still apply. This reminder does not mean local Skills have been updated.

The upgrade and announcement results are reported separately. A failed announcement does not undo a successful upgrade; keep the original maintenance journal and ask the Agent to recover its original request and key. Do not deploy the site again just to retry an announcement.

## Inspect usage

```text
Use $cfkanban-admin to show this instance's usage and remaining attachment capacity, including when the data was last collected.
```

Usage separates attachment capacity from optional Cloudflare metrics. Data may be delayed; unknown does not mean zero, and site usage is not account-wide usage or remaining free allowance.

Overview shows only reserved attachment capacity, D1/R2 storage, and analytics status. The separate **Usage & limits** tab contains full metrics, refresh, capacity settings, and configuration guidance.

Optional metrics separate Workers requests/CPU, D1 read/write rows, and billing-cycle R2 Class A/B. Explicitly enabled account totals appear separately. Snapshot bars compare metrics with matching units and observation windows; returned allowance reminders show contribution progress. An absent reminder does not mean zero usage or sufficient remaining allowance. Expand **Data details** to inspect exact windows and observation times.

**Daily usage history** separately offers 7-, 30-, and 90-day views of complete UTC days, excluding today. History collection starts disabled. Choose **Preview enabling history**, review the Worker configuration plan, then **Apply this plan**; configuration authorization must be verified first. Enabled collection reuses the existing maintenance trigger, while instances without one can collect a selected day manually. **Collect selected day** accepts only one of the last seven complete UTC days. Reading charts does not collect or poll in the background. Missing days and unknown values remain gaps; a real zero remains zero. Instance and account scopes remain separate. Storage and object counts retain their actual observation times, rather than representing daily consumption or GB-month billing.

**Cloudflare plan** and **billing cycle** are analytics configuration verified by the Owner, not a cfKanban subscription or billing cycle. A missing monthly cycle does not prevent existing daily metrics; unknown does not mean Cloudflare has no subscription. R2 free comparisons also require a verified Standard-only scope.

The **cfKanban usage reminder threshold** is a percentage of shared allowances, not a USD budget or remaining quota. Cloudflare Budget Alerts separately notify selected email recipients when cumulative usage-based account charges exceed a USD budget threshold. The public API contract has not confirmed the USD budget fields or editing operation, so the Owner page links to Cloudflare's budget dashboard. It can read notification policy names, enabled states, alert types, and recipient emails with the appropriate authorization; these fields do not prove a USD budget amount. A permission error or absent policy projection does not mean no budget alert is configured.

**Administration → Cloudflare connection** shows the deployment's fixed account, Worker, and database targets. Older instances without these target settings need an approved upgrade first. Enter configuration, feature, and analytics Tokens in their separate password fields and choose **Save and apply configuration**. These are separate authorization purposes, not a requirement for three different credentials: a compatible Token can serve multiple purposes, each verified separately. Their final storage is ordinary encrypted [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), supported on Free without Secrets Store. Inputs clear after submission and are not restored as drafts or returned by the API. The configuration Token needs Editor access to this Worker only, including code and deployment authority. First setup saves that Token itself; subsequent Token saves use the saved configuration authorization. After successful setup and verification, the Owner can sign in from another device to read policies and manage the supported configuration without importing Tokens again. See [Optional deployment configuration](../deployment/optional.md) for minimum permissions and recovery. Do not send Tokens to chat or save them in browser storage or plaintext Worker variables.

Create the Tokens in Cloudflare using the displayed deployment targets:

| Purpose | Creation entry | Permissions and resource scope |
| --- | --- | --- |
| Worker configuration | [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens): **Manage Account → Account API Tokens → Create Token → Specified Workers → this existing Worker → Editor** | An account-owned Token for the displayed Account, with [Editor](https://developers.cloudflare.com/workers/authorization/workers/) only for the displayed Worker. Editor includes code, deployment, and Secret management. |
| Notifications, billing, and WAF reads | [Custom Token guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/): **My Profile → API Tokens → Create Token → Create Custom Token** | Account **Notifications Read / Billing Read**, restricted to the displayed Account. For WAF, add **Zone Read / Zone WAF Read** only for the domain's verified Zone; do not choose all Zones. No Edit permissions are needed. |
| Analytics | [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens): **Create Token → Custom token** | [Account → Account Analytics → Read](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/), restricted to the displayed Account. Saving first verifies the D1 analytics interface; availability of other configured datasets is established by subsequent usage reads. |

Creating an [account-owned Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) requires the person's account Super Administrator or API Token Provisioning authority. This is the creator's permission, not an extra Token-management permission to grant the business Token. Verify configuration authorization first, then save each optional purpose separately. A shared Token still needs each purpose's real capability check; account-owned Notifications compatibility is not guaranteed. If a read-only purpose cannot be verified, use a compatible user Token for that purpose while retaining the account-owned single-Worker Editor for configuration.

Secret presence alone does not confirm that configuration is active. **Pending** or **Unknown** results require **Verify current state**; it reads the latest operation even when the save/apply response was lost. Inputs stay empty and writes stay locked until the result is confirmed; do not replay the change blindly. Usage settings and each of the five native request-limit scopes use **Preview** followed by a separate **Apply this plan** action. Limits require positive integers and a 10- or 60-second window, and update the binding and displayed policy together. CPU settings and fixed query-concurrency limits are not edited by these forms.

The usage snapshot's **Domain & access protection** remains the last deployment declaration, not a live check. The **Cloudflare connection** page separately reads the selected Zone and tool-owned custom rule. It reports protection as verified only when the exact-hostname blocking rule is enabled and matched; Token permissions alone do not establish protection. This is not Cloudflare Managed Rules, and an absent tool-owned rule does not exclude other WAF protection. Domain and WAF changes still use the deployment Skill/CLI plan and apply workflow. An existing domain without a tool ownership receipt needs an explicit connection plan, without deletion and recreation. The [domain guide](../deployment/optional.md) explains this boundary and alternate entry points.

```sh
cfkanban admin usage show --mode manual --json --no-interactive
cfkanban admin rate-limits show --json --no-interactive
```

**In the Web UI:** **Administration → Usage & limits** → **Refresh usage**. The overview summary also links to this tab. Check **Data details** for collection times. Repeated refreshes within a short period may show the same data.

Attachment capacity includes uploading, uploaded, and deleted files awaiting cleanup. If Cloudflare metrics show **Not configured**, see [Optional deployment configuration](../deployment/optional.md).

## Choose attachment capacity

```text
Use $cfkanban-admin to set this instance's total attachment capacity limit to 2 GiB.
Check current usage first, then confirm that the setting has taken effect.
```

You can explicitly choose unlimited capacity. Unset capacity blocks new uploads. Changing it requires Owner access. Uploading also needs attachment storage enabled; setting capacity does not enable it automatically.

**In the Web UI:** Open **Administration → Usage & limits → Attachment application budget → Set limit**. Choose a mode, enter finite capacity in MiB, and verify after saving. `1 GiB = 1024 MiB`. Lowering the limit keeps existing files and pauses new uploads above the limit.

This limit controls uploads in cfKanban and is labeled **Attachment application budget** in the Web UI. It is neither actual R2 storage use nor a Cloudflare billing cap. Deleted files release capacity only after cleanup succeeds.

## Read activity records

```text
Use $cfkanban-admin to show recent permission changes in <project name>.
Limit the results to this project and explain who changed whose permissions.
```

**In the Web UI:** **Administration → Activity** displays the newest records first. Filter by project and event type, then **Load older Audit events** as needed. Apply filters again to include new changes in a fresh list.

## Connection address and request limits

```text
Use $cfkanban-admin to check the address Agents use to connect to this instance and its current request-rate limits without changing them.
```

**In the Web UI:** **Overview → Service information & access limits** displays the release, instance addresses, and request limits as read-only information.

The **preferred API origin** tells Agents which connection address to prefer. Once the new domain is configured, ask your Agent to check the proposed address change:

```text
Use $cfkanban-admin to verify that https://<new-domain> reaches this same instance.
If verification succeeds, propose the connection address change and check both the old and new addresses.
```

The Agent checks the new address before sending it any credentials. Domain bindings, DNS, and request-rate changes are [deployment operations](../deployment/optional.md); changing the application address alone does not configure them.

## If saving fails

If a save conflicts with another change, read the latest settings first. Verify the original operation when its result is uncertain. If a feature is unavailable, ask the Agent to check the site’s version.
