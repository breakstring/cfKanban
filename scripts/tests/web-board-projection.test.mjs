import assert from "node:assert/strict";
import test from "node:test";
import { matchesBoardFilters, sortBoardIssues } from "../../apps/web/src/lib/board-projection.ts";
import { loadedStatusLabel, moveStatusNavigationFocus, scrollToStatusColumn } from "../../apps/web/src/lib/kanban-status-navigation.ts";

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

test("status navigation moves only its board's horizontal scroll and ignores columns outside its current view", () => {
  const calls = [];
  const column = { id: "done-column", getBoundingClientRect: () => ({ left: 920 }), scrollIntoView: () => assert.fail("column navigation must not scroll the page") };
  const region = { scrollLeft: 260, scrollTop: 70, clientLeft: 2, getBoundingClientRect: () => ({ left: 100 }), querySelectorAll: () => [column], scrollTo: value => calls.push(value) };
  assert.equal(scrollToStatusColumn(region, "done-column"), true);
  assert.deepEqual(calls, [{ left: 1078, top: 70, behavior: "auto" }]);
  assert.equal(scrollToStatusColumn(region, "filtered-out-column"), false);
  assert.equal(scrollToStatusColumn(null, "done-column"), false);
  assert.equal(calls.length, 1);
});

test("status shortcuts describe loaded counts and remaining pages in both languages without claiming totals", () => {
  const row = { key: "todo", display_name: "待办", loaded: 25, has_more: true, target_id: "todo-column" };
  assert.match(loadedStatusLabel(row, true), /待办 · 已加载 25 条，还有未加载事项/);
  assert.match(loadedStatusLabel({ ...row, display_name: "Todo" }, false), /Todo · 25 loaded issues, more pages available/);
  assert.doesNotMatch(loadedStatusLabel({ ...row, loaded: 0, has_more: false }, true), /还有|总数|共计/);
  assert.doesNotMatch(loadedStatusLabel({ ...row, has_more: false }, false), /more pages|total/i);
});

test("status shortcut arrow and edge keys keep focus and overflow movement inside the navigation", () => {
  const focus = [];
  const scroll = [];
  const buttons = [{ left: 0, right: 80 }, { left: 80, right: 160 }, { left: 220, right: 300 }].map((bounds, index) => ({ closest: () => buttons[index], focus: options => focus.push({ index, options }), getBoundingClientRect: () => bounds }));
  const region = { scrollLeft: 0, scrollTop: 9, querySelectorAll: () => buttons, getBoundingClientRect: () => ({ left: 0, right: 200 }), scrollTo: value => scroll.push(value) };
  let prevented = 0;
  const event = (key, index = 0) => ({ key, target: buttons[index], preventDefault: () => prevented++ });
  moveStatusNavigationFocus(region, event("ArrowRight"));
  moveStatusNavigationFocus(region, event("End"));
  moveStatusNavigationFocus(region, event("ArrowRight", 2));
  moveStatusNavigationFocus(region, event("Home", 2));
  assert.deepEqual(focus.map(row => row.index), [1, 2, 0, 0]);
  assert.ok(focus.every(row => row.options.preventScroll));
  assert.deepEqual(scroll, [{ left: 100, top: 9, behavior: "auto" }]);
  assert.equal(prevented, 4);
  moveStatusNavigationFocus(region, event("Enter"));
  moveStatusNavigationFocus(null, event("ArrowRight"));
  assert.equal(prevented, 4);
});
