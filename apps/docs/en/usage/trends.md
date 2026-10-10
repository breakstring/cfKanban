# Issue trends

In the Web app, open **Trends** in a Project, or use **Workspace settings → Trends** as its Owner or Workspace administrator to see unfinished Issue stock and daily creation/completion counts. In a Project, select a milestone to compare its total scope with its currently done scope over time. Charts count Issues, not estimated effort; a parent and its children each count independently.

The **Milestone progress** chart uses burn-up counts: total scope and currently done stock. A burndown chart would show remaining work. The two lines make scope changes visible. Hover or focus a date with the keyboard to read its values.

## Dates and counts

The default window is 30 UTC calendar days, including today. You can request 1–365 days. Past stock points represent the end of that UTC day; today's point stops at the displayed observation time and its flow counts are still growing.

- **Unfinished** includes backlog, todo and in progress. Done and canceled are separate; canceled work is not completed work.
- **Created** counts Issue creation on that day. Restoring an Issue or moving it into a milestone does not create another Issue.
- **Completed** counts transitions into done. Completing an Issue, reopening it and completing it again records two completion operations, even though today's done stock may be one.
- **Milestone total / done** follows explicit membership on each date. Joining, leaving, deletion and restoration can change scope and make the lines rise or fall. It is not a fixed plan or an ideal burndown line. Closing a milestone does not complete its Issues.

Deleting an Issue removes it from stock until restoration; historical creation and completion operations remain recorded. Stock and flow measure different things, so today's stock cannot be calculated simply by subtracting completed from created.

## Scope and available history

A session fixed to a single Issue cannot read project or workspace trends. Ask your Agent to open the project again, or sign in with the appropriate project scope to view aggregates.

Workspace charts cover all unarchived child Projects, without a Project picker. They require the Owner or that Workspace’s administrator with matching management scope. Ordinary members and Project administrators can still read trends for their accessible Projects. A Project-limited login cannot read Workspace aggregates. Archiving a Project changes the included scope. Restoring a Project makes its available history readable again; permanently deleting it removes its recoverable history.

Existing saved history is included where it can be recovered. When coverage is `pending`, the maintainer can [run the initial history backfill](../deployment/updates.md#fill-existing-trend-history) in bounded batches; opening or refreshing a chart does not start it. On schema 30, this runs separately from hourly maintenance. After the queue is processed, refresh the chart. Normal history needs no extra coverage panel; brief warnings appear only for unavailable or pending history. Detailed coverage remains in the API response.

A gap is **unavailable**, not zero; charts leave that segment empty. The response lists each Project's `stock_from`, `flow_from` and `history_state` (`pending`, `complete` or `partial`). Stock and flow may start on different dates. Processing the whole queue cannot restore missing or unreliable old events, so `partial` and gaps may remain. A Workspace aggregate is unavailable for a metric if any included Project lacks that metric's coverage.

Project trends can select a milestone; Workspace trends select only the date window. Board/list status, assignee, priority, Label and text filters do not apply. Milestone membership is optional; use [Project milestones](milestones.md) to maintain it.

## Agent and terminal

```text
Show the last 30 days of unfinished Issue stock and daily creation/completion counts in this Project. State the UTC dates, observation time and any unavailable history.
```

```text
Show trends for all unarchived Projects in this Workspace over the last 90 days. Do not treat missing history as zero.
```

```text
Show the total and done Issue scope of this Project's “Release” milestone over the last 30 days. Explain changes in scope separately from completion.
```

The public CLI uses your verified Instance/Project context for `issue trends` and Workspace context for `workspace issue trends`:

```sh
cfkanban issue trends --days 30 --json
cfkanban workspace issue trends --workspace-id workspace-uuid --days 90 --json
```

For a milestone, add `--milestone <milestone UUID>` to `issue trends`. MCP exposes `cfkanban_project_issue_trends` and `cfkanban_workspace_issue_trends`; hosts may use a namespace prefix. Both read the same server statistics and return coverage and actual scope. With an older Service that does not advertise `issue_trends`, report the missing capability instead of scanning Issue pages to invent a history.

REST provides `GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/trends?days=30` (optional `milestone`) and `GET /api/v1/workspaces/{workspace_id}/issues/trends?days=30` (`days` only; at most 100 unarchived Projects, with an explicit error above the limit). There is no pagination or ordinary Issue filtering. Explicit inaccessible targets and unknown parameters are rejected. The Workspace endpoint requires matching Workspace management access. All readers use current Service authorization; chart access grants no additional permissions.
