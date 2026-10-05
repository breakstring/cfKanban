# Agent integration overview

The same cfKanban Skills work whether you are joining a team or deploying your own site. Once installed, describe your task to the Agent. Extensions in Codex App and DeepSeek Harness add boards and side panels when you want to browse or work visually.

## Do you need a separate installation?

| What you want to do | Next step |
| --- | --- |
| Accept an invitation | Give the Agent the administrator's **complete invitation message**; the [joining workflow](../usage/access.md) reuses or installs Skills as needed |
| Join a public project | Copy the homepage's Agent prompt for the project and follow the guide |
| Deploy your own instance | Go straight to [First deployment](../deployment/first-deployment.md); Skill setup is part of it |
| Connect a new Agent, or prepare your current Agent first | Choose your host below |
| Only use an online site you can already sign in to | No local components are needed; see [Joining and signing in](../usage/access.md) for first identity creation and Passkey registration |

The Agent handles installation when needed and explains local changes. Merely opening an invitation or deployment page does not install software. Trusted, compatible Skills are reused; joining a project does not automatically update them.

## Choose your Agent

- **Codex App desktop client** → [Codex App](./codex-app.md): collaborate through Skills first, then use the workbench and Issue search when needed.
- **Other Agents that load local Skills** → [General Agents](./general.md); the Agent checks this host’s installation and connection support.
- **DeepSeek Harness desktop or Web** → [DeepSeek Harness](./deepseek-harness.md): connect Skills and use the plugin sidebar when needed.

## Let the Agent handle setup

The Agent prepares Skills and supported host connections, then checks that they work. If a UI confirmation or a new session is needed, it tells you what to do. You do not need to write configuration files. Installation does not join a Project or grant access.

Skills are the main way to use cfKanban. Supported hosts also provide workbenches and other extensions; you can keep collaborating through Skills when those views are unavailable. You can also explicitly request a Skills-only installation.

If you have an older installation or only Skills, ask the Agent to [check or complete setup](./general.md). Installation defaults to a stable release; specify the exact version when testing a prerelease.

Once ready, continue with [Joining and signing in](../usage/access.md). If you have already joined, start [working on tasks](../usage/index.md); open a [board](./webui.md) whenever you want to browse it yourself. Installation does not grant project access. An existing Owner moving to another computer should use [Device connections](../administration/devices.md).
