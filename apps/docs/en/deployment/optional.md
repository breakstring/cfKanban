# Domains, attachments, metrics, and request limits

The default deployment includes the core Worker, D1, and website. Plan optional capabilities by goal and disclose resource, cost, and permission changes.

## Custom domains

```text
Use $cfkanban-deploy to inspect the Cloudflare and DNS changes needed to use <target domain> for <instance address>.
Propose an exact plan that preserves existing access, without making changes yet.
```

You need control of the relevant Cloudflare resources and domain. Standard first deployment uses `workers.dev`. Normal upgrades do not add, remove, or adopt domains or routes. Verified existing custom domains can be preserved during attachment and maintenance, but adding or moving a domain needs a separately assessed plan. It is not an automatic option in the standard upgrade flow.

**In the Web UI:** cfKanban has no DNS or Worker domain editor. Once platform configuration is ready, the Owner can [verify and change the preferred API origin](../administration/settings.md). These are separate steps: an application preference neither creates DNS nor proves the domain is correctly bound.

Expect a concrete change plan and verification method first. After execution, verify HTTPS, the exact instance, and both origins. Authenticated requests must not rely on cross-origin redirects to carry Credentials.

## Enable private attachment storage

```text
Use $cfkanban-deploy to prepare an upgrade plan enabling Issue attachments at <instance address>.
Explain the private R2 bucket, permissions, subscription, possible charges, and cleanup schedule without enabling or deploying anything yet.
```

You need a Service supporting attachments, exact Cloudflare authority, and available R2 access. The plan includes one private Standard R2 bucket belonging to this instance, its Worker binding, and hourly cleanup. R2 subscription, possible charges, and any broader OAuth permissions must be explicit. Successful authentication does not prove a subscription or bucket access is available.

After approval, the Agent verifies the exact resources, provisions and checks ownership, then deploys and verifies the binding and cleanup schedule. It does not adopt an unknown bucket or automatically expose, empty, replace, or delete it.

**In the Web UI:** There is no R2 activation button. After deployment, the Owner chooses application capacity under **Administration → Overview → Usage & limits → Set limit**; see [Attachment capacity](../administration/settings.md). An unset limit still blocks new uploads. Deployment cannot choose unlimited capacity for the Owner.

After verified completion, authorized users can attach files in Issue details. Each file is limited to 10 MiB and each Issue to 20 non-deleted attachments. Unlimited application capacity does not remove those limits. Soft deletion does not immediately release reserved bytes; object cleanup after a Project purge is asynchronous.

## Configure Cloudflare usage metrics

```text
Use $cfkanban-deploy to inspect this instance's D1/R2 usage analytics configuration.
Propose read-only Analytics permissions and a safe configuration path, without receiving or printing any secret.
```

Analytics is optional. Missing credentials or incomplete settings produce **Not configured**, while core functionality and attachment application-budget data remain available. Collection refreshes on demand and adds no analytics schedule.

The Agent can plan non-secret settings for the exact account, D1, and optional R2. A separate read-only Analytics Token must be configured as a Worker Secret through a separately authorized secure Cloudflare input. The current safe deployment tools do not provide a command for writing that Secret and do not upload or reuse local Wrangler OAuth credentials. Do not include the Token in a prompt.

**In the Web UI:** **Overview → Usage & limits** shows collection status and offers refresh. A Secret binding does not prove successful collection; verify actual metrics through an Owner refresh afterward. Web and Agent share the cache, and a refresh does not promise real-time billing data.

## Request-rate limits

```text
Use $cfkanban-deploy to assess this instance's current request-rate settings.
Given <observed traffic and rate-limit symptoms>, propose adjustments and explain how these differ from Project quotas, without deploying yet.
```

Request limits belong to Worker deployment configuration. The Owner can inspect them under **Overview → Service information & access limits**. Changes need an exact Cloudflare deployment plan. Workspace and Project administrators cannot change them through application settings.

Expect verification of actual settings and the source of throttling before choosing a change. These limits differ from [Public Join active quotas](../administration/public-join.md) and are not a precise billing cap. A `429` does not always mean membership capacity is exhausted or justify increasing every limit.

## Maintain existing optional settings

Upgrades preserve verified domains, R2, cleanup schedules, and analytics configuration. Unknown bindings, routes, subscriptions, or permission changes require reviewing the difference first. Removing application access or disabling a feature does not prove the underlying resource was deleted or its costs ended.
