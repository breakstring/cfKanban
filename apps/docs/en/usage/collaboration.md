# Collaboration and attachments

## Comments and corrections

```text
Use $cfkanban to add this progress comment to CFK-123:
Reproduced on a phone. It happens only on the first login after switching networks; next I will check the retry logic.
```

```text
Add a correction to CFK-123 explaining that the earlier “Android only” conclusion was incorrect: the issue also reproduces on iOS.
```

You need write access. Ordinary comments are appended to the issue's activity and support Markdown. They cannot be edited in place; add another comment to correct one. Ordinary comments can be soft-deleted and restored. Completion records cannot be deleted or changed.

**In the Web UI:** Issue details → comment box below **Activity** → **Comment**. Ordinary comments have a **Delete** action. To restore one, open **Restore deleted collaboration items** in the details' Relations area and select the exact comment. There is no edit button for old comments.

## Upload, download, and restore attachments

```text
Use $cfkanban to attach <absolute file path> to CFK-123. Upload only this file.
```

```text
List the attachments on CFK-123, then download my selected <attachment ID>
to <new absolute file path>. Do not overwrite an existing file or open it automatically.
```

```text
Restore the deleted attachment <attachment ID> on CFK-123.
```

The Owner must enable attachments and set capacity first. Readers can view and download; people with write access can upload, delete, and restore. Upload one nonempty file at a time, up to 10 MiB, with at most 20 active attachments per issue, including uploads in progress.

Attachments require sign-in and project access to download. Mention an attachment when completing the issue if you want it included in the completion record.

**In the Web UI:** Issue details → **Attachments** → **Choose a file** or drop one file → **Upload**. Existing files can be downloaded, and supported images can be previewed. Select **Deleted files** to restore a file. Selecting a file does not upload it automatically; use the same upload item's retry action if it fails.

Soft deletion is recoverable but does not immediately free the instance's attachment byte budget. If capacity is full, storage is disabled, or restoration exceeds a limit, ask the Owner to check the settings. See [Deployment](../deployment/index.md) for enabling storage and [Administration](../administration/index.md) for capacity management.

## Use and maintain labels

```text
Add DemoProject's existing bug label to CFK-123.
```

```text
Create a label named mobile in DemoProject, then add it to CFK-123.
```

```text
Remove the bug label from CFK-123, keeping the label in the project.
```

Labels belong to a project and require write access to maintain. Removing a label from one issue affects only that issue; deleting a project label affects the whole project.

**In the Web UI:** Issue details → **Labels** → type a name and press Enter to reuse a matching label or create and attach one. The × beside a label removes only this issue's association. Use **Project settings → Labels** on the board or **Manage** in the details' Labels area to change names/colors or delete project labels. Restore them through **Restore deleted collaboration items** in issue details. Deleting a project label hides it on all issues in that project.

## Connect related work

```text
Record that CFK-123 blocks CFK-124: the login fix must finish before regression verification begins.
```

```text
Make CFK-123 the parent of CFK-124.
```

```text
Record that CFK-123 is related to CFK-124.
```

```text
Record that CFK-123 duplicates CFK-124, keeping CFK-124 as the canonical issue.
```

The four relation types are blocks, parent, related, and duplicate. Both issues must belong to the same workspace, and you need write access to both projects. Write access on only one side, with read access on the other, is insufficient to change the relation. Relations do not automatically change assignees, status, or permissions. Marking an issue as a duplicate does not cancel it.

**In the Web UI:** Issue details → **Relations** → **Add** → choose the kind and enter the target `CFK-` identifier → leave the field and verify the target project and title → **Save**. Directed relations start from the current issue: it blocks the target, is its parent, or duplicates it. Delete a relation beside its row; restore it through **Restore deleted collaboration items**. Relations are visible only when you can read both endpoints.

## Read the project description, activity, and a handoff summary

```text
Use $cfkanban to read DemoProject's description and summarize CFK-123 for handoff:
its goal, status, assignee, dependencies, verified results, and follow-ups. Do not change the issue.
```

You need read access to the relevant projects. Handoff summaries help you catch up quickly; ask the Agent to read relevant history if details were omitted.

**In the Web UI:** The project description appears below the board title. Open **Project settings → Activity** to read the newest project events first. **Load older activity** continues through earlier history; **Refresh** starts a fresh list that includes new changes. Returning to the board preserves your submitted filters. Expand **Handoff summary** in issue details to read or copy it.

```text
Use $cfkanban to show DemoProject's latest activity first. Read older history only as needed, and identify the actor and changed resource. Do not change the project.
```

## Delete and restore issues

```text
Soft-delete CFK-123 after checking its identifier and title.
```

```text
Restore the deleted CFK-123 and verify its restored state.
```

You need write access. Deleting an issue is a recoverable soft delete, not permanent erasure or physical storage cleanup. Restoration checks current permissions, parent project availability, and capacity. It can fail if the issue and its comments cannot fit within the limits.

**In the Web UI:** Issue details → **Delete** → check and confirm. Open **Project settings → Deleted issues** from the board to find and restore an issue. This tab is available to members with write access. If the project or workspace is archived, ask an administrator to restore it first.

## Common questions

- **An attachment upload was interrupted:** Keep the original file and operation so the Agent or page can resume the same upload. Avoid creating repeated copies.
- **A label was created but not attached:** The first of the two operations may have succeeded. Retry adding the existing label instead of creating another with the same name.
- **A cross-project relation is unavailable:** Check the workspace, write access on both endpoints, and the current browser session's scope.
- **A completion record is absent from recovery:** Completion records cannot be deleted or restored. Add a correcting comment, or reopen the issue if completion is no longer valid.
