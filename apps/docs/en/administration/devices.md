# Devices and identity recovery

Owner devices let trusted execution environments manage the same instance with independent Credentials. Adding a device does not copy a long-lived secret or grant Cloudflare deployment access.

## Add an Owner device

On the new computer, ask:

```text
Use $cfkanban-admin to connect this computer to <instance address> as the same Owner.
Name it “<device name>” and prepare a pairing request for an existing Owner device or administration page to approve.
```

After the new computer prepares a pairing request, check the site, Owner identity, device name, and expiry on an existing Owner device or administration page. Confirm that the fingerprint matches the request on the new computer before approving. Requests last at most one hour. Do not transfer long-lived credentials.

**In the Web UI:** As Owner, open **Administration → Members & access → Owner devices**, paste the non-secret request, inspect the preview, and explicitly approve it. The browser does not receive or store the new device's long-lived Credential. Return to the new device:

```text
Use $cfkanban-admin to finish verifying the Owner device connection I just prepared, and check my current identity.
```

After Web approval, finish verification on the new computer before using it. Resume the same request if interrupted.

## List, rename, or revoke devices

```text
Use $cfkanban-admin to list my Owner devices and rename <exact device> to “Work computer”.
```

```text
Use $cfkanban-admin to revoke Owner access for <exact device>, after verifying its identifier and the effects.
```

Devices can share a name; check the exact record before revocation. Renaming changes only the label, preserving access.

**In the Web UI:** The **Owner devices** list lets you rename or revoke other devices. You cannot revoke the device credential used for your current sign-in or the last active Owner credential.

Revocation invalidates the selected Credential and its derived browser access. Other devices and independent Passkeys remain. A device represents an execution environment, not hardware binding.

## This computer already has another identity

```text
Use $cfkanban-admin to switch this computer to the Owner of <instance address>, keeping my current identity available for restoration.
```

You must explicitly choose to replace the local current identity and use Skills supporting identity switching. The previous identity remains usable until approval and verification. It is then saved in a private restoration slot. Its Principal and access are not promoted, merged, or deleted.

```text
Use $cfkanban-admin to restore this computer's previously saved identity for <instance address>.
```

The Agent verifies and restores the saved identity while keeping the Owner identity available to switch back. **There is no Web action for local identity switching.** Ask the Agent to investigate conflicts instead of deleting private files.

## Rotate the current Owner Credential

```text
Use $cfkanban-admin to safely rotate my current Owner Credential and verify that the replacement works locally.
```

You need a working Owner credential. The Agent safely replaces this device’s credential while preserving other devices. Use the Agent; there is no Web action for this operation.

## Recover a participant identity

```text
Use $cfkanban-admin to inspect recovery options for <participant name or stable ID>.
Explain which access ordinary rotation and full recovery would revoke, then verify the exact identity before creating a recovery invitation.
```

Only the Owner can issue recovery invitations, which last one hour. Ordinary rotation requires working access and replaces only the credential used. Full recovery needs no old credential and revokes all previous Agent credentials for that identity. Browser sign-ins created through revoked credentials also end. Both options preserve issues, access, history, and independent Passkeys.

**In the Web UI:** The Owner finds the participant under **Members & access**, opens their details, verifies the stable identity and recovery mode, and confirms inherited access and revocation effects before creating the invitation. Deliver it safely to the intended person, who completes recovery with an Agent. The browser does not save the replacement long-lived Credential. The Owner can also inspect and revoke a participant's specific Credential or Passkey from their details, after checking which sign-ins will be invalidated.

## All Owner Credentials are lost

If a valid Owner admin browser Session remains and at least one Owner API Credential is still unrevoked on the server, use the device approval flow above. This does not revoke all old Credentials automatically.

If that route is unavailable, or all old Credentials must be revoked together, use [Total Owner recovery](../deployment/recovery.md) with verified Cloudflare control. Ordinary invitations, participant recovery, and redeploying an empty instance are not substitutes.
