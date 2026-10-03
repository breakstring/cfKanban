# Instance settings and usage

These capabilities require Owner instance administration. Workspace and Project administrators do not have global settings, usage, or security audit access.

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

## Inspect usage

```text
Use $cfkanban-admin to show this instance's usage and remaining attachment capacity, including when the data was last collected.
```

Usage separates attachment capacity from optional Cloudflare metrics. Data may be delayed; unknown does not mean zero, and site usage is not account-wide usage or remaining free allowance.

**In the Web UI:** **Administration → Overview → Usage & limits** → **Refresh usage**. Check **Data details** for collection times. Repeated refreshes within a short period may show the same data.

Attachment capacity includes uploading, uploaded, and deleted files awaiting cleanup. If Cloudflare metrics show **Not configured**, see [Optional deployment configuration](../deployment/optional.md).

## Choose attachment capacity

```text
Use $cfkanban-admin to set this instance's total attachment capacity limit to 2 GiB.
Check current usage first, then confirm that the setting has taken effect.
```

You can explicitly choose unlimited capacity. Unset capacity blocks new uploads. Changing it requires Owner access. Uploading also needs attachment storage enabled; setting capacity does not enable it automatically.

**In the Web UI:** Open **Overview → Usage & limits → Attachment application budget → Set limit**. Choose a mode, enter finite capacity in MiB, and verify after saving. `1 GiB = 1024 MiB`. Lowering the limit keeps existing files and pauses new uploads above the limit.

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
