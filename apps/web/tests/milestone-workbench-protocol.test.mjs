import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-milestone-protocol-"));
const moduleFile = path.join(temporary, "protocol.mjs");
await build({ entryPoints: [new URL("../src/embedded/protocol.ts", import.meta.url).pathname], outfile: moduleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { parseActionMessage, parseSnapshotMessage, emptySnapshot } = await import(pathToFileURL(moduleFile));
after(() => rm(temporary, { recursive: true, force: true }));

const action = (name, payload) => ({ type: "action", id: randomUUID(), action: name, payload });
const milestone = (changes = {}) => ({ id: randomUUID(), title: "发布目标", status_key: "open", due_date: null, ...changes });
const issue = (changes = {}) => ({ identifier: "CFK-123", title: "事项", version: 2, status: { key: "todo" }, priority: "none", ...changes });
const snapshot = changes => ({ type: "snapshot", state: { ...emptySnapshot(), ...changes } });

test("membership updates accept one UUID or null without client scope, version, or key", () => {
  for (const milestone_id of [randomUUID(), null]) {
    assert.ok(parseActionMessage(action("mutate", { operation: "update", change: { milestone_id } })));
    assert.ok(parseActionMessage(action("quick_update", { identifier: "CFK-123", change: { milestone_id } })));
  }
  for (const milestone_id of ["", "发布目标", "none", 0, {}, []]) {
    assert.equal(parseActionMessage(action("mutate", { operation: "update", change: { milestone_id } })), null);
  }
  for (const field of ["project_id", "expected_version", "idempotency_key", "cursor"]) {
    assert.equal(parseActionMessage(action("mutate", { operation: "update", change: { milestone_id: null, [field]: randomUUID() } })), null);
  }
  assert.equal(parseActionMessage(action("create_issue", { change: { title: "事项", milestone_id: randomUUID() } })), null);
});

test("milestone candidates use only controlled next-page intent", () => {
  for (const next of [false, true]) assert.ok(parseActionMessage(action("milestones", { next })));
  for (const payload of [{}, { next: "true" }, { next: true, cursor: "opaque" }, { next: false, project_id: randomUUID() }, { next: false, status: "open" }, { next: false, limit: 100 }]) {
    assert.equal(parseActionMessage(action("milestones", payload)), null);
  }
});

test("old Service omission and supported empty membership remain distinct", () => {
  const legacy = parseSnapshotMessage(snapshot({ issue: issue() }));
  assert.ok(legacy);
  assert.equal(Object.hasOwn(legacy.state.issue, "milestone"), false);
  assert.ok(parseSnapshotMessage(snapshot({ issue: issue({ milestone: null }), milestones: [], milestones_has_more: false })));
  assert.ok(parseSnapshotMessage(snapshot({ issue: issue({ milestone: milestone({ status_key: "closed", due_date: "2028-02-29" }) }) })));
});

test("minimal milestone summaries work in detail, list and board", () => {
  const selected = milestone();
  const summary = issue({ milestone: selected });
  assert.ok(parseSnapshotMessage(snapshot({ issue: summary, page: { items: [summary] }, board: { columns: [{ key: "todo", items: [summary], has_more: false }] }, milestones: [selected], milestones_has_more: true })));
  for (const extra of ["description", "progress", "workspace_id", "project_id", "cursor", "allowed_actions"]) {
    const oversized = { ...selected, [extra]: "private-or-full-resource" };
    assert.equal(parseSnapshotMessage(snapshot({ milestones: [oversized] })), null);
    assert.equal(parseSnapshotMessage(snapshot({ issue: issue({ milestone: oversized }) })), null);
    assert.equal(parseSnapshotMessage(snapshot({ page: { items: [issue({ milestone: oversized })] } })), null);
  }
});

test("milestone projection rejects invalid identifiers, dates, status and titles", () => {
  const invalid = [
    { id: "发布目标" }, { status_key: "done" }, { title: " " }, { title: " 目标 " },
    { title: "目".repeat(201) }, { title: "😀".repeat(201) },
    ...["0000-01-01", "2027-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "2026-10-09T00:00:00Z", ""].map(due_date => ({ due_date })),
  ];
  for (const change of invalid) assert.equal(parseSnapshotMessage(snapshot({ milestones: [milestone(change)] })), null);
  assert.ok(parseSnapshotMessage(snapshot({ milestones: [milestone({ title: "😀".repeat(200), due_date: "0001-01-01" })] })));
  const withoutDate = milestone();
  delete withoutDate.due_date;
  assert.equal(parseSnapshotMessage(snapshot({ milestones: [withoutDate] })), null);
});

test("candidate snapshots reject duplicates, capacity overflow and private continuation", () => {
  const selected = milestone();
  assert.equal(parseSnapshotMessage(snapshot({ milestones: [selected, selected] })), null);
  assert.ok(parseSnapshotMessage(snapshot({ milestones: Array.from({ length: 1000 }, () => milestone()) })));
  assert.equal(parseSnapshotMessage(snapshot({ milestones: Array.from({ length: 1001 }, () => milestone()) })), null);
  assert.equal(parseSnapshotMessage(snapshot({ milestones: [], milestones_has_more: "opaque" })), null);
  assert.equal(parseSnapshotMessage(snapshot({ milestones: [], milestones_cursor: "opaque" })), null);
});
