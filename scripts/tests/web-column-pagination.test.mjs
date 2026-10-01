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
test("failed next page retains loaded rows and retries its cursor; default invalid cursor recovery clears rows", async () => {
  const column = new ColumnPagination();
  await column.load(async () => page([{ id: "1" }], "next"));
  await column.load(async () => { throw new Error("offline"); });
  assert.equal(column.cursor, "next"); assert.equal(column.items.length, 1);
  await column.load(async cursor => { assert.equal(cursor, "next"); throw { body: { code: "CURSOR_SCOPE_MISMATCH" } }; });
  assert.equal(column.loaded, false); assert.equal(column.cursor, null); assert.deepEqual(column.items, []);
  await column.load(async cursor => { assert.equal(cursor, undefined); return page([{ id: "fresh" }]); });
  assert.equal(column.error, null);
  assert.deepEqual(column.items, [{ id: "fresh" }]);
});

test("confirmed reconciliation preserves loaded pages and their continuation cursor", async () => {
  const column = new ColumnPagination();
  await column.load(async () => page([{ id: "1", title: "first" }], "page-2"));
  await column.load(async () => page([{ id: "2", title: "second" }], "page-3"));
  column.reconcile(items => items.map(item => item.id === "2" ? { ...item, title: "confirmed" } : item));
  assert.deepEqual(column.items, [{ id: "1", title: "first" }, { id: "2", title: "confirmed" }]);
  assert.equal(column.cursor, "page-3");
  assert.equal(column.loaded, true);
  assert.equal(column.loading, false);
  await column.load(async cursor => {
    assert.equal(cursor, "page-3");
    return page([{ id: "3", title: "third" }]);
  });
  assert.equal(column.items.length, 3);
});

test("reconciliation discards late page success and failure without releasing a newer page request", async () => {
  for (const fail of [false, true]) {
    const column = new ColumnPagination();
    await column.load(async () => page([{ id: "1", title: "old" }], "next"));
    const old = deferred(), fresh = deferred();
    const previous = column.load(async () => {
      await old.promise;
      if (fail) throw new Error("old page failure");
      return page([{ id: "1", title: "stale" }, { id: "stale-page" }]);
    });
    column.reconcile(items => items.map(item => ({ ...item, title: "confirmed" })));
    const next = column.load(async cursor => {
      assert.equal(cursor, "next");
      return fresh.promise;
    });
    old.resolve();
    assert.equal(await previous, false);
    assert.equal(column.loading, true);
    assert.equal(column.error, null);
    assert.equal(column.cursor, "next");
    assert.deepEqual(column.items, [{ id: "1", title: "confirmed" }]);
    fresh.resolve(page([{ id: "fresh-page" }]));
    assert.equal(await next, true);
    assert.deepEqual(column.items, [{ id: "1", title: "confirmed" }, { id: "fresh-page" }]);
  }
});

test("opt-in invalid cursor recovery explicitly reloads the first page and merges matching IDs", async () => {
  for (const code of ["INVALID_CURSOR", "CURSOR_SCOPE_MISMATCH"]) {
    const column = new ColumnPagination(true);
    await column.load(async () => page([{ id: "1", title: "old" }], "page-2"));
    await column.load(async () => page([{ id: "2", title: "second page" }], "page-3"));
    assert.equal(await column.load(async () => { throw { body: { code } }; }), false);
    assert.equal(column.cursor, null);
    assert.equal(column.loaded, false);
    assert.deepEqual(column.items.map(item => item.id), ["1", "2"]);
    assert.equal(column.error.body.code, code);
    const first = deferred();
    const reloading = column.load(async cursor => {
      assert.equal(cursor, undefined);
      return first.promise;
    });
    assert.deepEqual(column.items.map(item => item.id), ["1", "2"], "first-page retry keeps the current projection visible");
    first.resolve(page([{ id: "1", title: "fresh" }, { id: "3", title: "new" }], "fresh-page-2"));
    assert.equal(await reloading, true);
    assert.deepEqual(column.items, [{ id: "1", title: "fresh" }, { id: "2", title: "second page" }, { id: "3", title: "new" }]);
    assert.equal(column.cursor, "fresh-page-2");
    assert.equal(column.loaded, true);
    assert.equal(column.error, null);
  }
});

test("explicit project or filter reset still clears loaded items and pagination state", async () => {
  const column = new ColumnPagination(true);
  await column.load(async () => page([{ id: "1" }], "next"));
  await column.load(async () => { throw new Error("offline"); });
  column.reconcile(items => [...items, { id: "confirmed" }]);
  column.reset();
  assert.deepEqual(column.items, []);
  assert.equal(column.cursor, null);
  assert.equal(column.loaded, false);
  assert.equal(column.loading, false);
  assert.equal(column.error, null);
});
