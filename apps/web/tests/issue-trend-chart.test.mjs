import assert from 'node:assert/strict';
import test from 'node:test';
import { issueTrendGeometry, issueTrendValue } from '../src/lib/issue-trend-chart.ts';

const series = [{ key: 'total', label: 'Scope' }, { key: 'done', label: 'Completed' }];

test('an empty or wholly unknown window has no invented observations', () => {
  for (const points of [[], [{ date: '2026-10-01', total: null, done: null }]]) {
    const chart = issueTrendGeometry(points, series);
    assert.equal(chart.hasValues, false);
    assert.equal(chart.series.every(item => item.dots.length === 0 && item.segments.length === 0), true);
    assert.equal(chart.yTicks.every(tick => Number.isFinite(tick.y)), true);
  }
});

test('an observed zero is rendered while unknown counts keep independent series gaps', () => {
  const points = [
    { date: '2026-10-01', total: 8, done: 0 },
    { date: '2026-10-02', total: null, done: 2 },
    { date: '2026-10-03', total: 9, done: 3 },
  ];
  const chart = issueTrendGeometry(points, series);
  assert.equal(chart.series[0].segments.length, 2);
  assert.equal(chart.series[0].dots.length, 2);
  assert.equal(chart.series[1].segments.length, 1);
  assert.equal(chart.series[1].dots[0].value, 0);
  assert.equal(chart.series[1].dots[0].y, chart.plot.bottom);
});

test('missing dates break every line and date distance controls horizontal position', () => {
  const chart = issueTrendGeometry([
    { date: '2026-10-01', total: 8, done: 2 },
    { date: '2026-10-02', total: 8, done: 3 },
    { date: '2026-10-05', total: 7, done: 5 },
  ], series);
  assert.equal(chart.series.every(item => item.segments.length === 2), true);
  const dots = chart.series[0].dots;
  assert.ok(Math.abs((dots[2].x - dots[1].x) / (dots[1].x - dots[0].x) - 3) < 1e-10);
  assert.deepEqual(chart.xTicks.map(tick => tick.date), ['2026-10-01', '2026-10-02', '2026-10-05']);
});

test('all lines share an integer count scale without clipping the larger series', () => {
  const chart = issueTrendGeometry([
    { date: '2026-10-01', total: 127, done: 8 },
    { date: '2026-10-02', total: 127, done: 127 },
  ], series);
  assert.ok(chart.maximum >= 127);
  assert.ok(chart.yTicks.length <= 6);
  assert.equal(chart.yTicks.every(tick => Number.isInteger(tick.value)), true);
  assert.equal(chart.series[0].dots[1].y, chart.series[1].dots[1].y);
  assert.equal(chart.series.flatMap(item => item.dots).every(dot => dot.y >= chart.plot.top && dot.y <= chart.plot.bottom), true);
});

test('a single UTC day remains visible and invalid dates or counts cannot become observations', () => {
  const single = issueTrendGeometry([{ date: '2026-10-01', total: 0, done: 0 }], series);
  assert.equal(single.hasValues, true);
  assert.equal(Number.isFinite(single.series[0].dots[0].x), true);
  assert.equal(single.days[0].hitWidth, single.plot.right - single.plot.left);
  const invalid = issueTrendGeometry([
    { date: '2026-02-30', total: 5000, done: 5000 },
    { date: '2026-10-01', total: '12', done: -1 },
    { date: '2026-10-02T00:00:00Z', total: 5, done: 2 },
    { date: '2026-10-03', total: Infinity, done: 1.5 },
  ], series);
  assert.equal(invalid.hasValues, false);
  assert.equal(invalid.maximum, single.maximum);
  assert.equal(issueTrendValue({ date: '2026-10-01', count: Number.MAX_SAFE_INTEGER + 1 }, 'count'), null);
});

test('date axes include unknown days and geometry does not mutate the response', () => {
  const points = [
    { date: '2026-10-01', total: 7, done: 0 },
    { date: '2026-10-02', total: null, done: null },
    { date: '2026-10-03', total: 7, done: 2 },
  ];
  const before = structuredClone(points);
  const chart = issueTrendGeometry(points, series);
  assert.equal(chart.days.length, 3);
  assert.equal(chart.days[1].date, '2026-10-02');
  assert.deepEqual(points, before);
  assert.deepEqual(series, [{ key: 'total', label: 'Scope' }, { key: 'done', label: 'Completed' }]);
});
