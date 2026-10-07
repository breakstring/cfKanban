<script lang="ts">
export interface HistoryPointView {
  day: string;
  value: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  observedAt: string | null;
}

export function historyGeometry(points: readonly HistoryPointView[]) {
  const maximum = Math.max(1, ...points.flatMap(point => point.value !== null && Number.isFinite(point.value) && point.value >= 0 ? [point.value] : []));
  const start = Date.parse(points[0]?.day ?? "");
  const end = Date.parse(points.at(-1)?.day ?? "");
  const segments: string[] = [];
  const dots: { day: string; x: number; y: number }[] = [];
  let segment: string[] = [];
  let previousDay: number | null = null;
  const finish = () => { if (segment.length) segments.push(segment.join(" ")); segment = []; };
  for (const point of points) {
    const date = Date.parse(point.day);
    if (!Number.isFinite(date) || point.value === null || !Number.isFinite(point.value) || point.value < 0) {
      finish(); previousDay = null; continue;
    }
    if (previousDay !== null && date - previousDay !== 86_400_000) finish();
    const x = end > start ? 36 + (date - start) / (end - start) * 588 : 330;
    const y = 180 - point.value / maximum * 144;
    segment.push(`${x},${y}`); dots.push({ day: point.day, x, y }); previousDay = date;
  }
  finish();
  return { maximum, segments, dots };
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { locale } from "../lib/i18n";

const props = defineProps<{ label: string; unit: string; points: HistoryPointView[] }>();
const geometry = computed(() => historyGeometry(props.points));
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const number = (value: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);
const tick = (value: number) => new Intl.NumberFormat(locale.value, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const valueText = (value: number | null) => value === null ? ui("Unknown", "未知") : `${number(value)} ${props.unit}`;
const utc = (value: string | null) => value === null ? ui("Unknown", "未知") : value.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
</script>

<template>
  <figure class="history-chart">
    <figcaption>{{ label }} <span class="muted-copy">({{ unit }})</span></figcaption>
    <svg v-if="geometry.dots.length" viewBox="0 0 660 216" role="img" :aria-label="`${label} · ${ui('UTC daily history; missing values are gaps', 'UTC 日历史；缺失值保留断点')}`">
      <path class="history-axis" d="M36 24V180H624" />
      <text x="32" y="29" text-anchor="end">{{ tick(geometry.maximum) }}</text>
      <text x="32" y="184" text-anchor="end">0</text>
      <polyline v-for="(segment, index) in geometry.segments" :key="index" :points="segment" class="history-line" />
      <circle v-for="dot in geometry.dots" :key="dot.day" :cx="dot.x" :cy="dot.y" r="3" class="history-dot" />
      <text x="36" y="204">{{ points[0]?.day }}</text>
      <text x="624" y="204" text-anchor="end">{{ points.at(-1)?.day }}</text>
    </svg>
    <p v-else class="muted-copy">{{ ui('No observed values in this window. Missing values are not zero.', '此窗口暂无观测值，缺失值不代表零。') }}</p>
    <details>
      <summary>{{ ui('Daily values and observation windows', '每日数值与观测窗口') }}</summary>
      <div class="history-table-wrap" tabindex="0" :aria-label="ui('Daily history table', '每日历史表格')">
        <table>
          <thead><tr><th>{{ ui('UTC day', 'UTC 日期') }}</th><th>{{ ui('Value', '数值') }}</th><th>{{ ui('Window', '统计窗口') }}</th><th>{{ ui('Observed', '观测时间') }}</th></tr></thead>
          <tbody><tr v-for="point in points" :key="point.day"><th scope="row">{{ point.day }}</th><td>{{ valueText(point.value) }}</td><td>{{ utc(point.periodStart) }} — {{ utc(point.periodEnd) }}</td><td>{{ utc(point.observedAt) }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </figure>
</template>

<style scoped>
.history-chart { margin: 20px 0; }
.history-chart figcaption { font-weight: 600; }
.history-chart svg { display: block; width: 100%; max-width: 780px; overflow: visible; margin-top: 8px; }
.history-chart text { fill: var(--color-text-muted); font-size: 11px; }
.history-axis { stroke: var(--color-border-strong); stroke-width: 1; fill: none; }
.history-line { stroke: var(--color-primary); stroke-width: 2; fill: none; }
.history-dot { fill: var(--color-primary); }
.history-chart summary { cursor: pointer; }
.history-table-wrap { overflow-x: auto; margin-top: 12px; }
.history-chart table { border-collapse: collapse; min-width: 620px; width: 100%; font-size: 13px; }
.history-chart th, .history-chart td { padding: 8px; border-bottom: 1px solid var(--color-border); text-align: left; vertical-align: top; }
.history-chart td { font-variant-numeric: tabular-nums; }
</style>
