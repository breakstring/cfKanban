import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
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

test('daily values remain available by keyboard focus and pointer without an expandable table', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const temporary = await mkdtemp(path.join(tmpdir(), 'cfkanban-trend-chart-'));
  const moduleFile = path.join(temporary, 'chart.mjs');
  const require = createRequire(import.meta.url);
  let app;
  try {
    await build({
      stdin: { contents: `export {default as Chart} from ${JSON.stringify(path.join(root, 'apps/web/src/components/IssueTrendChart.vue'))}; export {setLocale} from 'fixture-locale';`, resolveDir: root },
      outfile: moduleFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'chart-fixture', setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(require.resolve('vue')).href, external: true }));
        builder.onResolve({ filter: /(?:^fixture-locale$|\/lib\/i18n$)/ }, () => ({ path: 'locale', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "import {ref} from 'vue'; export const locale=ref('en'); export const setLocale=value=>locale.value=value;", loader: 'js' }));
        builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
          const { descriptor } = parse(await readFile(filename, 'utf8'), { filename });
          return { contents: compileScript(descriptor, { id: 'chart-fixture', inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(filename) };
        });
      } }],
    });
    const { Chart, setLocale } = await import(pathToFileURL(moduleFile));
    const node = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null });
    const remove = child => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; };
    const renderer = createRenderer({
      createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
      setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
      parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
      insert(child, parent, anchor = null) { remove(child); child.parent = parent; parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child); },
      remove, patchProp: (element, key, _previous, value) => { element.props[key] = value; },
    });
    const container = node('root');
    app = renderer.createApp({ render: () => h(Chart, { label: 'Scope', series: [{ key: 'total', label: 'Total' }], points: [
      { date: '2026-10-01', total: null }, { date: '2026-10-02', total: 0 }, { date: '2026-10-03', total: 4 },
    ] }) });
    app.mount(container);
    const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
    const all = () => descendants(container);
    const text = element => element.text + element.children.map(text).join('');
    const tooltip = () => all().find(item => item.props.class === 'trend-tooltip');
    const days = all().filter(item => item.tag === 'rect');
    assert.equal(days.length, 3);
    assert.equal(all().some(item => item.tag === 'details' || item.tag === 'table'), false);
    assert.equal(days.every(item => item.props.tabindex === '0' && item.props['aria-label'].includes('UTC')), true);
    assert.match(days[0].props['aria-label'], /2026-10-01 UTC · Total: Unknown/);
    days[0].props.onFocus(); await nextTick(); assert.match(text(tooltip()), /Unknown/);
    days[1].props.onFocus(); await nextTick(); assert.match(text(tooltip()), /0 issues/);
    days[1].props.onBlur(); await nextTick(); assert.equal(tooltip(), undefined);
    days[2].props.onPointerenter(); await nextTick(); assert.match(text(tooltip()), /4 issues/);
    setLocale('zh-CN'); await nextTick();
    days[0].props.onFocus(); await nextTick(); assert.match(text(tooltip()), /未知/);
    all().find(item => item.tag === 'svg' && item.props.role === 'group').props.onPointerleave(); await nextTick();
    assert.equal(tooltip(), undefined);
  } finally { app?.unmount(); await rm(temporary, { recursive: true, force: true }); }
});
