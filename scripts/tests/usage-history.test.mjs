import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collectUsageHistory, collectUsageHistoryDaily, readUsageHistory } from "../../apps/worker/src/services/usage-history.ts";

const DAY = 86_400_000, now = Date.parse("2026-10-07T12:00:00Z"), owner = { kind: "bearer", isOwner: true };
const configuration = { USAGE_HISTORY_ENABLED: "true", USAGE_ACCOUNT_ID: "account", USAGE_D1_DATABASE_ID: "database", USAGE_R2_BUCKET_NAME: "bucket", USAGE_WORKER_NAME: "worker", USAGE_ACCOUNT_TOTALS_ENABLED: "true", USAGE_ANALYTICS_TOKEN: "local-test-only", USAGE_BILLING_PLAN: "paid", USAGE_BILLING_CYCLE_DAY: "10" };
function fixture() {
  const sqlite = new DatabaseSync(":memory:"), queries = [];
  sqlite.exec("CREATE TABLE instance_meta(schema_version INTEGER); INSERT INTO instance_meta VALUES(24)");
  sqlite.exec(readFileSync(new URL("../../migrations/0025_usage-history.sql", import.meta.url), "utf8"));
  const DB = { prepare(sql) {
    let values = [];
    const execute = method => { queries.push({ sql, values }); return sqlite.prepare(sql)[method](...values); };
    return { bind(...bound) { values = bound; return this; }, async first() { return execute("get") ?? null; }, async all() { return { results: execute("all") }; }, async run() { return { meta: { changes: Number(execute("run").changes) } }; } };
  } };
  return { sqlite, queries, env: { DB, ...configuration }, close: () => sqlite.close() };
}
function provider(calls = [], empty = false, offset = 0) {
  return async (url, options) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql"); assert.equal(options.redirect, "manual");
    const request = JSON.parse(options.body); calls.push(request);
    const day = (request.variables.date ?? request.variables.start).slice(0, 10), observed = `${day}T23:00:00Z`;
    const group = (sum) => empty ? [] : [{ sum }];
    const operations = (a, b) => empty ? [] : [{ sum: { requests: a }, dimensions: { actionType: "ListObjects", responseStatusCode: 200 } }, { sum: { requests: b }, dimensions: { actionType: "HeadObject", responseStatusCode: 200 } }];
    const account = request.query.includes("UsageHistoryD1") ? {
      activity: group({ rowsRead: offset, rowsWritten: 2 }), storage: empty ? [] : [{ max: { databaseSizeBytes: 100 }, dimensions: { datetime: observed } }],
      worker: group({ requests: 3 + offset, cpuTimeUs: 4000 }), accountDaily: group({ rowsRead: 100 + offset, rowsWritten: 20 }), accountWorker: group({ requests: 30 + offset, cpuTimeUs: 40000 }),
    } : {
      activity: group({ requests: 8 }), storage: empty ? [] : [{ max: { payloadSize: 20, metadataSize: 2, objectCount: 1 }, dimensions: { datetime: observed } }], daily: operations(3, 5),
      accountActivity: group({ requests: 80 }), accountDaily: operations(30, 50),
    };
    return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }));
  };
}
const metric = (item, key, scope = "instance") => item.metrics.find(value => value.key === key && value.scope === scope);

test("history is opt-in and Owner control is enforced before storage or collection", async () => {
  const f = fixture();
  try {
    for (const auth of [{ ...owner, isOwner: false }, { ...owner, kind: "cookie", targetKind: "project" }]) {
      await assert.rejects(readUsageHistory(f.env, auth), error => error.status === 403);
      await assert.rejects(collectUsageHistory(f.env, auth, "2026-10-06", now, () => { throw Error("must not fetch"); }), error => error.status === 403);
    }
    const disabled = await readUsageHistory({ ...f.env, USAGE_HISTORY_ENABLED: undefined }, owner, 7, now);
    assert.deepEqual(disabled, { enabled: false, retention_days: 90, generated_at: new Date(now).toISOString(), items: [], missing_days: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"], source: "cloudflare_analytics", history_kind: "utc_daily", error: null });
    await collectUsageHistoryDaily({ ...f.env, USAGE_HISTORY_ENABLED: "false" }, now, () => { throw Error("must not fetch"); });
    const unconfigured = await readUsageHistory({ ...f.env, USAGE_ANALYTICS_TOKEN: undefined }, owner, 1, now);
    assert.equal(unconfigured.error, "not_configured"); assert.equal(unconfigured.enabled, true); assert.equal(f.queries.length, 0);
  } finally { f.close(); }
});

test("daily capture uses yesterday's exact UTC window and resource scopes even on Paid", async () => {
  const f = fixture(), calls = [];
  try {
    await collectUsageHistoryDaily(f.env, now, provider(calls));
    const result = await readUsageHistory(f.env, { ...owner, kind: "cookie", targetKind: "admin" }, 1, now);
    assert.equal(calls.length, 2); assert.equal(result.items.length, 1); assert.deepEqual(result.missing_days, []); assert.equal(result.error, null);
    const item = result.items[0]; assert.equal(item.day, "2026-10-06"); assert.equal(item.complete_day, true);
    for (const call of calls) {
      assert.equal(call.variables.account, "account"); assert.equal(call.variables.start, "2026-10-06T00:00:00.000Z"); assert.equal(call.variables.end, "2026-10-06T23:59:59.999Z");
      assert.equal(call.variables.storageEnd, "2026-10-07T00:00:00.000Z"); assert.ok(!call.query.includes("billing")); assert.ok(!call.query.includes("workerStart"));
    }
    assert.equal(calls[0].variables.date, "2026-10-06"); assert.equal(calls[0].variables.database, "database"); assert.equal(calls[0].variables.worker, "worker"); assert.equal(calls[1].variables.bucket, "bucket");
    assert.match(calls[0].query, /scriptName: \$worker/); assert.match(calls[0].query, /databaseId: \$database/); assert.match(calls[1].query, /bucketName: \$bucket/);
    assert.equal(metric(item, "d1_rows_read").value, 0); assert.equal(metric(item, "d1_rows_read", "account").value, 100);
    assert.equal(metric(item, "workers_requests").value, 3); assert.equal(metric(item, "workers_requests", "account").value, 30);
    assert.equal(metric(item, "workers_cpu_microseconds").unit, "microseconds");
    assert.equal(metric(item, "r2_class_a_operations").value, 3); assert.equal(metric(item, "r2_class_b_operations", "account").value, 50);
    for (const value of item.metrics) {
      assert.equal(value.source, "cloudflare");
      if (value.observed_at) { assert.equal(value.observed_at, "2026-10-06T23:00:00.000Z"); assert.equal(value.period_start, null); assert.equal(value.period_end, null); }
      else { assert.equal(value.period_start, "2026-10-06T00:00:00.000Z"); assert.equal(value.period_end, "2026-10-07T00:00:00.000Z"); }
    }
    assert.ok(!JSON.stringify(result).includes(configuration.USAGE_ANALYTICS_TOKEN)); assert.ok(!JSON.stringify(result).includes("config_key"));
    f.queries.length = 0;
    await collectUsageHistoryDaily(f.env, now + 3_600_000, () => { throw Error("successful day must be reused"); });
    assert.equal(f.queries.length, 1); assert.match(f.queries[0].sql, /WHERE config_key = \?1 AND day = \?2/);
  } finally { f.close(); }
});

test("empty upstream data remains an unknown item and a missing day, with retry cooldown", async () => {
  const f = fixture(), calls = [];
  try {
    await collectUsageHistoryDaily(f.env, now, provider(calls, true));
    let result = await readUsageHistory(f.env, owner, 1, now);
    assert.equal(result.items.length, 1); assert.ok(result.items[0].metrics.every(value => value.value === null)); assert.deepEqual(result.missing_days, ["2026-10-06"]); assert.equal(result.error, "no_data");
    await collectUsageHistoryDaily(f.env, now + 59_999, () => { throw Error("cooldown must suppress upstream"); });
    await collectUsageHistoryDaily(f.env, now + 60_000, provider(calls));
    result = await readUsageHistory(f.env, owner, 1, now + 60_000); assert.equal(calls.length, 4); assert.equal(result.error, null); assert.deepEqual(result.missing_days, []);
  } finally { f.close(); }
});

test("a fully unknown manual refresh retains the successful day until a later successful capture", async () => {
  const f = fixture(), calls = [];
  try {
    await collectUsageHistoryDaily(f.env, now, provider(calls));
    const success = await readUsageHistory(f.env, owner, 1, now);
    const empty = await collectUsageHistory(f.env, owner, "2026-10-06", now + 60_000, provider(calls, true));
    assert.equal(empty.error, "no_data"); assert.equal(empty.items[0].collected_at, success.items[0].collected_at); assert.deepEqual(empty.items[0].metrics, success.items[0].metrics);
    assert.equal(metric(empty.items[0], "d1_rows_read").value, 0); assert.ok(!empty.missing_days.includes("2026-10-06"));
    const row = f.sqlite.prepare("SELECT attempted_at, collected_at, metrics_json, error FROM usage_history").get();
    assert.equal(row.attempted_at, now + 60_000); assert.equal(row.collected_at, now); assert.equal(row.error, "no_data"); assert.deepEqual(JSON.parse(row.metrics_json), success.items[0].metrics);
    await collectUsageHistory(f.env, owner, "2026-10-06", now + 119_999, () => { throw Error("failed attempt still imposes cooldown"); });
    assert.equal(calls.length, 4);
    const recovered = await collectUsageHistory(f.env, owner, "2026-10-06", now + 120_000, provider(calls, false, 9));
    assert.equal(calls.length, 6); assert.equal(recovered.error, null); assert.equal(recovered.items[0].collected_at, new Date(now + 120_000).toISOString()); assert.equal(metric(recovered.items[0], "d1_rows_read").value, 9);
  } finally { f.close(); }
});

test("permission and partial-query failures never manufacture zeros or erase prior capture", async (t) => {
  const f = fixture(); t.mock.method(console, "warn", () => {});
  try {
    await collectUsageHistoryDaily(f.env, now, async () => new Response("{}", { status: 403 }));
    let result = await readUsageHistory(f.env, owner, 1, now); assert.equal(result.error, "permission_denied"); assert.deepEqual(result.items, []); assert.deepEqual(result.missing_days, ["2026-10-06"]);
    await collectUsageHistoryDaily(f.env, now + 60_000, provider());
    await collectUsageHistory(f.env, owner, "2026-10-06", now + 120_000, async (url, options) => JSON.parse(options.body).query.includes("UsageHistoryD1") ? provider()(url, options) : new Response(JSON.stringify({ errors: [{ message: "local-test-only" }] })));
    result = await readUsageHistory(f.env, owner, 1, now + 120_000); assert.equal(result.error, "graphql_error"); assert.equal(result.items[0].collected_at, new Date(now + 60_000).toISOString()); assert.equal(metric(result.items[0], "d1_rows_read").value, 0);
    assert.ok(!JSON.stringify(result).includes("local-test-only"));
  } finally { f.close(); }
});

for (const olderEmpty of [false, true]) test(`atomic daily claim suppresses concurrent collection and older ${olderEmpty ? "unknown" : "successful"} responses cannot overwrite newer`, async () => {
  const f = fixture(), calls = [];
  try {
    let release, started; const ready = new Promise(resolve => { started = resolve; });
    const older = collectUsageHistoryDaily(f.env, now, async (url, options) => { if (JSON.parse(options.body).query.includes("UsageHistoryD1")) { started(); await new Promise(resolve => { release = resolve; }); } return provider(calls, olderEmpty, 1)(url, options); });
    await ready;
    await collectUsageHistory(f.env, owner, "2026-10-06", now + 1, () => { throw Error("concurrent request must be suppressed"); });
    await collectUsageHistory(f.env, owner, "2026-10-06", now + 60_001, provider(calls, false, 9));
    release(); await older;
    const result = await readUsageHistory(f.env, owner, 1, now + 60_001); assert.equal(result.items.length, 1); assert.equal(result.error, null); assert.equal(result.items[0].collected_at, new Date(now + 60_001).toISOString()); assert.equal(metric(result.items[0], "d1_rows_read").value, 9);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM usage_history").get().count, 1); assert.equal(calls.length, 4);
  } finally { f.close(); }
});

test("resource and actual query scopes isolate history, cosmetic billing settings do not", async () => {
  const f = fixture();
  try {
    await collectUsageHistoryDaily(f.env, now, provider());
    const changedBilling = { ...f.env, USAGE_BILLING_PLAN: "free", USAGE_BILLING_CYCLE_DAY: "1", USAGE_WARNING_PERCENT: "70", USAGE_R2_STANDARD_ONLY_SCOPE: "instance", USAGE_ANALYTICS_TOKEN: "rotated-local-test" };
    assert.equal((await readUsageHistory(changedBilling, owner, 1, now)).items.length, 1);
    for (const patch of [{ USAGE_D1_DATABASE_ID: "different" }, { USAGE_R2_BUCKET_NAME: "different" }, { USAGE_WORKER_NAME: "different" }, { USAGE_ACCOUNT_TOTALS_ENABLED: "false" }, { USAGE_ACCOUNT_ID: "different" }]) assert.deepEqual((await readUsageHistory({ ...f.env, ...patch }, owner, 1, now)).items, []);
    await collectUsageHistoryDaily({ ...f.env, USAGE_R2_BUCKET_NAME: undefined, USAGE_WORKER_NAME: undefined, USAGE_ACCOUNT_TOTALS_ENABLED: "false" }, now, provider());
    const onlyD1 = await readUsageHistory({ ...f.env, USAGE_R2_BUCKET_NAME: undefined, USAGE_WORKER_NAME: undefined, USAGE_ACCOUNT_TOTALS_ENABLED: "false" }, owner, 1, now);
    assert.deepEqual(onlyD1.items[0].metrics.map(value => value.key), ["d1_storage_bytes", "d1_rows_read", "d1_rows_written"]);
  } finally { f.close(); }
});

test("days and manual date ranges are strict and GET reads at most the requested 90 UTC dates", async () => {
  const f = fixture();
  try {
    for (const days of [0, 91, 1.5, Infinity, NaN, "7"]) await assert.rejects(readUsageHistory(f.env, owner, days, now), error => error.status === 400);
    for (const day of ["2026-10-07", "2026-09-29", "2026-02-30", "2026-10-6", "2026-10-06T00:00:00Z", 1, null]) await assert.rejects(collectUsageHistory(f.env, owner, day, now, () => { throw Error("must not fetch"); }), error => error.status === 400);
    await collectUsageHistory(f.env, owner, "2026-09-30", now, provider());
    const result = await readUsageHistory(f.env, owner, 90, now);
    assert.equal(result.items.length, 1); assert.equal(result.missing_days.length, 89); assert.equal(result.missing_days[0], "2026-07-09"); assert.equal(result.missing_days.at(-1), "2026-10-06");
    const query = f.queries.at(-1); assert.equal(query.values[3], 90);
    const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values).map(row => row.detail).join(" "); assert.match(plan, /INDEX sqlite_autoindex_usage_history_1/);
  } finally { f.close(); }
});

test("retention cleanup uses the day index, removes no more than seven rows and protects current config at the global cap", async () => {
  const f = fixture();
  try {
    const insert = f.sqlite.prepare("INSERT INTO usage_history(config_key, day, attempted_at) VALUES(?,?,?)");
    for (let index = 0; index < 20; index++) insert.run(`expired-${index}`, "2026-07-08", now - DAY);
    insert.run("boundary", "2026-07-09", now - DAY);
    await collectUsageHistoryDaily(f.env, now, provider());
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM usage_history WHERE day='2026-07-08'").get().count, 13); assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM usage_history WHERE day='2026-07-09'").get().count, 1);
    const cleanup = f.queries.find(query => query.sql.startsWith("DELETE"));
    assert.equal(cleanup.values[1], 7); const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${cleanup.sql}`).all(...cleanup.values).map(row => row.detail).join(" "); assert.match(plan, /idx_usage_history_day/);
    f.sqlite.exec("DELETE FROM usage_history WHERE config_key NOT LIKE '[%'");
    const current = f.sqlite.prepare("SELECT config_key FROM usage_history").get().config_key;
    for (let index = 0; index < 629; index++) insert.run(`old-${index}`, "2026-10-05", now - DAY);
    await collectUsageHistory(f.env, owner, "2026-10-05", now, provider());
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM usage_history").get().count, 624); assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM usage_history WHERE config_key=?").get(current).count, 2);
  } finally { f.close(); }
});
