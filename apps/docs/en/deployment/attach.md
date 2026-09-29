# Connect an existing deployment on a new computer

On a new computer, connect your existing Owner identity first, then set up deployment maintenance if needed. You do not need to redeploy the site.

## Connect the Owner identity

```text
Use $cfkanban-admin to connect this computer to <instance address> as the same Owner, with device name “<name>”.
```

Approve the request from an existing Owner device or administration page, then finish verification on the new computer. See [Owner devices](../administration/devices.md). If all access is lost, check [recovery options](./recovery.md) first.

This gives you application management access. Continue below if you also want to upgrade the site or maintain cloud resources from this computer.

## Set up deployment maintenance

```text
Use $cfkanban-deploy to connect this computer to the existing deployment at <instance address> for future maintenance.
Verify my Owner identity and Cloudflare account. Save local maintenance records without upgrading or changing remote resources.
```

You need current Owner access and authority over the corresponding Cloudflare account. The Agent checks the site, cloud resources, and existing settings, then saves private maintenance records on this computer. Existing data and access stay unchanged.

Use an Agent for this step; there is no Web button. After connecting, make a separate [upgrade request](./updates.md) when needed.

## If something goes wrong

- **This computer already has another identity:** Explicitly keep it for restoration before switching; see [Devices and identity recovery](../administration/devices.md).
- **Several instances are found:** Verify the target address and account before choosing.
- **Checks find a mismatch:** Ask the Agent to investigate. Do not edit maintenance records or reinitialize the site.
- **You want to copy the old computer's data directory:** Use the connection workflow instead of putting long-lived credentials in chat, a repository, or a shared folder.
