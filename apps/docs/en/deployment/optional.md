# Domains, attachments, metrics, and request limits

Enable these features when needed. Ask the Agent to explain resource, cost, and permission effects before deciding to proceed.

## Custom domains

```text
Use $cfkanban-deploy to check how <instance address> can use <target domain>.
Explain the domain setup, effects, and verification steps without changing anything yet.
```

You need the relevant Cloudflare and domain authority. The default site uses `workers.dev`. Adding or moving a domain requires separate planning and is not part of an ordinary upgrade.

**In the Web UI:** cfKanban has no domain configuration page. After the cloud setup, ask the Agent to [verify the site's address](../administration/settings.md). Changing an application address alone does not migrate a domain.

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
Explain the required read-only permissions and safe setup, without receiving or printing secrets.
```

Metrics are optional; unconfigured metrics do not prevent task collaboration. Setup needs additional read-only analytics authorization. The deployment Skill does not write the analytics secret automatically; follow the Agent's guidance for a secure Cloudflare configuration entry. Do not paste Tokens into chat.

**In the Web UI:** **Overview → Usage & limits** shows status and lets you refresh data. Observations may be delayed and are neither a real-time bill nor your account's remaining allowance.

## Adjust request-rate limits

```text
Use $cfkanban-deploy to investigate too-many-requests errors at <instance address>.
Given <time and symptoms>, assess whether limits need changing. Do not deploy yet.
```

The Owner can inspect limits under **Overview → Service information & access limits**. Changing them needs Cloudflare deployment authority. Request-rate limits differ from [public project membership and content quotas](../administration/public-join.md); throttling does not necessarily mean a project is full.

Upgrades should preserve existing optional settings. Disabling a feature does not automatically delete cloud resources or stop their charges.
