import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const built = await build({ entryPoints: [new URL("../../apps/web/src/lib/column-pagination.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const { ColumnPagination } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const page = (items, cursor = null) => ({ items, has_more: cursor !== null, next_cursor: cursor });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("first load is bounded; concurrent triggers do not drain pages; repeated IDs update once", async () => {
  const column = new ColumnPagination();
  const first = deferred(); let calls = 0;
  const fetch = async () => { calls++; return first.promise; };
  const loading = column.load(fetch);
  await column.load(fetch);
  first.resolve(page([{ id: "1", title: "old" }], "next"));
  await loading;
  assert.equal(calls, 1); assert.equal(column.cursor, "next");
  await column.load(async cursor => { assert.equal(cursor, "next"); return page([{ id: "1", title: "new" }, { id: "2" }]); });
  assert.deepEqual(column.items, [{ id: "1", title: "new" }, { id: "2" }]);
  await column.load(() => assert.fail("exhausted list must not reload"));
});
test("filter reset discards late old success and failure without unlocking the new request", async () => {
  for (const fail of [false, true]) {
    const column = new ColumnPagination(); const old = deferred(), fresh = deferred();
    const previous = column.load(async () => { await old.promise; if (fail) throw new Error("old failure"); return page([{ id: "old" }]); });
    const next = column.load(() => fresh.promise, true);
    old.resolve(); await previous;
    assert.equal(column.loading, true); assert.equal(column.error, null); assert.deepEqual(column.items, []);
    fresh.resolve(page([{ id: "fresh" }])); await next;
    assert.deepEqual(column.items, [{ id: "fresh" }]);
  }
});
test("failed next page retains loaded rows and retries its cursor; invalid cursors restart", async () => {
  const column = new ColumnPagination();
  await column.load(async () => page([{ id: "1" }], "next"));
  await column.load(async () => { throw new Error("offline"); });
  assert.equal(column.cursor, "next"); assert.equal(column.items.length, 1);
  await column.load(async cursor => { assert.equal(cursor, "next"); throw { body: { code: "CURSOR_SCOPE_MISMATCH" } }; });
  assert.equal(column.loaded, false); assert.equal(column.cursor, null); assert.deepEqual(column.items, []);
  await column.load(async cursor => { assert.equal(cursor, undefined); return page([{ id: "fresh" }]); });
  assert.equal(column.error, null);
});
