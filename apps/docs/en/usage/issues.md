# Find, create, and edit issues

An issue is a task, identified by a number such as `CFK-123`. Replace the project names and issue numbers below with your own, then copy a prompt to your Agent.

## Find issues

```text
Use $cfkanban to show my unfinished issues in DemoProject, including their numbers, statuses, and priorities.
```

```text
Find issues with “login” in their title in DemoProject. List the results without changing anything.
```

You need read access to the project. Search covers titles and issue numbers. Include the workspace when projects have the same name. “Unfinished” includes Backlog, Todo, and In Progress.

**In the Web UI:** On the board, enter a title or issue number and press Enter or select **Search**. Priority and label selections apply immediately; any unsubmitted text in the search box remains unapplied. Each column can load more issues; its count shows how many are currently loaded.

For several projects, open the account menu at the top right → **Work list**, choose projects, a view, and filters, then select **Show work** again after each change. Its status selector offers one status or all statuses. Ask your Agent to combine several specific statuses into one result.

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
List them without claiming any.
```

Multiple labels or priorities match any selected value; different conditions must all match. For example, “high or urgent” plus “Todo” finds Todo issues with either priority. Across projects, identically named labels still belong to separate projects; select the labels from each intended project.

For more results, say:

```text
Show the next page of that search, keeping the same projects and filters.
```

## Create an issue

```text
Use $cfkanban to create “Fix mobile login error” in DemoProject.
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
Set CFK-123 to urgent priority, keeping its status and assignee unchanged.
```

You need write access. Priorities are None, Low, Medium, High, and Urgent. Choose None to clear a priority.

**In the Web UI:** Open an issue → **Edit issue** → edit and save. Set priority directly on a board card or in issue details.

## If something goes wrong

- **An issue is missing:** Check the project and filters. Members with write access can also look under **Project settings → Deleted issues**.
- **No edit button:** Check your project access and whether your sign-in has expired.
- **Someone else changed the issue:** Read the latest content before saving again.
- **Saving timed out:** Ask the Agent to verify the original result or use the page's retry action to avoid duplicates.

Next: [Assign, progress, and complete work](./workflow.md).
