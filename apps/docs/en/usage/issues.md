# Find, create, and edit issues

An Issue is a unit of work, identified by a number such as `CFK-123`. Numbers are unique within an instance and are never reused. Include the site when referring to work across instances.

## Find existing work

```text
Use $cfkanban to show issues assigned to me in DemoProject that are neither done nor canceled. Include their identifiers, statuses, and priorities.
```

```text
Find issues with “login” in the title in DemoProject. List the results without changing anything.
```

You need read access to the target project. The Agent should state the projects it searched and return matching issues. Search covers titles and identifiers, not full-text searches of comments or attachments. If project names are ambiguous, check their workspace first.

**In the Web UI:** Open the project board, enter a title or identifier in the search box, choose priority or Label filters as needed, and select **Search**. Each status column loads independently. Column counts show loaded issues; scroll a column or select **Load more** to continue.

For multiple projects, select **Work list** in the header. Choose 1–20 projects, select **All issues** or **My tasks**, set the status, assignee (including unassigned), priority, Label, or title/identifier filters, and select **Show work**. Apply the filters again after changing them. Opening this page does not automatically load every project's issues.

## Filter by priority, assignee, status, and Label

```text
Use $cfkanban to show my high-priority todo Issues in DemoProject.
```

```text
Show unfinished Issues in DemoProject tagged bug or performance. Show one page first, and state the Project and filters used.
```

These filters require a deployed Service implementing Issue query filters and schema 13; updating your local Skills does not upgrade the instance. Choose a Project before resolving its Label names. In a multi-project Work list, identical Label names belong to separate Projects; select the Labels for each intended Project.

Within one filter, multiple choices mean **any** (OR); different filters must **all** match (AND). For example, “high or urgent” plus “todo” matches either priority, only in todo. “bug or performance” matches either Label, not necessarily both. “Unfinished” includes Backlog, Todo, and In progress. Candidates are specifically todo work; they do not include all unfinished Issues.

Select explicit Projects and filters before loading pages, then request more only as needed. The server filters before pagination. Indexes help avoid unrelated reads, but the benefit depends on the combination and ordering; they also add storage and write cost. A small page does not guarantee equally few database rows read, and title/identifier substring searches can still require extra reads.

### API examples for Agent authors

Send each JSON object below to `node scripts/cfkanban-tool.mjs api request` through stdin from the installed daily Skill directory. No Credential belongs in the input. All UUIDs below are examples: replace `111…` with the trusted instance, `222…` with the Workspace, `333…` with the Project, `444…` with your Principal, and `555…` / `666…` with the bug / performance Label IDs actually returned by that Project.

Ordinary lists accept repeated `status` keys (up to 5), `assignee` Principal UUIDs or `unassigned` (up to 20, mixed values use OR), `priority` keys (up to 5: `urgent`, `high`, `medium`, `low`, `none`), and `label` UUIDs (up to 20). Candidates accept the same priority/Label filters. Use repeated URL parameters, not comma-separated strings. `limit` is 1–100, default 20.

### Resolve Label names in the selected Project

For “Find unfinished Issues tagged bug or performance in DemoProject”, first read that exact Project's active Labels. Follow `has_more` / `next_cursor` if needed, match the returned name exactly (ASCII case-insensitive, consistent with SQLite `NOCASE`), and use its stable Label ID. Do not guess a UUID or search unrelated Projects. Resolve the same name separately in each selected Project; a Label ID belongs to one Project. Unknown, inaccessible, or deleted Label IDs contribute no matches and do not reveal why.

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/labels?limit=100"}
```

### My high-priority todo Issues

“Show my high-priority todo Issues in DemoProject.” Resolve “me” through `/api/v1/me`; ordinary lists require the Principal UUID, not `assignee=mine`.

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/issues?project=33333333-3333-4333-8333-333333333333&status=todo&assignee=44444444-4444-4444-8444-444444444444&priority=high&limit=20"}
```

### Unfinished Issues with either Label

“Show unfinished Issues tagged bug or performance in DemoProject.” This includes `backlog`, `todo`, and `in_progress`, matching either Label. Repeated Labels mean **any**, not “must have every Label”.

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/issues?project=33333333-3333-4333-8333-333333333333&status=backlog&status=todo&status=in_progress&label=55555555-5555-4555-8555-555555555555&label=66666666-6666-4666-8666-666666666666&limit=20"}
```

### Unassigned Issues and work candidates

“Show all unassigned Issues in DemoProject, regardless of status.” The ordinary Project list uses `assignee=unassigned`; it can include started and terminal work. Add repeated `status` parameters when only unfinished work is wanted.

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/issues?assignee=unassigned&limit=20"}
```

“Find unassigned, unblocked todo candidates tagged bug with high or urgent priority in DemoProject.” Candidates always select `todo` work in the server-defined candidate order and require exactly one `assignment=mine|unassigned|needs_reassignment`. Do not substitute ordinary `status` or `assignee` parameters. `needs_reassignment` finds assignments whose Principal has lost eligibility; it is different from unassigned.

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/issues/candidates?project=33333333-3333-4333-8333-333333333333&assignment=unassigned&blocked=exclude&priority=high&priority=urgent&label=55555555-5555-4555-8555-555555555555&limit=20"}
```

### Continue the same search

“Show the next page of that unfinished bug-or-performance search.” Use the previous response's `next_cursor` only when `has_more=true`. The example below uses `CURSOR_FROM_PREVIOUS_RESPONSE` as a placeholder: replace it with the actual cursor, URL-encoded once. Keep the original scope and filters; start without a cursor after changing any condition. Check `resolved_scope` and, for candidates, `resolved_scope.candidate_policy` rather than inferring the effective scope.

```json
{"instanceId":"11111111-1111-4111-8111-111111111111","method":"GET","apiPath":"/api/v1/issues?project=33333333-3333-4333-8333-333333333333&status=backlog&status=todo&status=in_progress&label=55555555-5555-4555-8555-555555555555&label=66666666-6666-4666-8666-666666666666&limit=20&cursor=CURSOR_FROM_PREVIOUS_RESPONSE"}
```

## Create an issue

```text
Use $cfkanban to create “Fix mobile login error” in DemoProject.
Description: Submitting the login form on a small phone screen produces an error. Reproduce and fix it.
Put it in Backlog with high priority, then tell me its issue number.
```

You need writer access, administration of the relevant scope, or Owner access. The result is one issue and its stable identifier. Creating the issue does not execute the work described in it.

**In the Web UI:** Project board → **New issue** → enter the title, description, status, and priority → **Save**. Descriptions support Markdown. New issues cannot start in Done; use the [completion action](./workflow.md) once the work is actually complete.

## Edit the title or description

```text
Change CFK-123's title to “Fix mobile login timeout”.
Append this reproduction condition to its description: First login after switching networks. Preserve the rest of the content.
```

You need write access. The Agent should change only the requested content and verify the saved result. Asking it to perform the work is a separate request, such as “Fix the problem described in CFK-123.” Editing the description does not complete the development work.

**In the Web UI:** Open the issue card → **Edit issue** → update the title or description → **Save**. Text is not saved automatically as you type.

## Set or clear priority

```text
Set CFK-123 to urgent priority. Keep its status and assignee unchanged.
```

```text
Clear CFK-123's priority.
```

The priorities are None, Low, Medium, High, and Urgent. You need write access. Priority changes do not change status or assignment.

**In the Web UI:** Use the priority selector on a board card or **Priority** in the issue's properties. Choose **None** to clear it. You do not need to open the title/description editor.

## Common questions

- **No create or edit button:** You may have reader access, or your session may have expired. Check the project, identity, and expiry shown in the header.
- **Someone else changed the issue:** Read the latest content before deciding whether to save again. The page preserves your unsaved draft and does not overwrite another person's changes automatically.
- **Saving timed out:** Avoid creating the same issue repeatedly. Ask the Agent to verify the original operation, or use the page's retry/verification action before trying another operation.
- **An issue is missing:** Check project scope, filters, and whether it was deleted. See [Collaboration and attachments](./collaboration.md) for restoration.

Next: [Assign, progress, and complete work](./workflow.md).
