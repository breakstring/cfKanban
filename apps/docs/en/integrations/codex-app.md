# Codex App

Use cfKanban in Codex App to browse a full-size board, open Issue details beside your conversation, or find an Issue from the `@` menu and discuss it with the Agent. The native workbench requires a desktop client that supports [Plugin Extensions](https://developers.openai.com/plugins/build/extensions). It uses this computer's cfKanban identity, with the same tasks and permissions as the online Web app.

[![The cfKanban board fills the Codex App workbench, with Project selection and Kanban columns](../../assets/integrations/codex-app-full.png)](../../assets/integrations/codex-app-full.png)

*Full-size board in Codex App; click the image to open the original. The screenshots on this page illustrate layouts; their example tasks and language do not determine your Project or settings.*

::: info Check the installed version
The workbench needs the complete local components, and identifier/title search also needs a Service that supports search-index synchronization. Check the components actually running on the computer you use. Updating the local plugin does not upgrade the online instance; screenshots and source checks do not replace installation and update checks. Include an exact version when requesting a prerelease.
:::

## Installation and checks

For a first installation, follow the shared path in the [integration overview](./index.md). An invitation or first deployment can prepare the components as part of its own guide. If you already installed the Codex Git plugin or marketplace entry, ask:

```text
I installed the cfKanban plugin in Codex App. Check and complete this version's local integration,
preserving my identity, Project associations, and other connections. Verify whether the native
workbench is available and tell me which conversations or apps need reopening.
Do not deploy or upgrade the online instance.
```

The Git plugin's Skills and the complete release bundle's local components are checked separately. Loading Skills does not prove the native workbench is ready. The Agent checks the actual components, connection, and entrypoints, then reports any remaining steps. You do not enter cfKanban credentials in configuration. Installation grants no Project access; new members continue to [join and sign in](../usage/access.md).

## Choose a workbench entrypoint

| Entry | How to open it | How it chooses a Project |
| --- | --- | --- |
| Global workbench | Open cfKanban from the client's global navigation | Recheck the last global Project; otherwise open an accessible default under the current identity |
| Conversation workbench | Select cfKanban in the conversation panel, or ask the Agent | Use an explicitly requested Project or Issue first; with trusted repository context, otherwise use that repository's last Project or verified recommendations |

Ask the Agent to open the current conversation's workbench:

```text
Open the cfKanban workbench beside this conversation and verify the current identity and Project.
```

To open a specific Issue, name its complete identifier:

```text
Open the details of CFK-123 in the Codex workbench and verify the displayed identifier and Project.
```

[![CFK-600 details appear beside the conversation in the Codex App side panel](../../assets/integrations/codex-app-sidebar.png)](../../assets/integrations/codex-app-sidebar.png)

*Issue details beside a conversation; click the image to open the original. Check the identifier and Project shown in the workbench.*

The Agent resolves the exact instance and Project, then opens the requested Issue after checking identity and access. Missing access or a mismatched target produces an error instead of another Issue or the board. You can also name a Project. Opening a view does not edit tasks, and a successful tool call alone does not prove the requested page is visible: check its identifier and Project.

The board and list prefer fullscreen when the client supports it. The client controls the final layout and may show the workbench inline. When available, **Expand workbench** opens the larger view; leaving it preserves the current Project and page. A conversation side panel is a client layout, not a separate display mode. Manual opening does not prove that repository context was detected, and requesting an Issue does not force a particular layout.

For an ordinary browser or the full online app, request that surface explicitly and see [Open a board](./webui.md). Asking to open the native workbench does not install a plugin.

## Switch Projects and reopen

Open the current Project selector to browse accessible Projects grouped by Workspace in the verified instance. Continue through pages when more Projects are available. The board switches only after successful verification; a failed selection keeps the current Project. Repository recommendations guide the initial selection and do not restrict later access to other authorized Projects.

- The **global entry** independently remembers the last successfully selected local Project, separate from conversations and repositories.
- A **conversation entry opened by the Agent with trusted repository context** remembers that repository's last successful Project, including another accessible Project selected in the UI. Subdirectories of one worktree share this choice; different worktrees remain separate.
- A **conversation entry without repository context** does not read the global preference. A single verified local connection opens an accessible default; several unresolved connections require selection.

Every reopening checks identity, the Project's Workspace, and current access. Project preferences save only the Project. To reopen details, request the Issue explicitly again. They do not change [directory associations](../usage/profile.md) or CLI defaults, grant access, or restore filters, drafts, or previous writes. An invalid explicit Project or saved directory default produces an error instead of silently selecting another Project.

## Mention an Issue in a conversation

Both the local components and target instance must support Issue reference reads. When the client actually exposes the cfKanban mention entry:

1. Type `@` in the composer and **select `cfkanban-search`**. Its description says it searches cfKanban Issues by number or title. Some client menus may group it under the plugin's display name.
2. Confirm that the composer shows the entry's name token, then enter `CFK-123`, a number prefix such as `CFK-12` / `12`, a title fragment such as `plugin search`, or a canonical Issue link from a trusted connected instance.
3. Click the returned Issue candidate, add a request such as “Summarize this Issue,” and send.

[![The selected cfkanban-search entry returns Issue candidates for the title fragment 看板, showing identifiers, titles, and Project context](../../assets/integrations/codex-search.png)](../../assets/integrations/codex-search.png)

*After selecting the entry, type a title fragment and choose a matching Issue to add its reference. Click the image to open the original.*

Typing the entire string `@cfkanban-search CFK-123` does not select the entry automatically and can remain in global search. The search entry is distinct from the `cfkanban-mcp` connection name you may see in **Sources** or settings.

Exact identifiers rank first. Number prefixes need at least two digits and title fragments at least two characters. Up to ten candidates show the identifier, title, Workspace and Project. Title matching is case-insensitive; bodies and Comments are not searched.

Candidates come from a persistent local cache, so each input does not wait for a network refresh or permission check. On a new computer, background preparation starts when MCP initializes with a single local connection. Until ready, the client may show no candidates; enter the query again after preparation finishes. An already open list does not refresh automatically, and reopening reuses the existing index.

While search is active, background synchronization checks changes every 30 seconds. It stops after five minutes without search and resumes when you search again. Local changes to titles or other indexed fields request a background refresh. With multiple connections, choose the instance using a trusted Issue link.

Each synchronization checks accessible Projects. Newly granted Projects receive their existing Issues before incremental updates; search temporarily returns no candidates while this preparation runs. Revoked Projects are removed after synchronization confirms the change. A recently renamed, deleted or revoked Issue can briefly remain in the list; reading a selected reference checks live access and rejects inaccessible or deleted content. Instances and users have separate caches; keep active cache files out of cloud-drive synchronization.

Selecting a mention lets the Agent read the Issue's main fields and body under current permissions; oversized content is marked as truncated. Comments, relations, and further details are read separately when needed. The reference does not create an Issue, change its status, start work, or grant authorization. An ambiguous identifier across multiple instances needs an exact trusted Issue link; the integration does not search every instance.

If the client has no mention entry, give the identifier directly to the Agent:

```text
Read CFK-123 and explain its current status, goal, and anything that needs my decision.
```

You can also copy an identifier, online URL, or original Markdown from the workbench. It does not automatically send chat messages. Business Issue deep links in Codex are not provided.

## Everyday work and recovery

The workbench provides Kanban and list views, details, authorized Issue creation and editing, priority/status/assignee/Label changes, Comments, and completion records. Account, member, and Owner administration uses the [online management pages](../administration/index.md). Language and theme prefer saved account settings. Without a language preference, the host or browser language is used, with Simplified Chinese for Chinese locales.

For an uncertain write, use **Recover** in the original page first. Keep that page and its MCP process until recovery finishes. A new entry, reopening, or remembered Project does not prove the original write failed, restore it, or replay it automatically.

## Installation and update FAQ

**Skills load, but there is no workbench entry.** Ask the Agent to check the client's Extensions support, the complete local components, and the MCP connection. Clients without native UI can still use discovered business tools or Skills; choose the browser workbench when needed. A client name alone does not establish support.

**The mention entry is selected, but there are no Issue candidates.** Check the identifier or title length and whether the initial index is still being prepared. Ask the Agent to check the running MCP version, connection, background synchronization errors and Project access. A Skills or plugin version does not prove that MCP loaded the same version. After an update, verify the new artifact path and reconnect.

**The view opens, but there is no Project.** Check identity, connection, and [Project access](../usage/access.md) first. Multiple connections need selection; installing components does not join a Project.

**Issue mentions report unsupported capability.** `MCP_ISSUE_REFERENCE_UNSUPPORTED` means the target instance does not provide reference reads, rather than “no matching Issue.” A local update does not automatically upgrade the instance. Ask the Agent to check both versions; instance changes follow the separate [upgrade workflow](../deployment/updates.md).

**Search indexing reports unsupported capability.** `MCP_SEARCH_INDEX_UNSUPPORTED` means the Service does not provide index synchronization. An older instance cannot support the new local title search. Check both the local components and instance version; updating a plugin does not automatically update the online Service.

**Why did reopening not restore the Issue or draft?** A Project preference selects the Project again. Request a complete Issue identifier to open its current details explicitly. Each fresh entry creates an independent view; filters, drafts, and uncertain writes do not transfer. Verify any earlier uncertain operation first.

**The UI still looks old after an update.** Resolve uncertain writes in the original view, ask the Agent to update the local installation, close the old workbench, restart its MCP, and reopen from the entrypoint. Refreshing an old view alone does not prove new components loaded.

```text
Update the local cfKanban installation in Codex App to the latest compatible stable release,
preserving my identity and Project associations. First check for uncertain workbench operations;
after updating, verify the running version and explain which connections need restarting.
Do not upgrade the online instance.
```

**Initialization failed or the connection expired.** Share the displayed error code with the Agent to check the running version, connection, and client. An initialization error does not mean you have not joined. Reopen after earlier writes have a known result; verify uncertain results first. Codes, stdio configuration, and the workbench protocol are in the [MCP reference](./mcp.md#workbench-protocol-reference).

Disabling or removing the host integration does not delete online tasks. Local updates and [instance upgrades](../deployment/updates.md) are separate.
