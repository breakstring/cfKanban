# Instance settings and usage

These capabilities require Owner instance administration. Workspace and Project administrators do not have global settings, usage, or security audit access.

## When configuration takes effect

- D1-backed application settings, including the homepage notice, attachment capacity, Public Join configuration, and permissions, need no Worker redeployment after a successful save. Subsequent requests use the new configuration according to the relevant read and cache rules; the page may need refreshing.
- Worker configuration changes, including `USAGE_*` variables, Secrets, rate-limit bindings, and CPU limits, require a Worker version deployment.

## Homepage instance notice

```text
Use $cfkanban-admin to update the homepage instance notice:
English: <public English notice>
Simplified Chinese: <public Simplified Chinese notice>
Verify both languages after saving.
```

The notice is public to signed-out visitors. Each language accepts up to 500 Unicode characters and displays plain text. An empty value uses fallback text. Missing Chinese falls back to configured English, then the built-in notice. When editing one language, the Agent preserves the current value of the other.

**In the Web UI:** **Administration → Instance settings → Homepage instance notice** automatically shows the active content when opened. Edit it and choose **Save**. Retry or review actions appear only if loading fails or a save conflicts; your edits are retained. Restoring defaults clears the draft; save it to apply the change.

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

**In the Web UI:** **Administration → Versions & updates** includes **Automatically announce verified upgrades**. It starts off. Save the setting to enable or disable it; Owner instance administration is required.

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

**In the Web UI:** Open **Administration → Usage & quotas**. Overview keeps a read-only summary. The usage page has the Token form at the top, today's usage and daily history together, attachment capacity, and request frequency at the bottom.

Enter one Cloudflare API Token and choose **Save**. A persistent **Token saved** status means the empty input is ready for a replacement; leaving it blank keeps the saved value. The Token is never returned by the API or restored as a browser draft. The page automatically confirms the save, checks configuration and analytics, and loads the sections. There are no separate check, read, or refresh buttons. A failed capability does not undo a successful save, and an unconfirmed write keeps its original record and blocks another change while the system checks it.

The account, Worker, and database are fixed deployment targets. Saving through the page needs the current Worker's Editor permission; analytics needs Account Analytics Read for the displayed account. A configuration read alone does not prove every write permission. See [Token setup and recovery](../deployment/optional.md) for exact permissions and the Cloudflare Secret recovery route. Never send Tokens to chat or store them in browser storage or plaintext Worker variables. Legacy Secrets are preserved during upgrades.

Today's metrics use the UTC day, including on Paid plans. Billing-cycle totals and precise observation times are in **Data details**. Storage is an observed capacity, rather than daily consumption. Unknown does not mean zero, and instance usage does not represent account-wide usage or remaining allowance. Explicitly enabled account totals appear separately.

**Daily usage history** offers 7-, 30-, and 90-day views of complete UTC days, excluding today. It starts disabled; choose its setting, review the change, and confirm to enable it. Enabled collection reuses the existing maintenance trigger. Entering or returning to the page can automatically collect at most one missing day from the last seven complete UTC days, with a 60-second cooldown; it does not loop through all gaps. If a collection response is lost, the page reads the result without submitting it again. Missing days and unknown values remain gaps.

In **Data details**, open an analytics setting to edit it in place. The declared Cloudflare plan and UTC billing cycle describe your verified Cloudflare configuration, not a cfKanban subscription. Missing cycle information leaves monthly totals unknown but does not prevent daily usage. Account totals remain an opt-in. Budget notifications and WAF management have been removed from this flow; existing provider rules and old operation records are preserved for safe upgrades and recovery.

```sh
cfkanban admin usage show --mode manual --json --no-interactive
cfkanban admin rate-limits show --json --no-interactive
```

Agent queries and automatic page loads share the same cache; a recent successful snapshot can be reused. Attachment capacity includes uploading, uploaded, and deleted files awaiting cleanup. If metrics remain unavailable, the page shows the affected capability and the next step beside the Token or data area.

## Choose attachment capacity

```text
Use $cfkanban-admin to set this instance's total attachment capacity limit to 2 GiB.
Check current usage first, then confirm that the setting has taken effect.
```

You can explicitly choose unlimited capacity. Unset capacity blocks new uploads. Changing it requires Owner access. Uploading also needs attachment storage enabled; setting capacity does not enable it automatically.

**In the Web UI:** Open **Administration → Usage & quotas → Attachment storage limit → Set limit**. Choose a mode, enter finite capacity in MiB, and verify after saving. `1 GiB = 1024 MiB`. Lowering the limit keeps existing files and pauses new uploads above the limit.

This limit controls uploads in cfKanban and is labeled **Attachment storage limit** in the Web UI. It is neither actual R2 storage use nor a Cloudflare billing cap. Deleted files release capacity only after cleanup succeeds.

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

**In the Web UI:** **Overview → Service information** displays the release and instance addresses. **Usage & quotas → Request frequency** shows current limits and loads the current settings automatically. An Owner can choose a limit, review the before/after values, and confirm the save.

The **preferred API origin** tells Agents which connection address to prefer. Once the new domain is configured, ask your Agent to check the proposed address change:

```text
Use $cfkanban-admin to verify that https://<new-domain> reaches this same instance.
If verification succeeds, propose the connection address change and check both the old and new addresses.
```

The Agent checks the new address before sending it any credentials. Domain bindings and DNS require a separate [deployment plan](../deployment/optional.md); changing the application address alone does not configure them. Supported request limits can be changed on the usage page.

## If saving fails

If a save conflicts with another change, read the latest settings first. Verify the original operation when its result is uncertain. If a feature is unavailable, ask the Agent to check the site’s version.
