import assert from "node:assert/strict";
import test from "node:test";
import { matchesBoardFilters, sortBoardIssues } from "../../apps/web/src/lib/board-projection.ts";

const issue = (overrides = {}) => ({ id: "issue", number: 123, title: "Ｆｉｘ Login CFK-456", deleted_at: null,
  priority: "high", labels: [{ id: "bug", name: "bug" }], updated_at: "2026-10-01T10:00:00.000Z", ...overrides });
const filters = (overrides = {}) => ({ search: "", priorities: [], labels: [], ...overrides });

test("board projection uses applied server search normalization and identifier-or-title semantics", () => {
  for (const search of [" fix login ", "ＦＩＸ", "CFK-123", "cfk-456"]) assert.equal(matchesBoardFilters(issue(), filters({ search })), true);
  assert.equal(matchesBoardFilters(issue(), filters({ search: "CFK-124" })), false);
  assert.equal(matchesBoardFilters(issue({ title: "Other", number: 1 }), filters({ search: "cfk-01" })), false);
});
test("confirmed cards enter or leave combined priority/label filters without including deleted Issues", () => {
  const applied = filters({ search: "login", priorities: ["high", "urgent"], labels: ["bug", "performance"] });
  assert.equal(matchesBoardFilters(issue(), applied), true);
  for (const change of [{ priority: "low" }, { labels: [] }, { title: "Other" }, { deleted_at: "2026-10-01T11:00:00.000Z" }]) {
    assert.equal(matchesBoardFilters(issue(change), applied), false);
  }
  assert.equal(matchesBoardFilters(issue({ labels: [{ id: "performance" }] }), applied), true);
});
test("local card updates preserve the public updated_at/number descending order", () => {
  const rows = [issue({ id: "old", number: 999, updated_at: "2026-10-01T09:00:00.000Z" }),
    issue({ id: "tie-low", number: 1 }), issue({ id: "tie-high", number: 2 }),
    issue({ id: "saved", number: 3, updated_at: "2026-10-01T10:01:00.000Z" })];
  assert.deepEqual(sortBoardIssues(rows).map(item => item.id), ["saved", "tie-high", "tie-low", "old"]);
});
