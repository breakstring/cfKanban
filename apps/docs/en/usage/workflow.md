# Workflow and assignees

## Progress or cancel work

```text
Use $cfkanban to move CFK-123 from Backlog to Todo.
```

```text
I have started working on CFK-123. Move it to In Progress.
```

```text
Set CFK-123 to Canceled because this request is no longer needed.
Also add a comment recording that reason.
```

You need write access. Changing status records progress; it does not change the assignee or perform the work described in the issue.

**In the Web UI:** Drag a card to the target column, or use the status selector on the card or issue details. Wait for the saved result. All status changes are possible without dragging. Done follows the completion process below.

## Claim, assign, and unassign work

```text
Assign CFK-123 to me and preserve its current status.
```

```text
Assign CFK-123 to Lin_Design.
```

```text
Unassign CFK-123 without changing anything else.
```

You need write access, and the assignee must also be able to write to the project. If someone is missing, ask an administrator to check their access.

Assignment changes only the responsible person. It does not start the issue or lock it. If an assignee later loses write eligibility, the historical assignment remains and may show **Needs reassignment**; another person is not silently substituted.

**In the Web UI:** Issue details → **Assignee** → choose an eligible person or the unassigned option. Candidates load as needed. If a person is missing, ask an administrator to check their project access first.

## Find work ready to claim or reassign

```text
Use $cfkanban to list unblocked Todo issues ready to claim in DemoProject,
in the service's candidate order. Do not claim any automatically.
```

```text
Show Todo issues that need reassignment in DemoProject.
```

Read access lets you view these queues; claiming requires write access. They contain only Todo issues, exclude blocked issues by default, and sort by priority then oldest first. Include Backlog and In Progress when you want all unfinished work.

**In the Web UI:** **Work list** in the header → choose projects → set **View** to **Ready to claim** or **Needs reassignment** → **Show work**. Viewing a queue does not claim work. Open an issue and set its assignee separately.

## Complete work and record the result

```text
Mark CFK-123 complete using these actual results:
Summary: <what was completed>
Verification: <checks actually performed and their outcomes>
Artifacts: <links, commits, or file paths>
Follow-ups: <remaining work; write none if there is none>
Do not invent verification results I have not provided.
```

You need write access. Completion saves a record that cannot be edited or deleted. Notes are optional; use them for actual results, checks, artifacts, and follow-ups.

**In the Web UI:** Issue details → **Complete issue** → enter an optional note → confirm. Selecting Done from the details' status selector opens the same dialog. The current Web form provides a text note; write the result and checks there, or use the Agent for separate structured verification, artifact, and follow-up lists.

Dragging a board card directly into Done, or selecting Done on a card, completes it immediately with an empty note. Open the details first when you want to include a note. An empty note is displayed as completed; no test results are invented.

## Reopen work

```text
The problem returned. Reopen CFK-123 as Todo and preserve its earlier completion records.
```

You need write access. Done and Canceled issues can return to a non-completed stage while retaining prior completion records. Completing the issue again appends a new record instead of overwriting the previous round. Add a correcting comment for an incorrect record; if the completion itself is no longer valid, reopen the issue and complete it again after resolving the work.

**In the Web UI:** On a Done issue, select **Reopen to Todo** in the properties, or choose the appropriate stage in the status selector. You can also move a card from Done/Canceled to the target column.

## Report and clear blockers

```text
Mark CFK-123 blocked because the test environment is unavailable.
Preserve its current status and assignee.
```

```text
The test environment is available again. Clear CFK-123's manual blocker.
```

Manual blockers require write access and are separate from workflow status. An issue can remain In Progress while blocked. Explicitly clear the manual reason when the external condition is resolved. A [relation](./collaboration.md) such as “CFK-123 blocks CFK-124” also contributes a blocker while the upstream issue is not Done. Completing that upstream issue or removing the relation clears that source; other blockers may remain.

**Web difference:** The current Web UI does not display manual blocker markers, reasons, filters, or report/clear actions. Use the Agent for these operations. The Relations area still supports dependencies. Ordinary boards continue to show blocked issues, while candidate queues exclude them by default. Clearing a manual reason does not remove dependency relations.

## Common questions

- **My tasks and Ready to claim return different results:** The former filters ordinary issues by assignee and can include every status; the latter contains startable, unassigned Todo candidates.
- **An issue still has an assignee or blocker after completion:** Completion does not automatically clear these independent fields. Request those changes separately if needed.
- **Canceling an upstream issue did not clear a dependency:** Dependencies check whether it is Done. Explicitly remove the relation if that dependency is no longer needed.
- **A reader cannot be assigned:** Assignment does not grant write access. Ask an administrator to change access or choose an eligible assignee.
