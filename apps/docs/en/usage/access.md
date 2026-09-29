# Joining and signing in

Joining a project determines what you may do. Signing in determines the browser session you use to access it. Opening the public homepage does not create an identity or grant project access.

## Accept a project invitation

```text
Use $cfkanban to join this project: <invitation link>.
Check the site, projects, roles, and my existing local identity, then explain what needs confirmation before continuing.
```

You need a valid invitation. The Agent first checks its exact scope, roles, expiry, and identity requirements, then presents one combined join plan. It reuses an existing identity when permitted; first use may require you to choose a display name. After confirmation, expect verified access to the invited projects.

An ordinary invitation grants reader or writer access to specific projects, not administrator access. Invitations can be redeemed once. Accepting an ordinary invitation does not overwrite an existing active role. Contact a project administrator to change an existing role.

**In the Web UI:** An already signed-in non-Owner participant can open an ordinary invitation, check the displayed identity, projects, and roles, then explicitly accept it as the current identity. Opening the link alone does not accept it. If the current session cannot cover every target, acceptance fails without joining only some of the projects; use the Agent path instead.

Creating a first identity, recovering one, and connecting an Owner device use their dedicated Agent workflows. An ordinary invitation cannot recover your lost existing identity.

## Join a public project

```text
I want to join DemoProject, listed on the homepage at <site address>, as a reader.
Use $cfkanban to verify the public entry point and my local identity, then explain the join plan.
```

The Owner must have enabled Public Join for the project. Choose one public project at a time and explicitly select Reader or Writer. The easiest approach is to use the homepage's generated Agent prompt for that project and role; it includes the exact target and joining guide in your language.

After confirmation and a successful join, you receive access to that project. Public Join does not grant an entire workspace. Joining can fail if the project is full or its public entry has closed.

**In the Web UI:** Select a project and role in the homepage's public project list. While signed out, copy its Agent prompt. After signing in with a Passkey, you can join directly and enter the board. Selecting Reader when you are already a Writer does not downgrade your access. An existing Reader can select Writer while the public entry remains open.

## Ask an Agent to open an authenticated page

```text
Use $cfkanban to open the DemoProject board in my browser.
```

```text
Open CFK-123 in IAB using my current cfKanban identity.
```

You need a usable local identity, access to the target, and browser delivery supported by your host. The Agent verifies the site and identity, then opens an authenticated page through the dedicated entry point. If the requested browser is unavailable, it should explain the problem instead of silently choosing another.

The sign-in handoff is one-time and valid for five minutes. Browser sessions have a fixed eight-hour lifetime. The header shows the expiry, and switching projects does not extend it. You do not need to copy a long-lived credential into a page, prompt, or clipboard.

**In the Web UI:** Use your current session while it remains valid. After expiry, ask the Agent to open a fresh one or sign in with a registered Passkey. If browser delivery fails, ask the Agent to check the delivery path; do not create a second identity solely because of that failure.

## Sign in with a Passkey

```text
Use $cfkanban to open an authenticated DemoProject page so I can register a Passkey for my current identity.
```

Both first registration and additional registrations require an Agent-opened session. You complete registration through the browser or operating system. The Agent cannot replace your biometric check, security key interaction, or system confirmation.

**In the Web UI:** Your name in the header → **My profile** → **Register Passkey**. For later visits, open the same site's homepage, select Passkey sign-in, and follow the system prompt. Participants then choose an authorized project; the Owner enters the management overview.

A Passkey authenticates you to the Web UI. It grants no project access and does not replace the Agent's local credential. It is associated with the hostname where you registered it. If the site moves to another hostname, ask the Agent to open the new address and register there. See [Profile](./profile.md) for revocation.

## Switch projects

```text
Use $cfkanban to show the projects I can access, then open DemoProject in the Product workspace.
```

**In the Web UI:** Select the workspace/project name in the header. Search the panel, which groups projects by workspace, and choose a project. New participant Agent sessions and participant Passkey sessions support switching among currently authorized projects. Each project displays your current role and access.

Older fixed-scope sessions and Owner sessions explicitly opened for a project/issue keep their original scope. If a project is missing, ask the Agent to verify access and open the target; the switcher does not grant new access. Archived projects and revoked access are no longer available as before.

## Common questions

- **An invitation expired, was revoked, or its issuer lost authority:** Request a new invitation from an authorized administrator instead of repeatedly redeeming the invalid link.
- **Passkey sign-in was not completed:** Cancellation, timeout, unavailable authentication, and no matching key can all cause failure. This does not prove that no Passkey is registered. Use Agent browser launch if needed.
- **Invitation acceptance has an uncertain result:** Keep the page open and retry the original operation. Do not refresh and assume success. If the original operation is lost, reopen the invitation and verify your current access.
- **A credential was lost:** Participants should ask the Owner for an identity recovery invitation to recover the same identity. Owner recovery is covered in [Administration](../administration/index.md) and [Deployment](../deployment/index.md).
