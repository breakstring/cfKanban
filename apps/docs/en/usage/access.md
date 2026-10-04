# Joining and signing in

Joining a project determines what you may do. Signing in determines the browser session you use to access it. Opening the public homepage does not create an identity or grant project access.

## Accept a project invitation

Give your Agent the administrator's **complete invitation message**. It contains the invitation link and joining guide. On first use, the Agent can prepare Skills through that guide; you do not need to install them beforehand.

```text
Join the project using the invitation message below.
<paste the complete invitation message>
```

If the Skills are already installed, simply send the invitation message; the Agent reuses compatible Skills. If you only received a link, ask the administrator to copy the complete invitation message again.

You need a valid invitation. First-time use may require a display name; if you already have an identity, the Agent checks whether it can be reused.

An ordinary invitation grants reader or writer access to specific projects, not administrator access. Invitations can be redeemed once. Accepting an ordinary invitation does not overwrite an existing active role. Contact a project administrator to change an existing role.

**In the Web UI:** An already signed-in non-Owner participant can open an ordinary invitation, check the displayed identity, projects, and roles, then explicitly accept it as the current identity. Opening the link alone does not accept it. If the current session cannot cover every target, acceptance fails without joining only some of the projects; use the Agent path instead.

Creating a first identity, recovering one, and connecting an Owner device use their dedicated Agent workflows. An ordinary invitation cannot recover your lost existing identity.

## Join a public project

```text
I want to join DemoProject, listed on the homepage at <site address>, as a reader.
```

If the Skills are not installed, use the homepage's complete generated prompt. The joining guide prepares them when needed; you do not need a separate installation first.

The Owner must have enabled Public Join for the project. Choose one public project at a time and explicitly select Reader or Writer. The easiest approach is to use the homepage's generated Agent prompt for that project and role; it includes the exact target and joining guide in your language.

After confirmation and a successful join, you receive access to that project. Public Join does not grant an entire workspace. Joining can fail if the project is full or its public entry has closed.

**In the Web UI:** Select a project and role in the homepage's public project list. While signed out, copy its Agent prompt. After signing in with a Passkey, you can join directly and enter the board. Selecting Reader when you are already a Writer does not downgrade your access. An existing Reader can select Writer while the public entry remains open.

## Ask an Agent to open an authenticated page

The following instructions are for the full online app. Ask your Agent to handle daily tasks directly; when you want to see them yourself, you can also [open the local workbench](../integrations/webui.md). Neither opening method requires a Passkey to be registered first.

```text
Open the full online board for DemoProject in my browser.
```

```text
Open the online page for CFK-123 in IAB.
```

You need a usable local identity, access to the target, and browser delivery supported by your host. The Agent verifies the site and identity, then opens an authenticated page through the dedicated entry point. If the requested browser is unavailable, it should explain the problem instead of silently choosing another.

The Agent's Browser Launch link can be exchanged once within five minutes. The resulting browser session starts with eight hours and, on an instance that supports activity renewal, follows the rules below. Do not copy long-lived credentials into a page or chat.

When the current address differs from the site’s recommended address, the footer also shows a link to that address. It does not redirect you automatically; changing the address does not transfer your current sign-in.

**In the Web UI:** Use your current session while it remains valid. After expiry, ask the Agent to open a fresh one or sign in with a registered Passkey. If browser delivery fails, ask the Agent to check the delivery path; do not create a second identity solely because of that failure.

## Sign in with a Passkey

```text
Open the online board for DemoProject.
```

Once your Agent opens the online board, you can register a Passkey on the page. You do not need to state that purpose in the request or open a dedicated management entry. Both first and additional registrations require an Agent-opened online session. A session created by signing in with an existing Passkey cannot register another one; ask the Agent to reopen the online page when needed. You complete registration through the browser or operating system. The Agent cannot replace your biometric check, security key interaction, or system confirmation.

**In the Web UI:** Account menu at the top right → **Personal settings** → **Register Passkey**. For later visits, use **Use Passkey** at the top right of the same site's homepage and follow the system prompt. While your current session remains valid, this button reads **Open workbench** and returns to its authorized entry without another Passkey prompt. Participants then choose an authorized project; the Owner enters the management overview.

A Passkey authenticates you to the Web UI. It grants no project access and does not replace the Agent's local credential. It is associated with the hostname where you registered it. If the site moves to another hostname, ask the Agent to open the new address and register there. See [Profile](./profile.md) for revocation.

## Stay signed in and recover text drafts

Sessions opened by an Agent and sessions created with a Passkey follow the same rules. Real mouse, keyboard, or touch activity in the visible page, including editing, can automatically renew a valid session. Each renewal sets the expiry to eight hours from that renewal, up to an absolute limit of seven days from the session's original creation. Each session can actually extend at most once every 30 minutes. Renewal keeps the same identity, sign-in source, and access scope.

Background polling, hidden tabs, refreshing the page, and merely focusing or showing it do not renew the session. When the session expires, the page asks you to sign in again. Older instances without renewal information keep the fixed eight-hour expiry; the Agent's installed Skill version does not establish whether an instance supports renewal.

On a renewal-capable instance, a new sign-in keeps its Session and CSRF cookies for up to seven days, while the server still enforces the current eight-hour expiry and revocation. Renewal does not rewrite cookies, so a delayed renewal response cannot replace a newer sign-in. Cookies issued before the instance upgrade retain their original eight-hour deadline; sign in again after that deadline to use the full renewal period.

After expiry, sign-out, or revocation of the sign-in source, sign in again with a registered Passkey or ask the Agent to reopen the page. Keep the original page open if it offers an unsubmitted text draft for recovery. These business text drafts remain only in that page's memory: refreshing or closing it loses them, and explicit sign-out clears them. After signing in as the same identity, explicitly restore or copy the text, review the current state, and decide whether to submit. Signing in as another identity does not automatically restore it, and signing in never automatically replays a write. Draft recovery excludes credentials, sign-in or invitation links, and attachment files.

```text
Reopen this project in the full online app with my current identity. Keep my original page open so I can recover its text draft; do not resubmit the previous write.
```

## Switch projects

```text
Show the projects I can access, then open DemoProject in the Product workspace.
```

**In the Web UI:** Select the workspace/project name in the header. Search the panel, which groups projects by workspace, and choose a project. New participant Agent sessions and participant Passkey sessions support switching among currently authorized projects. Each project displays your current role and access.

If an expected project is missing, ask the Agent to check access and open it again. Archived projects and revoked access are no longer available.

## Common questions

- **An invitation expired, was revoked, or its issuer lost authority:** Request a new invitation from an authorized administrator instead of repeatedly redeeming the invalid link.
- **Passkey sign-in was not completed:** Cancellation, timeout, unavailable authentication, and no matching key can all cause failure. This does not prove that no Passkey is registered. Use Agent browser launch if needed.
- **Invitation acceptance has an uncertain result:** Keep the page open and retry the original operation. Do not refresh and assume success. If the original operation is lost, reopen the invitation and verify your current access.
- **A credential was lost:** Participants should ask the Owner for an identity recovery invitation to recover the same identity. Owner recovery is covered in [Administration](../administration/index.md) and [Deployment](../deployment/index.md).
