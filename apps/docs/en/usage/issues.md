# Find, create, and edit issues

An issue is a task, identified by a number such as `CFK-123`. Replace the project names and issue numbers below with your own, then copy a prompt to your Agent.

## Find issues

```text
Show my unfinished issues in DemoProject, including their numbers, statuses, and priorities.
```

```text
Find issues with “login” in their title in DemoProject.
```

You need read access to the project. Search covers titles and issue numbers. Include the workspace when projects have the same name. “Unfinished” includes Backlog, Todo, and In Progress.

**In the Web UI:** Typing a title keyword or Issue number shows up to 10 quick matches from the currently loaded results. They are shortcuts, not the full Project search: prior searches, filters and unopened groups can limit the pool. Click a match, or select it with arrow keys and press Enter, to open it. With no selected match, Enter or **Search Project** searches the current Project using the selected filters and updates the board/list and totals. Typing alone sends no requests or changes to the applied results. Escape closes shortcuts; composition Enter does not submit.

Titles need at least two characters; bare numbers need at least two digits. `CFK-1` also works. `CFK-62` or `62` matches Issue numbers 62, 620, 624 and so on; numeric input searches numbers rather than numeric titles. Matching ignores case and accepts full-width input. A shortcut missing from loaded results can still be found by **Search Project**. Expand a collapsed group with matching totals to see its results.

Priority and label selections apply immediately; unsubmitted search text remains unapplied. Each column can load more Issues. Its header shows matching undeleted totals under the applied filters, regardless of loaded pages. An ellipsis means loading; a dash means totals are unavailable and can be retried separately. Submit again or refresh to check concurrent updates.

```text
Count undeleted high-priority issues with “login” in their title in DemoProject, grouped by status.
```

Select the translation icon at the top right to switch between English and Simplified Chinese. Its tooltip names the current language and the target. Priorities, buttons, system messages, and the five default status labels follow that choice in the full app and local workbench. Custom project status names keep their original text. A status name equal to its canonical English default is treated as a default label; API keys remain unchanged. Switching language preserves unsaved form content.

For several projects, open the account menu at the top right → **Work list**, choose projects, a view, and filters, then select **Show work** again after each change. Its status selector offers one status or all statuses. Ask your Agent to combine several specific statuses into one result.

The project **List** and Kanban in both the full online app and local workbench use Backlog → Todo → In Progress → Done → Canceled. A fresh list with no explicit status filter opens and loads only Backlog; expand another group to load its first page. Each group has an independent cursor and cached loaded pages. Repeated collapse/expand reuses those pages; switching to Kanban loads its missing columns. Refresh and same-project return preserve your expanded groups, while switching projects starts with Backlog. Changed filters reset pages, and an explicit status filter opens that group without fetching Backlog.

**Not loaded**, loading, a retryable error, and an empty loaded group are distinct. Collapsed groups remain discoverable when searching. Group counts show loaded issues; **+** means another page is available. Parent context does not count toward the child’s group. Additional parents are indicated, and historical cycles are marked without changing the relations. Status text and shapes accompany the consistent gray Backlog, blue Todo, orange In Progress, green Done, and red Canceled markers in both themes.

The ring and **5/6** on lists and boards mean that 5 of 6 visible, undeleted direct sub-issues are done. Canceled children are not done, and list filters do not narrow this progress. Older services omit the badge.

## Filter by priority, assignee, and labels

```text
Show my high-priority Todo issues in DemoProject.
```

```text
Show unfinished issues tagged bug or performance in DemoProject. Start with the first 20.
```

```text
Show all unassigned issues in DemoProject, regardless of status.
```

```text
Find unassigned, unblocked Todo issues tagged bug with high or urgent priority in DemoProject.
```

Multiple labels or priorities match any selected value; different conditions must all match. For example, “high or urgent” plus “Todo” finds Todo issues with either priority. Across projects, identically named labels still belong to separate projects; select the labels from each intended project.

For more results, say:

```text
Show the next page of that search, keeping the same projects and filters.
```

## Create an issue

```text
Create “Fix mobile login error” in DemoProject.
Description: Submitting the login form on a small phone screen produces an error. Reproduce and fix it.
Put it in Backlog with high priority, then tell me its issue number.
```

You need writer or applicable administrator access. Creating an issue records the work. To ask your Agent to perform it, follow with “Fix the problem described in CFK-123.”

**In the Web UI:** **New issue** → enter a title, description, status, and priority → **Save**. Descriptions support Markdown. Use the [completion action](./workflow.md) once the work is finished.

## Edit content and priority

```text
Change CFK-123's title to “Fix mobile login timeout”.
Append this to its description: First login after switching networks. Preserve the rest.
```

```text
Set CFK-123 to urgent priority.
```

You need write access. Priorities are None, Low, Medium, High, and Urgent. Choose None to clear a priority.

**In the Web UI:** Open an issue → **Edit issue** → edit and save. Set priority directly on a board card or in issue details.

After a status, priority, or assignee change, the board waits for save confirmation before updating the card and totals. Loaded content and scroll positions remain. Cards are sorted by latest update, so an edited card may move to the top or no longer match the filters. If there is a conflict, the page reads the latest issue and preserves your intended change. If the save result is uncertain, check the saved content and select **Verify save** to check the original operation; it will not automatically submit another write.

## If something goes wrong

- **An issue is missing:** Check the project and filters. Members with write access can also look under **Project settings → Deleted issues**.
- **No edit button:** Check your project access and whether your sign-in has expired.
- **Someone else changed the issue:** Read the latest content before saving again.
- **Saving timed out:** Ask the Agent to verify the original result or use the page's retry action to avoid duplicates.
- **A page failed to load:** Select **Retry page**. If a deployment changed and retry still fails, select **Refresh page** to get the latest version. Save drafts first; the existing unsaved-content warning still applies to refresh.

Next: [Assign, progress, and complete work](./workflow.md).
