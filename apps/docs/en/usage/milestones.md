# Project milestones

A milestone groups Issues around a delivery goal, such as “Attachment delivery.” A Project can have no milestones or several. You can create an empty milestone and add Issues later.

## Create and maintain

In the Web app, open **Milestones** in the Project to see its due date and total, done, unfinished, and canceled Issue counts. Writers can create or edit its title, goal description, optional due date, and explicitly close or reopen it. Readers can view it.

Finishing all Issues does not automatically close a milestone. Closing one does not finish, cancel, or remove its Issues. The due date is optional, and membership can still be explicitly adjusted after closing.

```text
Create an “Attachment delivery” milestone in this Project, due 2026-11-30, with the description “Validate attachment uploads and reads.”
```

## Set Issue membership

Choose a milestone when creating an Issue, or leave **No milestone** selected. For an existing Issue, use **Milestone** in the detail properties on the right to join, change or leave a goal. Each selection saves immediately without opening **Edit issue**. An Issue belongs to at most one milestone in its own Project at a time. Changes remain in history, and parents and children choose independently without inheritance.

```text
Add CFK-123 to this Project’s “Attachment delivery” milestone. Verify the exact target and current Issue version first.
```

```text
Remove CFK-123 from its milestone, retaining its status and other content.
```

Filter the board or list by a milestone, or show only Issues with no milestone. Milestone lists and selectors provide **Load more**, without fetching every Issue.

In the local browser workbench or host workbench, open an Issue and use **Milestone** in its detail properties to join, change or leave a goal. Readers see the current membership. The picker includes closed milestones and **Load more**, and keeps the current goal visible before its candidate page loads. Changes appear after confirmation; recover a pending write before changing it again. Create and maintain milestones in the full Web app or through the Agent/CLI. With an older Service that lacks milestone support, ordinary Issue details remain available and this control is hidden.

## Progress semantics

Each explicitly associated, non-deleted Issue counts once. Canceled is separate from done; unfinished includes backlog, todo, and in_progress. A parent and child both associated count separately. Descendants are not included implicitly. Counts measure Issues, not estimated effort.

Archiving the Project pauses content access; restoring it makes milestones available again. Permanently deleting the Project removes its milestones and history under the existing cleanup contract. See [Issue trends](trends.md) for historical milestone scope and completion charts.

## Terminal and API

The public CLI provides `milestone list`, `milestone show`, `milestone create`, and `milestone update`, using existing Instance and Project context resolution. Close with `milestone update --status-key closed` or reopen with `--status-key open`, supplying the current `--expected-version`.

Issue creation and updates accept `--milestone-id <UUID>`; `issue update --milestone-id null` explicitly removes membership. Issue lists, counts, and candidates accept `--milestone <UUID>`, or `--milestone none` for unassociated Issues.

MCP exposes equivalent milestone reads, creation, and updates, plus optional Issue membership. API writes retain live Project authorization, CAS, and creation idempotency. Preserve drafts after conflicts and the original request after an unknown result; verify rather than creating a duplicate.
