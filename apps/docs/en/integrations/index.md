# Agent integrations

Connect your Agent host to an existing cfKanban instance. This section covers installing and updating Skills, the local MCP, and host plugins; selecting an identity and Project; and opening a task view. You do not need a Cloudflare account to use someone else's board.

| Your host or goal | Guide |
| --- | --- |
| Use the four Skills in a host that supports Skill discovery | [General](./general.md) |
| Configure local stdio MCP or open the local workbench | [General: MCP and workbench](./general.md#local-mcp-and-workbench) |
| Install the plugin in DeepSeek Harness Desktop or Web | [DeepSeek Harness](./deepseek-harness.md) |
| Create, upgrade, or recover the Cloudflare instance itself | [Deployment](../deployment/index.md) |

Skills provide guidance, joining, recovery, management, and deployment workflows. The local MCP exposes bounded tools for daily task operations. DeepSeek Harness adds its own installation adapter and an optional task sidebar using the same local runtime and Vue task view. Installing an integration grants no application or Cloudflare permissions.

## Begin with the host and instance

```text
Check which cfKanban integration this Agent host supports and whether my installed version is compatible with <instance address>.
Keep the check read-only. Explain the installation or connection step I need next.
```

Reuse a trusted, compatible installation. If you have not joined yet, follow [Join and sign in](../usage/access.md); an Owner adding another computer uses [Owner devices](../administration/devices.md). Verify the actual identity and explicit Project scope before working. For everyday task operations, continue with [Usage](../usage/index.md).

## Release availability

Select published stable Skills by default. Historical versions and prereleases require an explicit target. MCP, the local workbench, and the DSH plugin require a release whose verified Skill bundle contains those artifacts. An older stable bundle may not contain them; a source candidate or local test archive does not make them available as an official release. If the selected release is missing an artifact or cannot be verified, stop installation and report that limit.

In the browser, you can keep using the instance's Web UI with your existing access. Installing or updating the host integration is separate from [upgrading the instance](../deployment/updates.md).

## Local and online Web UI

Both views read and write the same trusted online instance with the same permissions, CAS, and business history. The local view is not an offline copy.

| View | Entry and scope | Suitable work |
| --- | --- | --- |
| Local workbench | `web open` defaults to local mode for a Project or Issue; a matching local process serves the self-contained Vue view. | Project switching, board/list, inline priority/status/assignee, Issue details, comments, completion, and copying identifiers, links, or raw Markdown. |
| DSH sidebar | The DSH Host carries that same Vue view through an embedded document and message channel; the browser need not access a separate localhost page. | The same focused task work beside chat, using the Session's verified directory scope. |
| Full online Web UI | Explicit online mode or the local view's **Open full online board** uses the existing temporary Browser Launch for the verified target. | The complete board and account, Project/Workspace management, members, permissions, and settings within your access. Cloud deployment still uses [Deployment](../deployment/index.md). |

Local assets require the installed runtime and an owning process; updates need a restart. Missing artifacts or a startup failure are reported without silently switching online. Use [General](./general.md#local-mcp-and-workbench) for local opening, or [DeepSeek Harness](./deepseek-harness.md) for its sidebar.
