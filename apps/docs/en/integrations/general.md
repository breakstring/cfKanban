# General Agents

For Codex, Claude Code, and other Agents that can load local Skills. If you use [DeepSeek Harness](./deepseek-harness.md), prefer its dedicated plugin.

If you are accepting an invitation or deploying for the first time, continue that guide. **You do not need this separate installation first.**

## Ask the Agent to install

Give this request to the Agent you want to use with cfKanban:

```text
Read the official cfKanban installation guide:
https://github.com/breakstring/cfKanban/releases/latest/download/install.md
Install cfKanban for this Agent, preserve my existing identity, and check that the connection works.
Do not deploy or upgrade an online instance.
```

The Agent chooses an installation method supported by its host, reuses compatible tools, and verifies the source. The default installation includes local components and a supported MCP connection; you do not need to request activation separately. If Node.js is needed or you must open a new session, it explains what to do. Skill directories and reload behavior vary between Agents; you do not need to copy files yourself.

After installation, four Skills should be available: `cfkanban-howto` explains usage, `cfkanban` handles tasks, `cfkanban-admin` manages the application, and `cfkanban-deploy` handles installation, updates, and deployment. They do not grant business permissions. New members should continue with [Joining and signing in](../usage/access.md).

### Already installed from the Codex marketplace?

The Codex Git plugin provides Skill guidance, but does not include the prebuilt local workbench. If the local components are missing, tell the Agent:

```text
I have installed the cfKanban plugin. Check and complete setup for the current version,
preserve my identity and project associations, and tell me if anything still needs my attention.
```

You do not need local page components if you only use the full online Web app. Native plugin support in other hosts depends on that host; do not use Codex installation commands for them.

## What should be ready after installation?

- All four Skills can load.
- If the host supports MCP, it is connected to cfKanban and the Agent has verified the tools. The DSH plugin does not need another MCP entry.
- Local components are ready, so you can ask the Agent to [open the workbench](./webui.md). Project access still requires an identity and permissions.

The Agent handles configuration; you do not need to fill in paths, credentials, or JSON. Some hosts require you to confirm settings or reopen a session, and the Agent gives specific steps. If MCP is unsupported, components are missing, or runtime requirements are not met, the installation result lists what remains incomplete. Skills can still perform supported operations.

If cfKanban is already installed, ask the Agent to complete or check the connection:

```text
Check and complete cfKanban setup for this Agent.
Preserve my identity and other connections, and tell me if I need to do anything afterward.
```

Only read the [MCP connection reference](./mcp.md) if you need to connect another program or configure it yourself.

## Start working and keep it updated

If you have already joined a project, tell the Agent what you want to do, for example:

```text
Show my unfinished tasks in the current project, ordered by priority.
```

You can also [open a board](./webui.md) to browse or make changes yourself. The local workbench is suited to daily tasks; account settings and management use the full online app. If you often work in the same code directory, [associate it with a project](../usage/profile.md) to reduce repeated selection.

When you want to update:

```text
Update my local cfKanban installation to the latest compatible stable release.
Preserve my identity and project associations, and do not upgrade the online instance.
Tell me which sessions or local services need to restart afterward.
```

Local updates and [instance upgrades](../deployment/updates.md) are separate. A new computer, WSL, container, or remote environment has its own installation and identity; do not copy credentials directly. Removing a host connection does not delete online tasks.
