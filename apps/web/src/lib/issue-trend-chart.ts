export interface IssueTrendPoint {
  date: string;
  [key: string]: string | number | null;
}

export interface IssueTrendSeries {
  key: string;
  label: string;
  color?: string;
}

export interface IssueTrendDot {
  date: string;
  pointIndex: number;
  value: number;
  x: number;
  y: number;
}

const DAY_MILLISECONDS = 86_400_000;
const viewport = { width: 960, height: 292 };
const plot = { left: 60, right: 936, top: 20, bottom: 244 };

function utcDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? timestamp : null;
}

export function issueTrendValue(point: IssueTrendPoint, key: string): number | null {
  const value = point[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countScale(maximum: number) {
  const targetStep = Math.max(1, maximum / 4);
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = ([1, 2, 5, 10].find(multiplier => multiplier * magnitude >= targetStep) ?? 10) * magnitude;
  const upper = Math.max(1, Math.ceil(maximum / step)) * step;
  return { upper, step };
}

export function issueTrendGeometry(points: readonly IssueTrendPoint[], series: readonly IssueTrendSeries[]) {
  const timestamps = points.map(point => utcDay(point.date));
  const dayEntries = new Map<number, { date: string; pointIndex: number }>();
  for (const [index, timestamp] of timestamps.entries()) {
    if (timestamp !== null && !dayEntries.has(timestamp)) dayEntries.set(timestamp, { date: points[index]!.date, pointIndex: index });
  }
  const orderedDays = [...dayEntries.entries()].sort(([left], [right]) => left - right);
  const start = orderedDays[0]?.[0] ?? 0;
  const end = orderedDays.at(-1)?.[0] ?? start;
  const x = (timestamp: number) => end > start
    ? plot.left + (timestamp - start) / (end - start) * (plot.right - plot.left)
    : (plot.left + plot.right) / 2;
  let maximum = 0;
  for (const [index, point] of points.entries()) {
    if (timestamps[index] === null) continue;
    for (const item of series) maximum = Math.max(maximum, issueTrendValue(point, item.key) ?? 0);
  }
  const { upper, step } = countScale(maximum);
  const y = (value: number) => plot.bottom - value / upper * (plot.bottom - plot.top);
  const yTicks = Array.from({ length: Math.round(upper / step) + 1 }, (_, index) => ({ value: index * step, y: y(index * step) }));
  const days = orderedDays.map(([timestamp, entry]) => ({ ...entry, x: x(timestamp) }));
  const columns = days.map((day, index) => {
    const left = index ? (days[index - 1]!.x + day.x) / 2 : plot.left;
    const right = index + 1 < days.length ? (day.x + days[index + 1]!.x) / 2 : plot.right;
    return { ...day, hitLeft: left, hitWidth: right - left };
  });
  const tickCount = Math.min(5, days.length);
  const xTicks = Array.from({ length: tickCount }, (_, index) => days[tickCount === 1 ? 0 : Math.round(index * (days.length - 1) / (tickCount - 1))]!);
  const renderedSeries = series.map((item, seriesIndex) => {
    const segments: string[] = [];
    const dots: IssueTrendDot[] = [];
    let segment: string[] = [];
    let previousDay: number | null = null;
    const finish = () => {
      if (segment.length) segments.push(segment.join(" "));
      segment = [];
    };
    for (const [pointIndex, point] of points.entries()) {
      const timestamp = timestamps[pointIndex] ?? null;
      const value = issueTrendValue(point, item.key);
      if (timestamp === null || value === null) {
        finish();
        previousDay = null;
        continue;
      }
      if (previousDay !== null && timestamp - previousDay !== DAY_MILLISECONDS) finish();
      const dot = { date: point.date, pointIndex, value, x: x(timestamp), y: y(value) };
      dots.push(dot);
      segment.push(`${dot.x},${dot.y}`);
      previousDay = timestamp;
    }
    finish();
    return { ...item, seriesIndex, segments, dots };
  });
  return { viewport, plot, maximum: upper, yTicks, xTicks, days: columns, series: renderedSeries, hasValues: renderedSeries.some(item => item.dots.length > 0) };
}
