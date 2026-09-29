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

**In the Web UI:** Open the project board, enter a title or identifier in the search box, and select **Search**. Each status column loads independently. Column counts show loaded issues; scroll a column or select **Load more** to continue.

For multiple projects, select **Work list** in the header. Choose 1–20 projects, select **All issues** or **My tasks**, set the status, assignee, or title/identifier filters, and select **Show work**. Apply the filters again after changing them. Opening this page does not automatically load every project's issues.

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
