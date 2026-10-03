# Installation and connections

The same cfKanban Skills work whether you are joining a team or deploying your own site. Usually, you can let the Agent prepare what your current goal needs without learning about packages, MCP configuration, or plugin internals first.

## Do you need a separate installation?

| What you want to do | Next step |
| --- | --- |
| Accept an invitation | Give the Agent the administrator's **complete invitation message**; the [joining workflow](../usage/access.md) reuses or installs Skills as needed |
| Join a public project | Copy the homepage's Agent prompt for the project and follow the guide |
| Deploy your own instance | Go straight to [First deployment](../deployment/first-deployment.md); Skill setup is part of it |
| Use an existing identity in a new Agent, or prepare the Agent first | Choose your host below |
| Only use an online site you can already sign in to | No local components are needed; see [Joining and signing in](../usage/access.md) for first identity creation and Passkey registration |

The Agent handles installation when needed and explains local changes. Merely opening an invitation or deployment page does not install software. Trusted, compatible Skills are reused; joining a project does not automatically update them.

## Choose your Agent

- **Codex, Claude Code, and other Agents that support Skills** → [General Agents](./general.md).
- **DeepSeek Harness desktop or Web** → [DSH plugin](./deepseek-harness.md), which installs Skills, MCP, and the sidebar together.

## Does MCP need a separate installation?

**No. When installing cfKanban, the Agent configures and verifies a supported MCP connection by default.** The DSH plugin includes this step; in other hosts, the Agent uses that host's supported configuration method. You only need to follow instructions for a UI confirmation or a new session. You do not need to write configuration files.

| Component | Purpose | Who handles setup |
| --- | --- | --- |
| Skills | Guide the Agent through tasks, joining, administration, and deployment | The Agent installs them in the current host |
| Local MCP | Provides task queries, edits, comments, and other tools to MCP clients | The complete package includes the server; the Agent configures and verifies the host connection by default, or the DSH plugin connects it |
| Local workbench | Lets you view and use a board beside your Agent | Included in the complete package and started when needed; DSH uses its sidebar |

Let the Agent handle installation, connection, and availability checks. Hosts without MCP support can still use cfKanban through Skills, and the Agent explains any limitations. You can also explicitly request Skills only. Connecting MCP does not join a project.

If you have an older installation or only the Git plugin, ask the Agent to [complete local setup](./general.md). The local workbench, MCP, and DSH plugin require a release containing those capabilities. Installation defaults to a stable release; specify the exact version when testing a prerelease.

For another MCP client or your own program, see the [MCP connection reference](./mcp.md). Ordinary users do not need this technical reference.

Once ready, continue with [Joining and signing in](../usage/access.md) or [Open a board](./webui.md). Installation does not grant project access. An existing Owner moving to another computer should use [Device connections](../administration/devices.md).
