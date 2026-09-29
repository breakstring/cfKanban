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

The Agent requests a cache-aware refresh. Inspecting usage does not configure analytics credentials or change capacity. Results distinguish the attachment application budget from optional Cloudflare D1/R2 metrics. Unknown is not zero; instance usage is not account-wide usage or remaining free allowance.

**In the Web UI:** Open **Administration → Overview → Usage & limits** and choose **Refresh usage**. Exact observation windows appear in **Data details**. Web and Agent share a 15-minute successful-snapshot cache and a 60-second attempt cooldown. Manual refresh does not bypass the cache.

Reserved attachment bytes include uploads, ready files, soft-deleted files, and objects not yet confirmed reclaimed. Cloud daily totals use UTC and storage observations may be delayed. **Not configured** can coexist with valid application-budget values. See [Optional deployment configuration](../deployment/optional.md) to enable cloud metrics.

## Choose attachment capacity

```text
Use $cfkanban-admin to set this instance's attachment application capacity to 2 GiB.
Check the current reserved bytes first and verify the saved setting.
```

You can also explicitly request unlimited capacity. **Not set** differs from **Unlimited**: an unset policy pauses new uploads. The Owner chooses a positive whole-byte limit or explicitly removes the application cap. Deployment does not choose for you. Setting capacity alone does not enable R2.

**In the Web UI:** Open **Overview → Usage & limits → Attachment application budget → Set limit**. Choose a mode, enter finite capacity in MiB, and verify after saving. `1 GiB = 1024 MiB`. Lowering the limit keeps existing files and pauses new uploads above the limit.

The result changes the application budget only. It is neither actual R2 storage nor a Cloudflare billing cap. Soft-deleted files release reserved bytes only after reclamation succeeds.

## Read activity records

```text
Use $cfkanban-admin to show recent access changes in DemoProject, restricted to that Project, identifying the actor and the resource changed.
```

**In the Web UI:** Open **Administration → Activity**, filter by Project and event stream, and load more as needed. The Agent also reads bounded pages within the requested scope. A changed filter starts fresh pagination instead of reusing an old cursor.

Audit records help verify completed operations. Historical authorization and the actual event subject are different fields. An Issue event referring to a grant does not necessarily change that grant.

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

The target is probed without a Credential. Authenticated requests must not rely on cross-origin redirects. Domain bindings, DNS, and Worker request limits are separate [deployment operations](../deployment/optional.md). Changing the application preference does not create a domain binding.

## If saving fails

A version conflict means another operation changed the setting. Read current values and review your retained draft. If the previous response is uncertain, use recovery for that original save instead of guessing with repeated new saves. An unsupported feature requires a separate upgrade assessment; installing new Skills does not add it to the server.
