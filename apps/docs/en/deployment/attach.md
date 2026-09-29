# Connect an existing deployment on a new computer

Moving computers has two goals: obtain application Owner access, then establish a local deployment maintenance record. Neither requires redeployment or copying a long-lived Credential.

## Connect the Owner identity first

```text
Use $cfkanban-admin to connect this computer to <instance address> as the same Owner, with device name “<name>”.
```

An existing Owner device or supported administration page approves the pairing request, and the new computer verifies it. See [Owner devices](../administration/devices.md). If another identity is current locally, explicitly choose to retain it for restoration before switching. If all access is lost, inspect [recovery options](./recovery.md) first.

Adding an application device grants application management only. It does not sign in to Cloudflare or create a deployment maintenance record.

## Establish the local maintenance record

```text
Use $cfkanban-deploy to connect this computer to the existing deployment at <instance address> for future maintenance.
Verify the current Owner, exact Cloudflare resources, and running release. Save only the local maintenance record, without upgrading or changing remote resources.
```

You need a current Owner API identity, control of the exact Cloudflare account, and verified artifacts for the release already running. If old local records are missing, the Agent can discover candidates read-only within the confirmed account. Multiple candidates or unresolved checks require selecting the correct instance first.

The Agent checks the Worker, D1 binding, instance identity, schema and migration ledger, current Owner, trusted origin, and existing domain, R2, and analytics settings. After plan approval it saves only private local maintenance records. Remote resources, the database, and authentication configuration remain unchanged.

## What the record proves

The new record proves the instance state observed and verified now. Without historical artifact evidence, matching a release number does not prove which exact digest was originally deployed. That provenance is recorded as a remotely observed baseline.

A later upgrade must disclose the historical-source limitation and still verify the target release and database baseline. Connecting cannot repair unknown bindings, migration drift, or partial deployment and does not silently insert database records.

**In the Web UI:** Owner device approval is available in application administration. Deployment attachment has no Web button; it requires an Agent with local environment and Cloudflare control-plane access. A Passkey alone provides neither a local API Credential nor Cloudflare authority.

## Common questions

**Can I just copy the old computer's directory?** Use independent device Credentials and verified deployment attachment instead of moving long-lived secrets into chat, a repository, temporary directories, or a browser. This workflow does not ask you to export a secret.

**Can I upgrade immediately after connecting?** Connection and upgrade are separate operations. Prepare the exact [instance upgrade](./updates.md) plan before execution.

**What if I later rotate or recover the Owner?** Repeat attachment verification for the current identity and resources. Do not manually rewrite Credential identifiers in an old receipt.
