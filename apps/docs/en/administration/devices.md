# Devices and identity recovery

Owner devices let trusted execution environments manage the same instance with independent Credentials. Adding a device does not copy a long-lived secret or grant Cloudflare deployment access.

## Add an Owner device

On the new computer, ask:

```text
Use $cfkanban-admin to connect this computer to <instance address> as the same Owner.
Name it “<device name>” and prepare a pairing request for an existing Owner device or administration page to approve.
```

The deployed Service must support Owner devices, and the new environment must provide private persistent storage. The new device generates a private local Credential and returns only a non-secret pairing request. An existing Owner device or full Owner admin Session verifies the instance, Owner, name, fingerprint, and expiry before approving. Requests last at most one hour.

**In the Web UI:** As Owner, open **Administration → Members & access → Owner devices**, paste the non-secret request, inspect the preview, and explicitly approve it. The browser does not receive or store the new device's long-lived Credential. Return to the new device:

```text
Use $cfkanban-admin to finish verifying the Owner device connection I just prepared, and check my current identity.
```

Connection is complete only after the new device verifies the instance and exact Credential identity. Web approval alone does not switch local identity. Resume the same request after interruption instead of generating another Credential.

## List, rename, or revoke devices

```text
Use $cfkanban-admin to list my Owner devices and rename <exact device> to “Work computer”.
```

```text
Use $cfkanban-admin to revoke Owner access for <exact device>, after verifying its identifier and the effects.
```

Device names can be duplicated or empty. The Agent resolves the exact Credential ID and fingerprint before acting. Renaming only changes the label, preserving the secret, identity, and permissions. Trimmed names contain 1–80 Unicode characters.

**In the Web UI:** The same **Owner devices** list supports pagination, naming or renaming, and confirmed revocation of another device. You cannot revoke the current authentication source or the last active Owner API Credential. At most 100 Owner API Credentials may be active. Active means not revoked on the server; it does not prove a local secret file still exists.

Revocation invalidates the selected Credential and its derived browser access. Other devices and independent Passkeys remain. A device represents an execution environment, not hardware binding.

## This computer already has another identity

```text
Use $cfkanban-admin to switch this computer to the Owner of <instance address>, keeping my current identity available for restoration.
```

You must explicitly choose to replace the local current identity and use Skills supporting identity switching. The previous identity remains usable until approval and verification. It is then saved in a private restoration slot. Its Principal and access are not promoted, merged, or deleted.

```text
Use $cfkanban-admin to restore this computer's previously saved identity for <instance address>.
```

The Agent verifies the saved Credential before switching back and preserves the Owner Credential in turn. Conflicting restoration slots, identity mismatches, or interrupted switches require recovery of the original operation. Do not clear private files to bypass them. **There is no Web editor for local identity slots**; this happens in the environment holding the Agent Credential.

## Rotate the current Owner Credential

```text
Use $cfkanban-admin to safely rotate my current Owner Credential and verify that the replacement works locally.
```

You need a working Owner API Credential. The Agent privately prepares a replacement, atomically revokes the old Credential used for this rotation, and verifies the new one. Other devices remain. Ordinary rotation has no Web action; do not simulate it by revoking the current device.

## Recover a participant identity

```text
Use $cfkanban-admin to inspect recovery options for <participant name or stable ID>.
Explain the revocation scope of rotation and full_recovery, then verify the exact identity before creating a recovery invitation.
```

Only the Owner can issue recovery invitations for existing participants. They expire after one hour. `rotation` requires a working old Credential and revokes only the one used to redeem it. `full_recovery` needs no old Credential and revokes all of that identity's previous API Credentials. Both preserve the stable identity, access, assignments, history, and Passkeys. The mode cannot change at redemption.

**In the Web UI:** The Owner finds the participant under **Members & access**, opens their details, verifies the stable identity and recovery mode, and confirms inherited access and revocation effects before creating the invitation. Deliver it safely to the intended person, who completes recovery with an Agent. The browser does not save the replacement long-lived Credential. The Owner can also inspect and revoke a participant's specific Credential or Passkey from their details, after checking which sign-ins will be invalidated.

## All Owner Credentials are lost

If a valid Owner admin browser Session remains and at least one Owner API Credential is still unrevoked on the server, use the device approval flow above. This does not revoke all old Credentials automatically.

If that route is unavailable, or all old Credentials must be revoked together, use [Total Owner recovery](../deployment/recovery.md) with verified Cloudflare control. Ordinary invitations, participant recovery, and redeploying an empty instance are not substitutes.
