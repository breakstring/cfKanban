# Everyday CLI work

Discover connections, verify your identity and choose exact targets before work. Directory scope recommends Projects and never grants access.

```text
cfkanban connection list --json
cfkanban profile show --instance <instance-uuid>
cfkanban issue list --instance <instance-uuid> --project <project-uuid>
cfkanban issue show --instance <instance-uuid> --identifier CFK-123
cfkanban issue complete --help
```

`join`, `identity`, and `scope` cover first access and pending identity recovery. Invitation input uses the dedicated secure transport; never copy a long-term token. Passkey enrollment and authentication require browser interaction.

`issue` supports filtered lists, candidates, counts, creation, changes, assignment, blocking, completion and reopening. `comment`, `label`, `relation`, `attachment`, `profile`, and `notification` cover collaboration, single-file transfer, personal preferences and acknowledgments. Each write follows its Service permission and write contract. Help distinguishes CAS-only operations from operations with server idempotency; stable keys apply to the latter.

```text
cfkanban comment create --instance <instance-uuid> --identifier CFK-123 --body-file ./note.md --idempotency-key <stable-key>
cfkanban web open --help
```

`web open` retains explicit local/online mode, target and actual working directory. A local browser workbench is separate from a host sidebar. Search results and pagination stay bounded. A completion note can be empty but must never invent verification.
