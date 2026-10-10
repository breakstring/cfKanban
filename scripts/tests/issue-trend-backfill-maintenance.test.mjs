import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import { unstable_splitSqlQuery } from "wrangler";
import { BACKFILL_ALGORITHM_VERSION, HISTORY_PAGE_LIMIT, JOB_PAGE_SQL, TREND_HISTORY_PAGE_SQL,
  createTrendBackfillCommit } from "../../apps/worker/src/maintenance/issue-trend-backfill.ts";
import { backfillIssueTrends, replayTrendHistory } from "../../apps/worker/src/services/issue-trend-projection.ts";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migrations = await Promise.all(manifest.migrations.map(entry => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
const day = value => Date.parse(`2026-01-${String(value).padStart(2, "0")}T12:00:00Z`);
function fixture({ status = "todo", events = [{ type: "issue.created", payload: { status_key: "todo", milestone_id: null }, at: day(1) }] } = {}) {
  const db = new DatabaseSync(":memory:");
  migrations.slice(0, 28).forEach(sql => db.exec(sql));
  db.exec(`INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','TrendOwner','trendowner',1,1);
    INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',28,1);
    INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('w','Trends',1,1,'owner','owner','w');
    INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('p','w','Trends',1,1,'owner','owner','p');`);
  db.prepare(`INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES('i','p','Trend','trend',?,?,?,'owner','owner','i')`).run(status, day(1), day(1));
  for (const event of events) {
    const eventId = randomUUID();
    db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
      VALUES(?,'domain',?,?,0,'deployment_owner','w','p','issue','i',?,?)`)
      .run(eventId, event.type, randomUUID(), JSON.stringify(event.payload ?? {}), event.at);
    if (event.raw !== undefined) {
      db.exec("PRAGMA ignore_check_constraints=ON");
      db.prepare("UPDATE events SET payload_json=? WHERE id=?").run(event.raw, eventId);
      db.exec("PRAGMA ignore_check_constraints=OFF");
    }
  }
  db.exec(migrations[28]);
  return db;
}
function upgrade(db) { db.exec(migrations[29]); }
function lease(db, run = "run", fence = 1, until = Date.now() + 60_000) {
  db.prepare("UPDATE issue_trend_backfill_control SET run_id=?,fence=?,lease_until=? WHERE id=1").run(run, fence, until);
}
function job(db) { return db.prepare(JOB_PAGE_SQL).get(1); }
function history(db, next = job(db)) { return db.prepare(TREND_HISTORY_PAGE_SQL).all(next.project_id, next.issue_id, next.cursor); }
function commit(db, { next = job(db), batch = "batch", run = "run", fence = 1 } = {}) {
  const update = createTrendBackfillCommit(next, history(db, next), { batchId: batch, runId: run, fence });
  return { update, result: db.prepare(update.sql).run(...update.params) };
}
function snapshot(db) {
  return Object.fromEntries(["issues", "issue_trend_states", "issue_trend_totals", "issue_trend_projects", "issue_trend_backfill", "issue_trend_days", "issue_trend_backfill_control"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
}
function adapter(db) {
  return { prepare(sql) { let params = []; return {
    bind(...args) { params = args; return this; },
    async all() { return { results: db.prepare(sql).all(...params), meta: {} }; },
    execute() { return { results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
  }; }, async batch(statements) {
    db.exec("BEGIN"); try { const result = statements.map(statement => statement.execute()); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
}

test("schema 29 to 30 preserves the queue and current facts and initializes an inactive singleton lease", () => {
  const db = fixture(); try {
    const before = snapshotWithoutControl(db);
    upgrade(db);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 30);
    const current = snapshotWithoutControl(db);
    current.issue_trend_backfill.forEach(row => { assert.equal(row.replay_json, null); delete row.replay_json; });
    assert.deepEqual(current, before);
    assert.deepEqual({ ...db.prepare("SELECT * FROM issue_trend_backfill_control").get() },
      { id: 1, run_id: null, lease_until: 0, fence: 0, last_batch_id: null, last_issue_id: null, last_version: null });
    assert.throws(() => db.exec("INSERT INTO issue_trend_backfill_control(id) VALUES(2)"), /CHECK/);
  } finally { db.close(); }
});
test("the pinned Wrangler splitter keeps the entire replay trigger in one migration statement", () => {
  const db = fixture(); try {
    const parts = unstable_splitSqlQuery(migrations[29]);
    assert.equal(parts.length, 5);
    const triggers = parts.filter(sql => sql.startsWith("CREATE TRIGGER"));
    assert.equal(triggers.length, 1);
    assert.match(triggers[0], /UPDATE issue_trend_backfill SET replay_json=NULL/u);
    assert.match(triggers[0], /\nEND$/u);
    parts.forEach(sql => db.exec(sql));
    lease(db);
    assert.equal(Number(commit(db).result.changes), 1);
    assert.equal(db.prepare("SELECT pending_jobs FROM issue_trend_projects").get().pending_jobs, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM issue_trend_backfill").get().n, 0);
  } finally { db.close(); }
});
function snapshotWithoutControl(db) {
  return Object.fromEntries(["issues", "issue_trend_states", "issue_trend_totals", "issue_trend_projects", "issue_trend_backfill", "issue_trend_days"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
}
test("one CAS statement atomically replays history, publishes coverage and records a deleted job receipt", () => {
  const db = fixture({ status: "done", events: [
    { type: "issue.created", payload: { status_key: "todo", milestone_id: null }, at: day(1) },
    { type: "issue.completed", payload: { old_status_key: "todo", new_status_key: "done" }, at: day(3) },
  ] }); try {
    upgrade(db); lease(db);
    const facts = snapshot(db), originalJob = job(db), page = history(db);
    const update = createTrendBackfillCommit(originalJob, page, { batchId: "once", runId: "run", fence: 1 });
    assert.equal(Number(db.prepare(update.sql).run(...update.params).changes), 1);
    assert.equal(Number(db.prepare(update.sql).run(...update.params).changes), 0);
    const after = snapshot(db);
    for (const table of ["issues", "issue_trend_states", "issue_trend_totals"]) assert.deepEqual(after[table], facts[table]);
    assert.equal(after.issue_trend_backfill.length, 0);
    assert.equal(after.issue_trend_projects[0].pending_jobs, 0);
    assert.equal(after.issue_trend_projects[0].partial, 0);
    assert.deepEqual(after.issue_trend_days.map(({ date, total_delta, done_delta, created, completed }) =>
      ({ date, total_delta, done_delta, created, completed })), [
      { date: "2026-01-01", total_delta: 1, done_delta: 0, created: 1, completed: 0 },
      { date: "2026-01-03", total_delta: 0, done_delta: 1, created: 0, completed: 1 },
    ]);
    assert.equal(after.issue_trend_backfill_control[0].last_batch_id, "once");
    assert.equal(after.issue_trend_backfill_control[0].last_issue_id, "i");
    assert.equal(after.issue_trend_backfill_control[0].last_version, originalJob.version + 1);
  } finally { db.close(); }
});
test("a trigger fault after derived writes rolls back every effect of the one statement", () => {
  const db = fixture(); try {
    upgrade(db); lease(db);
    db.exec("CREATE TRIGGER isolated_fail_receipt BEFORE UPDATE ON issue_trend_backfill_control BEGIN SELECT RAISE(ABORT,'isolated fault'); END");
    const before = snapshot(db);
    assert.throws(() => commit(db), /isolated fault/);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});
test("invalid replay JSON or a failing day constraint leaves the queue watermark unchanged", () => {
  for (const invalid of ["invalid", "negative", "missing_flag"]) {
    const db = fixture(); try {
      upgrade(db); lease(db);
      const before = snapshot(db), next = job(db);
      const update = createTrendBackfillCommit(next, history(db), { batchId: "bad", runId: "run", fence: 1 });
      const payload = JSON.parse(update.params[9]);
      if (invalid === "negative") payload.deltas[0].created = -1;
      if (invalid === "missing_flag") delete payload.finished;
      update.params[9] = invalid === "invalid" ? "{" : JSON.stringify(payload);
      assert.throws(() => db.prepare(update.sql).run(...update.params));
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  }
});
test("expired or replaced leases fence stale writers, including equal versions with changed cursors", () => {
  for (const mode of ["expired", "run", "fence", "cursor", "version"]) {
    const db = fixture(); try {
      upgrade(db); lease(db);
      const next = job(db), page = history(db);
      const update = createTrendBackfillCommit(next, page, { batchId: "stale", runId: "run", fence: 1 });
      if (mode === "expired") lease(db, "run", 1, Date.now() - 2000);
      if (mode === "run") lease(db, "other", 1);
      if (mode === "fence") lease(db, "run", 2);
      if (mode === "cursor") db.exec("UPDATE issue_trend_backfill SET cursor=cursor-1");
      if (mode === "version") db.exec("UPDATE issue_trend_backfill SET version=version+1");
      const before = snapshot(db);
      assert.equal(Number(db.prepare(update.sql).run(...update.params).changes), 0);
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  }
});
test("a competing batch based on the same job loses CAS and does not replace the winning receipt", () => {
  const db = fixture(); try {
    upgrade(db); lease(db);
    const next = job(db), page = history(db);
    const first = createTrendBackfillCommit(next, page, { batchId: "winner", runId: "run", fence: 1 });
    const second = createTrendBackfillCommit(next, page, { batchId: "loser", runId: "run", fence: 1 });
    assert.equal(Number(db.prepare(first.sql).run(...first.params).changes), 1);
    assert.equal(Number(db.prepare(second.sql).run(...second.params).changes), 0);
    assert.equal(db.prepare("SELECT SUM(created) n FROM issue_trend_days").get().n, 1);
    assert.equal(db.prepare("SELECT last_batch_id FROM issue_trend_backfill_control").get().last_batch_id, "winner");
  } finally { db.close(); }
});
test("post-baseline events keep their current projection while an older frozen job is replayed", () => {
  const db = fixture(); try {
    upgrade(db); lease(db);
    db.exec("UPDATE issues SET status_key='done' WHERE id='i'");
    db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
      VALUES(?,'domain','issue.completed',?,0,'deployment_owner','w','p','issue','i',?,?)`)
      .run(randomUUID(), randomUUID(), JSON.stringify({ old_status_key: "todo", new_status_key: "done" }), day(5));
    const before = snapshot(db);
    assert.equal(job(db).status_key, "todo");
    assert.equal(before.issue_trend_totals[0].done, 1);
    commit(db);
    const after = snapshot(db);
    for (const table of ["issues", "issue_trend_states", "issue_trend_totals"]) assert.deepEqual(after[table], before[table]);
    assert.equal(db.prepare("SELECT SUM(completed) n FROM issue_trend_days").get().n, 1);
    assert.equal(db.prepare("SELECT SUM(created) n FROM issue_trend_days").get().n, 1);
  } finally { db.close(); }
});
test("paged replay clears its temporary JSON and keeps the proven suffix when older history is unknown", () => {
  const events = [{ type: "issue.created", payload: { status_key: "todo" }, at: day(1) }];
  for (let index = 0; index < 150; index++) events.push({ type: "issue.updated", payload: {}, at: day(2) });
  events.push({ type: "issue.completed", payload: { old_status_key: "todo", new_status_key: "done" }, at: day(3) });
  const db = fixture({ status: "done", events }); try {
    upgrade(db); lease(db);
    const first = commit(db, { batch: "page1" });
    assert.equal(first.update.finished, false);
    assert.equal(first.update.event_count, 100);
    assert.equal(job(db).version, 2);
    assert.equal(db.prepare("SELECT replay_json FROM issue_trend_backfill").get().replay_json, null);
    assert.equal(db.prepare("SELECT pending_jobs FROM issue_trend_projects").get().pending_jobs, 1);
    const second = commit(db, { batch: "page2" });
    assert.equal(second.update.finished, true);
    const coverage = db.prepare("SELECT pending_jobs,partial,stock_from,flow_from FROM issue_trend_projects").get();
    assert.deepEqual({ ...coverage }, { pending_jobs: 0, partial: 1, stock_from: "2026-01-02", flow_from: "2026-01-03" });
    assert.equal(db.prepare("SELECT completed FROM issue_trend_days WHERE date='2026-01-03' AND milestone_key=''").get().completed, 1);
  } finally { db.close(); }
});
test("bounded event projection preserves required payload types and missing keys without returning content", () => {
  const payload = { status_key: "todo", milestone_id: null, status_changed: false, old_status_key: ["invalid"],
    new_status_key: { invalid: true }, milestone_changed: true, old_milestone_id: "m", new_milestone_id: null,
    title: "private", body: "x".repeat(100_000), comments: ["private"] };
  const db = fixture({ events: [
    { type: "issue.created", payload: {}, at: day(1) },
    { type: "issue.updated", payload, at: day(2) },
    { type: "issue.updated", raw: "{", at: day(3) },
    { type: "issue.updated", payload: [], at: day(4) },
  ] }); try {
    upgrade(db);
    const page = history(db);
    assert.equal(page.length, 4);
    assert.equal(page[0].payload_json, "null");
    assert.equal(page[1].payload_json, "null");
    const expected = { ...payload }; delete expected.title; delete expected.body; delete expected.comments;
    assert.deepEqual(JSON.parse(page[2].payload_json), expected);
    assert.equal(page[3].payload_json, "{}");
    assert.ok(JSON.stringify(page).length < 2000);
    assert.equal(Object.hasOwn(job(db), "replay_json"), false);
    const raw = db.prepare("SELECT sequence,type,created_at,payload_json FROM events ORDER BY sequence DESC").all();
    assert.deepEqual(replayTrendHistory(job(db), page), replayTrendHistory(job(db), raw));
    assert.match(TREND_HISTORY_PAGE_SQL, /INDEXED BY idx_events_issue_trend_history/u);
    assert.match(TREND_HISTORY_PAGE_SQL, /LIMIT 100$/u);
  } finally { db.close(); }
});
test("the RC7 batch path remains compatible with schema 30 and cannot trigger duplicate derived writes", async () => {
  const db = fixture(); try {
    upgrade(db);
    assert.deepEqual(await backfillIssueTrends(adapter(db)), { processed: 1, finished: 1 });
    assert.equal(db.prepare("SELECT SUM(created) n FROM issue_trend_days").get().n, 1);
    assert.equal(db.prepare("SELECT last_batch_id FROM issue_trend_backfill_control").get().last_batch_id, null);
    assert.deepEqual(await backfillIssueTrends(adapter(db)), { processed: 0, finished: 0 });
  } finally { db.close(); }
});
test("hourly maintenance no longer starts or imports historical replay", async () => {
  const source = await readFile(new URL("../../apps/worker/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /backfillIssueTrends|issue-trend-projection|budget\.trendJobs/u);
  assert.match(source, /collectAttachmentGarbage/u);
  assert.match(source, /collectUsageHistoryDaily/u);
});
test("the maintenance algorithm builds as portable Node ESM and the release builder packages its verified bytes", async () => {
  const result = await build({ entryPoints: [new URL("../../apps/worker/src/maintenance/issue-trend-backfill.ts", import.meta.url).pathname],
    bundle: true, platform: "node", target: "node22.12", format: "esm", minify: true, write: false, logLevel: "silent" });
  const bytes = result.outputFiles[0].contents;
  const artifact = await import(`data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`);
  assert.equal(artifact.BACKFILL_ALGORITHM_VERSION, BACKFILL_ALGORITHM_VERSION);
  assert.equal(artifact.HISTORY_PAGE_LIMIT, HISTORY_PAGE_LIMIT);
  assert.equal(artifact.JOB_PAGE_SQL, JOB_PAGE_SQL);
  assert.equal(artifact.TREND_HISTORY_PAGE_SQL, TREND_HISTORY_PAGE_SQL);
  const db = fixture(); try {
    const options = { batchId: "bundle", runId: "run", fence: 1 };
    assert.deepEqual(artifact.createTrendBackfillCommit(job(db), history(db), options), createTrendBackfillCommit(job(db), history(db), options));
  } finally { db.close(); }
  assert.equal(createHash("sha256").update(bytes).digest("hex").length, 64);
  const builder = await readFile(new URL("../build-release-bundles.mjs", import.meta.url), "utf8");
  assert.match(builder, /backfillBuild\.sha256/u);
  for (const name of ["issue-trend-backfill.mjs", "issue-trend-backfill-build.json"]) {
    assert.ok(builder.includes(`path.join(serviceRoot, "dist", "${name}")`));
  }
});
