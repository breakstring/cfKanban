# Errors & original-operation recovery

A known permission refusal or CAS conflict requires current identity/target/version review. Do not silently pick another account or overwrite newer data.

```text
cfkanban operation show --instance <instance-uuid> --operation-id <operation-uuid> --json
cfkanban operation recover --instance <instance-uuid> --operation-id <operation-uuid> --json
```

Unknown write results retain the original caller identity, target, request, write contract, CAS and applicable key in protected non-secret state across CLI processes. Restore the same connection, inspect the retained operation, and use its recovery command. A refusal or conflict during replay does not prove the original request was rejected. CAS-only outcomes may require exact audit evidence and manual verification; uncertain cache refreshes use read-only recovery. Matching current data alone is not proof of the original result. After a server idempotency replay window expires, inspect remote audit evidence; do not submit a replacement write.

Readback failure after commitment is reported separately from rejection. Partial deployment resumes its exact authorized plan and journal; a changed plan requires new authorization. Local installation failures preserve the previous active version, and modified launchers are not overwritten.

Joining as `current_principal` binds the original Principal, Credential and trusted origin. Restore that caller before recovering after an identity switch. When an Owner rotation response is lost, preserve its original pending Credential and use `operation recover` to replay the original rotation request; recovery does not first authenticate `/me` with the revoked old Credential. Failed verification after a committed rotation retains the recovery gate. A valid current Credential alone cannot prove the original rotation committed.

Administrator, device Credential and notification readback follows cursors to locate the target, reading at most 10 pages per invocation. At the limit, the next cursor is retained; repeat the same recovery command to continue read-only verification without repeating a confirmed mutation. Input or local-state rejection known to precede a write request saves the failure and releases the write gate; recovery still returns that failure with a nonzero exit code.

Invitation, Browser Launch, Passkey and attachment recovery follow dedicated safe channels. A browser error does not authorize a second capability or identity. Clipboard/browser unavailability is a delivery limitation, not a reason to expose secrets in JSON or logs. See [deployment recovery](../deployment/recovery.md) for cloud and Owner total-loss rules.
