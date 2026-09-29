# Profile and directory association

## View or change your name

```text
Use $cfkanban to show my current display name and identity ID without exposing any credential.
```

```text
Change my display name to Lin_Design.
```

Any authenticated identity, including a reader, can view and change its own display name. Your identity ID, project access, assignments, and history continue to belong to the same person.

Names are unique within an instance. Case and compatible forms such as full-width letters are normalized for comparison. A name must have 1–128 characters and may contain letters, numbers, combining marks, `_`, `-`, and `·`. Spaces, invisible characters, emoji, and other punctuation are not allowed. `admin`, `administrator`, `owner`, `system`, `管理员`, `所有者`, and `系统` are reserved names. If the name is taken, you choose another; the Agent should not silently add a suffix.

**In the Web UI:** Select your name in the header → **My profile** → edit the display name under **Identity profile** → **Save**. The page also shows your non-editable identity ID.

## View and revoke your Passkeys

```text
Use $cfkanban to list the Passkeys registered for my identity in this instance.
Show their registration time, last use, and status without revoking anything.
```

```text
Revoke the Passkey I selected: <Passkey ID>.
I understand that browser sessions created with it will stop immediately.
```

Select the exact record from your own registration list first. The list describes server registrations, not private keys or hardware on this computer, and does not prove that a device is currently usable. The Agent can read your non-secret records and revoke a selected one.

Revocation immediately ends all browser sessions created by that Passkey. Other Passkeys, Agent credentials, and project access remain unchanged. If your current browser session came from that Passkey, you will lose that session too.

**In the Web UI:** Go to **My profile** → **Passkeys**, check the record, and select **Revoke** for the correct entry. Registering another Passkey still requires an Agent-opened session and your browser/system interaction; see [Joining and signing in](./access.md).

## Associate a working directory with projects

```text
Use $cfkanban to show which projects this directory is associated with.
```

```text
Use $cfkanban to associate this directory with DemoProject in the Product workspace.
Preserve its existing associations with other projects.
```

```text
Also associate this directory with Mobile for future issue searches.
```

A directory association is useful when you regularly work on the same projects from a repository or ordinary folder. You need access to the target projects and must explicitly allow the Agent to save this local setting. After verifying the projects, it creates or merges `.cfkanban-scope.json`. The file contains only non-secret project identifiers, and existing associations should be preserved.

Future searches prefer projects you explicitly name in the request, followed by directory recommendations. With neither, the Agent should explain the authorized scope it actually uses. An association is not access control: it neither grants project access nor prevents explicit lookup of another authorized issue.

**Web note:** The Agent manages directory associations in its current execution environment; there is no Web editor for them. Switching projects in the browser changes the visible project without modifying local directory settings. Joining a project does not create an association automatically.

## Common questions

- **This directory has no association:** You can continue by naming a project. A direct lookup such as `CFK-123` needs no association either.
- **A new computer lacks the old association or identity:** Directory settings and private identity state are different. Copying project identifiers does not grant access. Ask the Agent to check local identity and use the appropriate recovery or device connection workflow if needed.
- **History remains after a rename:** This is expected. The name is a display field; your stable identity is unchanged.
- **No registration button after Passkey sign-in:** New registrations require an Agent-opened session. Ask the Agent to open the correct site again before registering.
