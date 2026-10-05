# Codex App

In a Codex desktop client that supports [Plugin Extensions](https://developers.openai.com/plugins/build/extensions), cfKanban provides a global workbench and a workbench beside a conversation. Both use the same local MCP connection and this computer's cfKanban identity, with the same tasks and permissions as the online Web app.

::: info Check the installed version
The native workbench needs a complete verified local bundle and a client that supports its entrypoints. Identifier and title search also requires new components with a persistent search index and a Service supporting index synchronization. This page describes source behavior and does not prove a new release has been published or the instance upgraded. Older installed RCs do not gain these capabilities automatically. Source checks do not replace desktop installation and update acceptance.
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
| Global workbench (`global`) | Open cfKanban from the client's global sidebar | Reverify the last successfully selected global Project; without a valid preference, open an accessible default under the current identity |
| Conversation workbench (`thread`) | Select cfKanban in the conversation panel, or ask the Agent | An Agent opening can use the conversation's trusted repository context, preferring an explicit Project or Issue, then the repository's last Project or verified recommendations |

Ask the Agent to open the current conversation's workbench:

```text
Open the cfKanban workbench beside this conversation and verify the current identity and Project.
```

To open a specific Issue, name its complete identifier:

```text
Open the details of CFK-123 in the Codex workbench and verify the displayed identifier and Project.
```

The Agent resolves the exact instance and Project and passes the identifier to the conversation entry. The workbench loads that Issue as its initial page after checking current identity, access, and Project membership. Missing access or a mismatched target produces an error instead of opening another Issue or the board. Issue selection does not force a sidebar layout and is separate from mentions or official Codex URL deep links.

You can also name the Project you want. An Agent tool call and a manual conversation-panel selection are different triggers; the client decides where the result appears. A manual entry is not evidence that the repository was detected. Check the displayed identity and Project after opening. A successful entry call or a snapshot containing the Issue confirms prepared data, not visible rendering. Check the actual displayed identifier and details.

The workbench requests fullscreen initially; the client may still choose inline display. When available, **Expand workbench** requests fullscreen from inline. Leaving fullscreen preserves the current Project and page without repeatedly expanding again. The conversation side panel is a client layout entrypoint. The display modes are only `inline` and `fullscreen`, with no third “sidebar mode.” Available controls and the final layout depend on the client.

For an ordinary browser or the full online app, request that surface explicitly and see [Open a board](./webui.md). Asking to open the native workbench does not install a plugin.

## Switch Projects and reopen

Open the current Project selector to browse accessible Projects grouped by Workspace in the verified instance. Continue through pages when more Projects are available. The board switches only after successful verification; a failed selection keeps the current Project. Repository recommendations guide the initial selection and do not restrict later access to other authorized Projects.

- The **global entry** independently remembers the last successfully selected local Project, separate from conversations and repositories.
- A **conversation entry opened by the Agent with trusted repository context** remembers that repository's last successful Project, including another accessible Project selected in the UI. Subdirectories of one worktree share this choice; different worktrees remain separate.
- A **conversation entry without repository context** does not read the global preference. A single verified local connection opens an accessible default; several unresolved connections require selection.

Every reopening rechecks the recorded identity, Project's Workspace, and current access. Project preferences save only the Project, never an Issue identifier. To reopen a detail page, request the Issue explicitly again. Project preferences do not edit [directory associations](../usage/profile.md) or saved CLI defaults, grant access, or restore filters, selected Issues, drafts, or previous writes. An invalid explicit Project or saved directory default produces a concrete error instead of silently selecting another Project.

## Mention an Issue in a conversation

Both the local components and target instance must support Issue reference reads. When the client actually exposes the cfKanban mention entry:

1. Type `@` in the composer and select the cfKanban search entry. New components supply the `cfkanban-search` name and a search description; some client menus may use the plugin's display name.
2. Confirm that the composer shows the entry's name token, then enter `CFK-123`, a number prefix such as `CFK-12` / `12`, a title fragment such as `plugin search`, or a canonical Issue link from a trusted connected instance.
3. Click the returned Issue candidate, add a request such as “Summarize this Issue,” and send.

Typing the entire string `@cfkanban-search CFK-123` does not select the entry automatically and can remain in global search. Exact identifiers rank first. Number prefixes need at least two digits and title fragments at least two characters. Up to ten candidates show the identifier, title, Workspace and Project. Title matching is case-insensitive; bodies and Comments are not searched.

Candidates come only from the persistent local cache, without waiting for a network permission check or refresh on each input. A new computer first prepares its index in the background. Until ready, the search returns a preparation state that the client may show as no candidates. Enter the query again after completion; an already open candidate list is not refreshed automatically. Reopening reuses the existing index. Background synchronization starts after MCP initialization when there is a single local connection; with multiple connections, select an instance using a trusted Issue link. It checks changes every 30 seconds while search is active, and stops after five minutes without search. Using search again resumes background synchronization. Local changes to indexed fields also request a background refresh.

Each synchronization checks the currently accessible Projects. A newly authorized Project receives a complete snapshot of its existing Issues before incremental updates; while that snapshot is being prepared, the entire search index temporarily returns no candidates. Revoked Projects are removed after synchronization confirms the change. A recently renamed, deleted or revoked Issue can temporarily remain in the candidate list; selecting it reads details under live authorization and rejects inaccessible or deleted content. Instances and users have separate caches; do not synchronize an active cache file through a cloud drive.

Selecting a mention lets the Agent read the Issue's main fields and body under current permissions. An oversized body is marked as truncated. The Agent reads Comments, relations, and current changes separately when needed. A mention does not create an Issue, change its status, start work automatically, or supply repository, conversation, or Project authorization. With multiple instances and an ambiguous identifier, choose the instance using an exact trusted Issue link; the integration does not search every instance.

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
