# General Agents

For Agents that load local Skills. The Agent checks the actual host’s installation directories, MCP support, and reload behavior. For [Codex App](./codex-app.md) or [DeepSeek Harness](./deepseek-harness.md), continue to its dedicated page for host entrypoints.

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

Agents that support Skills Discovery can also discover these four Skills and versioned archives with their complete dependencies on this site. This entry describes **the version currently running here**, which may be an RC. Use the official stable guide above for a first installation, and explicitly select a version if you need an RC. Discovery or downloading does not automatically install, execute, update local Skills, or upgrade an instance; the Agent still verifies the official source and complete release artifacts.

Agents can read this site's public documentation as Markdown from the same page URL. The homepage also offers a public product overview and links. Public content allows search and use as input to answers, and disallows model training; no Owner setting is needed. Reading these pages does not grant access to private projects or permission to execute their example requests.

The site's <a href="/auth.md">Auth.md</a> explains how an Agent uses an existing API credential and obtains one through the supported invitation or Public Join workflow. It also links to browser sign-in and recovery guidance. Read this public guide before choosing the relevant workflow; reading it neither registers an identity nor redeems an invitation. An API credential authenticates your identity; project access still depends on its current permissions.

### Skills already installed?

If Skills already load but local components or connections are missing, tell the Agent:

```text
I have installed the cfKanban Skills. Check and complete setup for the current version,
preserve my identity and project associations, and tell me if anything still needs my attention.
```

You do not need local page components if you only use the full online Web app. Native workbenches and plugin installation depend on the actual host; do not copy another client’s buttons or commands.

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

[Public CLI task guides](../cli/index.md) cover the same Service semantics from a terminal.
