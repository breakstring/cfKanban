import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTrendPoints, trendWindow } from "../../apps/worker/src/domain/issue-trends.ts";

test("UTC daily windows include today and strictly bound caller input", () => {
  const now = Date.parse("2026-10-10T00:30:00+08:00");
  assert.deepEqual(trendWindow(new URL("https://example.test/?days=2"), now), {
    days: 2, from: "2026-10-08", to: "2026-10-09", dates: ["2026-10-08", "2026-10-09"],
  });
  for (const query of ["days=0", "days=366", "days=2&days=3", "days=", "days=1.5", "days=030"]) {
    assert.throws(() => trendWindow(new URL(`https://example.test/?${query}`), now), error =>
      error.code === "VALIDATION_ERROR" && error.details.reason === "invalid_trend_days");
  }
});

test("completion, reopen, cancel and membership changes reconstruct stock separately from throughput", () => {
  const points = aggregateTrendPoints(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"], [{
    current: { total: 3, done: 1, canceled: 1 }, created_date: "2026-10-07",
    stock_from: "2026-10-07", flow_from: "2026-10-07", deltas: [
      { date: "2026-10-07", total_delta: 2, done_delta: 0, canceled_delta: 0, created: 2, completed: 0, reopened: 0 },
      { date: "2026-10-08", total_delta: 0, done_delta: 1, canceled_delta: 0, created: 0, completed: 1, reopened: 0 },
      { date: "2026-10-09", total_delta: 0, done_delta: -1, canceled_delta: 1, created: 0, completed: 0, reopened: 1 },
      { date: "2026-10-10", total_delta: 1, done_delta: 1, canceled_delta: 0, created: 0, completed: 1, reopened: 0 },
    ],
  }]);
  assert.deepEqual(points.map(point => [point.total, point.done, point.canceled, point.unfinished]),
    [[2, 0, 0, 2], [2, 1, 0, 1], [2, 0, 1, 1], [3, 1, 1, 1]]);
  assert.deepEqual(points.map(point => point.created), [2, 0, 0, 0]);
  assert.deepEqual(points.map(point => point.completed), [0, 1, 0, 1]);
});

test("aggregate never silently drops a project's missing history or treats it as zero", () => {
  const dates = ["2026-10-08", "2026-10-09", "2026-10-10"];
  const complete = { current: { total: 2, done: 1, canceled: 0 }, created_date: "2026-10-01",
    stock_from: "2026-10-01", flow_from: "2026-10-01", deltas: [] };
  const partial = { current: { total: 1, done: 0, canceled: 0 }, created_date: "2026-10-01",
    stock_from: "2026-10-09", flow_from: "2026-10-10", deltas: [] };
  const points = aggregateTrendPoints(dates, [complete, partial]);
  assert.equal(points[0].total, null);
  assert.equal(points[1].total, 3);
  assert.equal(points[1].created, null);
  assert.equal(points[2].created, 0);
  assert.equal(points[2].unfinished, 2);
  assert.equal(aggregateTrendPoints(dates, [{ ...partial, created_date: "2026-10-09" }])[0].total, 0);
});

test("inconsistent projection stays unknown instead of rendering negative Issue counts", () => {
  const result = aggregateTrendPoints(["2026-10-09", "2026-10-10"], [{
    current: { total: 1, done: 0, canceled: 0 }, created_date: "2026-10-01",
    stock_from: "2026-10-01", flow_from: "2026-10-01",
    deltas: [{ date: "2026-10-10", total_delta: 2, done_delta: 0, canceled_delta: 0, created: 2, completed: 0, reopened: 0 }],
  }]);
  assert.equal(result[0].total, null);
  assert.equal(result[1].total, 1);
});

test("aggregate does not expose imprecise counts beyond safe integers", () => {
  const project = { current: { total: Number.MAX_SAFE_INTEGER, done: 0, canceled: 0 },
    created_date: "2026-10-01", stock_from: "2026-10-01", flow_from: "2026-10-01",
    deltas: [{ date: "2026-10-10", total_delta: 0, done_delta: 0, canceled_delta: 0,
      created: Number.MAX_SAFE_INTEGER, completed: 0, reopened: 0 }] };
  const point = aggregateTrendPoints(["2026-10-10"], [project, project])[0];
  assert.equal(point.total, null);
  assert.equal(point.created, null);
});
