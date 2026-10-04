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

**In the Web UI:** On the board, enter a title or issue number and press Enter or select **Search**. Priority and label selections apply immediately; any unsubmitted text in the search box remains unapplied. Each column can load more issues. Its header shows the total matching undeleted issues in that status for the applied filters, regardless of loaded pages. An ellipsis means loading; a dash means the total is unavailable and can be retried separately while cards remain usable. Submit the search again or refresh to check concurrent updates.

```text
Count undeleted high-priority issues with “login” in their title in DemoProject, grouped by status.
```

Select the translation icon at the top right to switch between English and Simplified Chinese. Its tooltip names the current language and the target. Priorities, buttons, and system messages follow that choice. Custom project status names keep their original text; default status names stay in English. Switching language preserves unsaved form content.

For several projects, open the account menu at the top right → **Work list**, choose projects, a view, and filters, then select **Show work** again after each change. Its status selector offers one status or all statuses. Ask your Agent to combine several specific statuses into one result.

The project **List** in both the full online app and local workbench groups issues by status, with independent pagination and collapsible groups. Done and Canceled start collapsed. Group counts show loaded issues; **+** means another page is available. Parent context does not count toward the child’s group. Additional parents are indicated, and historical cycles are marked without changing the relations.

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
