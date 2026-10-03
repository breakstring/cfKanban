# Start here

cfKanban is a shared task board for people and Agents. Ask an Agent to record and move work forward, or browse, edit, and discuss it yourself in the Web UI. Both use the same tasks and permissions.

## What would you like to do?

| Your situation | Continue here |
| --- | --- |
| You received a team invitation or want to join a public project | [Joining and signing in](../usage/access.md): give your Agent the complete invitation message or the joining prompt from the homepage |
| You have joined and want to work on tasks | [Daily collaboration](../usage/index.md) or [Open a board](../integrations/webui.md) |
| You manage a workspace, project, or its members | [Manage workspaces and projects](../administration/index.md): work within your management scope without deploying a site |
| You want your own cfKanban site | [Owner getting started](../deployment/index.md): prepare, deploy, and maintain your instance |
| You only want to set up your current Agent | [Installation and connections](../integrations/index.md): general Skills or the DSH plugin |

**Joining for the first time and deploying for the first time both include Skill setup when needed.** Start with the relevant guide; you do not need a separate installation tutorial first. A compatible installation is reused. Installing Skills alone does not join a project or create cloud resources.

## How these docs are organized

- **Get started:** shared setup, opening boards, and basic concepts.
- **Join and use:** daily collaboration for members and administration for workspace and project managers.
- **Deploy and manage:** instance settings, devices, upgrades, and recovery for the Owner.

Once installed, describe your task directly to the Agent:

```text
Show my unfinished tasks in DemoProject, ordered by priority, and open the board.
```

Replace `DemoProject`, `CFK-123`, and angle-bracket placeholders with your targets. Examples can make real changes, so only send requests you want carried out.

The homepage and application footer both have a **Docs** link, so you do not need to leave the board. These docs ship with the site; local Skills and the site update separately. If an entry point differs, ask the Agent to check the version and your permissions. For the difference between an instance, workspace, and project, see [Concepts and roles](./concepts.md).
