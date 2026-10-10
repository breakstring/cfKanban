import { validationError } from "../kernel/errors.ts";

export const TREND_DAY_MS = 86_400_000;
export const MAX_TREND_DAYS = 365;

export interface TrendTotals {
  total: number;
  done: number;
  canceled: number;
}

export interface TrendDelta {
  date: string;
  total_delta: number;
  done_delta: number;
  canceled_delta: number;
  created: number;
  completed: number;
  reopened: number;
}

export interface TrendProjection {
  current: TrendTotals;
  created_date: string;
  stock_from: string | null;
  flow_from: string | null;
  deltas: readonly TrendDelta[];
}

export interface TrendPoint {
  date: string;
  total: number | null;
  done: number | null;
  canceled: number | null;
  unfinished: number | null;
  created: number | null;
  completed: number | null;
  reopened: number | null;
}

export function utcTrendDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function trendWindow(url: URL, now: number): { days: number; from: string; to: string; dates: string[] } {
  const values = url.searchParams.getAll("days");
  const input = values[0] ?? "30";
  if (values.length > 1 || !/^[1-9]\d{0,2}$/.test(input) || Number(input) > MAX_TREND_DAYS) {
    throw validationError("invalid_trend_days", { field: "days", maximum: MAX_TREND_DAYS });
  }
  const days = Number(input);
  const today = Date.parse(`${utcTrendDate(now)}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, index) => utcTrendDate(today - (days - 1 - index) * TREND_DAY_MS));
  return { days, from: dates[0]!, to: dates.at(-1)!, dates };
}

function validTotals(value: TrendTotals): boolean {
  return [value.total, value.done, value.canceled].every(count => Number.isSafeInteger(count) && count >= 0)
    && value.done + value.canceled <= value.total;
}

// 从当前真实存量扣除所选日之后的变化，不读取窗口之前的累计历史。
export function aggregateTrendPoints(dates: readonly string[], projects: readonly TrendProjection[]): TrendPoint[] {
  const points = dates.map(date => ({ date, total: 0, done: 0, canceled: 0, unfinished: 0,
    created: 0, completed: 0, reopened: 0 } as TrendPoint));
  for (const project of projects) {
    const deltas = new Map(project.deltas.map(delta => [delta.date, delta]));
    const stock = { ...project.current };
    for (let index = dates.length - 1; index >= 0; index--) {
      const date = dates[index]!;
      const point = points[index]!;
      const delta = deltas.get(date);
      const beforeCreation = date < project.created_date;
      const stockKnown = beforeCreation || (project.stock_from !== null && date >= project.stock_from && validTotals(stock));
      const flowKnown = beforeCreation || (project.flow_from !== null && date >= project.flow_from);
      if (!stockKnown) {
        point.total = point.done = point.canceled = point.unfinished = null;
      } else if (point.total !== null) {
        const value = beforeCreation ? { total: 0, done: 0, canceled: 0 } : stock;
        point.total += value.total;
        point.done! += value.done;
        point.canceled! += value.canceled;
        point.unfinished! += value.total - value.done - value.canceled;
      }
      if (!flowKnown) {
        point.created = point.completed = point.reopened = null;
      } else if (point.created !== null && !beforeCreation) {
        point.created += delta?.created ?? 0;
        point.completed! += delta?.completed ?? 0;
        point.reopened! += delta?.reopened ?? 0;
      }
      stock.total -= delta?.total_delta ?? 0;
      stock.done -= delta?.done_delta ?? 0;
      stock.canceled -= delta?.canceled_delta ?? 0;
    }
  }
  for (const point of points) {
    if (point.total !== null && !validTotals({ total: point.total, done: point.done!, canceled: point.canceled! })) {
      point.total = point.done = point.canceled = point.unfinished = null;
    }
    if ([point.created, point.completed, point.reopened].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
      point.created = point.completed = point.reopened = null;
    }
  }
  return points;
}
