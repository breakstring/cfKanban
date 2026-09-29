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

Expect verified stored values and the corresponding public homepage text. Keep private Project details, Credentials, and recovery links out of the notice.

## Inspect usage

```text
Use $cfkanban-admin to show this instance's usage and remaining attachment capacity, including when the data was last collected.
```

Usage separates attachment capacity from optional Cloudflare metrics. Data may be delayed; unknown does not mean zero, and site usage is not account-wide usage or remaining free allowance.

**In the Web UI:** **Administration → Overview → Usage & limits** → **Refresh usage**. Check **Data details** for collection times. Repeated refreshes within a short period may show the same data.

Attachment capacity includes uploading, uploaded, and deleted files awaiting cleanup. If Cloudflare metrics show **Not configured**, see [Optional deployment configuration](../deployment/optional.md).

## Choose attachment capacity

```text
Use $cfkanban-admin to set this instance's attachment application capacity to 2 GiB.
Check the current reserved bytes first and verify the saved setting.
```

You can explicitly choose unlimited capacity. Unset capacity blocks new uploads. Changing it requires Owner access. Uploading also needs attachment storage enabled; setting capacity does not enable it automatically.

**In the Web UI:** Open **Overview → Usage & limits → Attachment application budget → Set limit**. Choose a mode, enter finite capacity in MiB, and verify after saving. `1 GiB = 1024 MiB`. Lowering the limit keeps existing files and pauses new uploads above the limit.

The result changes the application budget only. It is neither actual R2 storage nor a Cloudflare billing cap. Soft-deleted files release reserved bytes only after reclamation succeeds.

## Read activity records

```text
Use $cfkanban-admin to show recent access changes in DemoProject, restricted to that Project, identifying the actor and the resource changed.
```

**In the Web UI:** **Administration → Activity** → filter by project and event type, then load more as needed.

## Origins and request limits

```text
Use $cfkanban-admin to inspect this instance's preferred API origin and deployed request-rate settings without changing them.
```

**In the Web UI:** **Overview → Service information & access limits** displays the release, instance addresses, and request limits as read-only information.

Use an Agent to change an already configured preferred origin:

```text
Use $cfkanban-admin to verify that https://<new-domain> reaches this same instance without sending it a Credential first.
If verification succeeds, propose the preferred API origin change and verify both origins.
```

The domain must be configured first. Domain bindings, DNS, and request-rate changes are [deployment operations](../deployment/optional.md); changing the application address alone does not configure them.

## If saving fails

If a save conflicts with another change, read the latest settings first. Verify the original operation when its result is uncertain. If a feature is unavailable, ask the Agent to check the site’s version.
