import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const built = await build({ entryPoints: [new URL("../../apps/web/src/lib/label-input.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const { labelNameKey, resolveInputLabel } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

const page = (items, next = null) => ({ items, has_more: next !== null, next_cursor: next });
test("label names follow SQLite ASCII NOCASE, preserving non-ASCII distinctions", () => {
  assert.equal(labelNameKey(" Fix "), "fix");
  assert.notEqual(labelNameKey("Ä"), labelNameKey("ä"));
});
test("reuse labels beyond the first page before attempting creation", async () => {
  const calls = [];
  const target = { id: "target", name: "BUG" };
  const result = await resolveInputLabel("bug", async cursor => {
    calls.push(cursor);
    return cursor ? page([target]) : page([{ id: "a", name: "A" }], "next");
  }, () => assert.fail("must not create an existing name"));
  assert.equal(result, target);
  assert.deepEqual(calls, [undefined, "next"]);
});
test("concurrent same-name creation resolves the winner without another write", async () => {
  let reads = 0, creates = 0;
  const winner = { id: "winner", name: "Bug" };
  const result = await resolveInputLabel("Bug", async () => page(++reads === 1 ? [] : [winner]), async () => {
    creates++;
    throw { body: { code: "LABEL_NAME_CONFLICT" } };
  });
  assert.equal(result, winner);
  assert.equal(creates, 1);
});
test("deleted-name conflicts and uncertain failures never trigger replacement creation", async () => {
  for (const code of ["LABEL_NAME_CONFLICT", "PLATFORM_UNAVAILABLE"]) {
    let creates = 0;
    const failure = { body: { code } };
    await assert.rejects(resolveInputLabel("Bug", async () => page([]), async () => {
      creates++; throw failure;
    }), error => error === failure);
    assert.equal(creates, 1);
  }
});
