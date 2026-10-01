# Profile and directory association

## View or change your name

```text
Use $cfkanban to show my current display name and identity ID without exposing any credential.
```

```text
Change my display name to Lin_Design.
```

Any authenticated identity, including a reader, can view and change its own display name. Your identity ID, project access, assignments, and history continue to belong to the same person.

Names must be unique within the site and contain 1–128 characters. Use letters, numbers, `_`, `-`, or `·`, without spaces or emoji. System-reserved names are unavailable; choose another if a name is rejected.

**In the Web UI:** Open the account menu at the top right → **Personal settings** → edit the display name under **Identity profile** → **Save**. The page also shows your non-editable identity ID.

## Save your color theme

```text
Use $cfkanban to show my saved theme, then change it to Calm blue.
Keep my display name unchanged and verify that the preference was saved.
```

Choose **Warm orange** (the default) or **Calm blue**. Both themes use the same layout, controls, and interactions; only their colors change.

**In the Web UI:** Open the account menu → **Personal settings** → choose a theme → **Save theme**. The saved theme applies across signed-in pages, including management pages. It belongs to your identity in this site, so it is available when you sign in again or use another browser. Other people's themes are unchanged.

Any signed-in identity can save its own theme, including readers. If another profile change causes a version conflict, refresh the profile and review your selection before saving again. The Agent uses the same profile API to read and save this preference.

## Owner notifications

Personal settings links to **Notifications**, where you can choose reception, read pending reminders, and find history. Turning reminders off preserves explicit history; turning them on starts from now. See [Owner notifications](./notifications.md) for Web and Agent confirmation.

## View and revoke your Passkeys

```text
Use $cfkanban to list the Passkeys registered for my identity in this instance.
Show their registration time, last use, and status without revoking anything.
```

```text
Revoke the Passkey I selected: <Passkey ID>.
I understand that browser sessions created with it will stop immediately.
```

Check the registration and its last-use time in your list before selecting it for revocation.

Revocation immediately ends all browser sessions created by that Passkey. Other Passkeys, Agent credentials, and project access remain unchanged. If your current browser session came from that Passkey, you will lose that session too.

**In the Web UI:** Open the account menu → **Personal settings** → **Passkeys**, check the record, and select **Revoke** for the correct entry. Registering another Passkey still requires an Agent-opened session and your browser/system interaction; see [Joining and signing in](./access.md).

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

Directory association helps when you regularly work on the same projects from one repository or folder. The Agent verifies the projects and saves the local setting while preserving other associations.

You can then omit the project name. A project explicitly named in your request still takes precedence. Association does not grant new access.

**Web note:** The Agent manages directory associations in its current execution environment; there is no Web editor for them. Switching projects in the browser changes the visible project without modifying local directory settings. Joining a project does not create an association automatically.

## Common questions

- **This directory has no association:** You can continue by naming a project. A direct lookup such as `CFK-123` needs no association either.
- **A new computer lacks the old association or identity:** Directory settings and private identity state are different. Copying project identifiers does not grant access. Ask the Agent to check local identity and use the appropriate recovery or device connection workflow if needed.
- **History remains after a rename:** This is expected. The name is a display field; your stable identity is unchanged.
- **No registration button after Passkey sign-in:** New registrations require an Agent-opened session. Ask the Agent to open the correct site again before registering.
