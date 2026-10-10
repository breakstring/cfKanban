<script setup lang="ts">
import { computed, ref } from "vue";
import { locale } from "../lib/i18n";
import { issueTrendGeometry, issueTrendValue, type IssueTrendPoint, type IssueTrendSeries } from "../lib/issue-trend-chart";

const props = defineProps<{ label: string; points: IssueTrendPoint[]; series: IssueTrendSeries[] }>();
const geometry = computed(() => issueTrendGeometry(props.points, props.series));
const selectedDate = ref<string | null>(null);
const selectedDay = computed(() => geometry.value.days.find(day => day.date === selectedDate.value));
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const number = (value: number) => new Intl.NumberFormat(locale.value).format(value);
const valueText = (value: number | null) => value === null ? ui("Unknown", "未知") : `${number(value)} ${ui("issues", "件")}`;
const color = (item: IssueTrendSeries, index: number) => item.color ?? ["var(--color-primary)", "var(--color-success)", "var(--color-text-muted)"][index % 3]!;
const dash = (index: number) => index % 3 === 1 ? "7 4" : index % 3 === 2 ? "2 4" : undefined;
const dayDescription = (index: number) => {
  const point = props.points[index]!;
  return `${point.date} UTC · ${props.series.map(item => `${item.label}: ${valueText(issueTrendValue(point, item.key))}`).join(" · ")}`;
};
</script>

<template>
  <figure class="issue-trend-chart">
    <figcaption>{{ label }} <span class="muted-copy">({{ ui('issues', '件') }})</span></figcaption>
    <ul class="trend-legend" :aria-label="ui('Chart series', '图表序列')">
      <li v-for="(item, index) in series" :key="item.key">
        <svg viewBox="0 0 30 8" aria-hidden="true"><line x1="0" y1="4" x2="30" y2="4" :stroke="color(item, index)" :stroke-dasharray="dash(index)" stroke-width="2" /></svg>
        {{ item.label }}
      </li>
    </ul>
    <div v-if="geometry.hasValues" class="trend-plot">
      <svg :viewBox="`0 0 ${geometry.viewport.width} ${geometry.viewport.height}`" role="group" :aria-label="`${label} · ${ui('UTC daily history; missing values are gaps', 'UTC 日历史；缺失值保留断点')}`" @pointerleave="selectedDate = null">
        <g v-for="tick in geometry.yTicks" :key="tick.value" class="trend-tick">
          <line :x1="geometry.plot.left" :x2="geometry.plot.right" :y1="tick.y" :y2="tick.y" />
          <text :x="geometry.plot.left - 12" :y="tick.y + 4" text-anchor="end">{{ number(tick.value) }}</text>
        </g>
        <path class="trend-axis" :d="`M${geometry.plot.left} ${geometry.plot.top}V${geometry.plot.bottom}H${geometry.plot.right}`" />
        <g v-for="item in geometry.series" :key="item.key" :style="{ color: color(item, item.seriesIndex) }">
          <polyline v-for="(segment, index) in item.segments" :key="index" :points="segment" class="trend-line" :stroke-dasharray="dash(item.seriesIndex)" />
          <circle v-for="dot in item.dots" :key="dot.pointIndex" :cx="dot.x" :cy="dot.y" :r="selectedDate === dot.date ? 4 : 2.5" class="trend-dot" />
        </g>
        <line v-if="selectedDay" class="trend-cursor" :x1="selectedDay.x" :x2="selectedDay.x" :y1="geometry.plot.top" :y2="geometry.plot.bottom" />
        <text v-for="(tick, index) in geometry.xTicks" :key="tick.date" :x="tick.x" :y="geometry.plot.bottom + 26" :text-anchor="geometry.xTicks.length === 1 ? 'middle' : index === 0 ? 'start' : index === geometry.xTicks.length - 1 ? 'end' : 'middle'">{{ tick.date }}</text>
        <rect v-for="day in geometry.days" :key="day.date" class="trend-hit-area" :x="day.hitLeft" :y="geometry.plot.top" :width="day.hitWidth" :height="geometry.plot.bottom - geometry.plot.top" tabindex="0" role="img" :aria-label="dayDescription(day.pointIndex)" @pointerenter="selectedDate = day.date" @focus="selectedDate = day.date" @blur="selectedDate = null" @keydown.esc="selectedDate = null">
          <title>{{ dayDescription(day.pointIndex) }}</title>
        </rect>
      </svg>
      <div v-if="selectedDay" class="trend-tooltip" aria-hidden="true">
        <strong>{{ selectedDay.date }} UTC</strong>
        <div v-for="(item, index) in series" :key="item.key"><span class="trend-tooltip-dot" :style="{ background: color(item, index) }" />{{ item.label }} <b>{{ valueText(issueTrendValue(points[selectedDay.pointIndex]!, item.key)) }}</b></div>
      </div>
    </div>
    <p v-else class="trend-empty muted-copy">{{ ui('No observed values in this window. Missing values are not zero.', '此窗口暂无观测值，缺失值不代表零。') }}</p>
    <p class="trend-hint muted-copy">{{ ui('Dates use UTC. Hover or focus a day for values; missing days remain gaps.', '日期使用 UTC。悬浮或聚焦日期可查看数值；缺失日期保留断点。') }}</p>
  </figure>
</template>

<style scoped>
.issue-trend-chart { min-width: 0; margin: 0; padding: 20px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-surface); }
.issue-trend-chart figcaption { font-size: 1rem; font-weight: 600; }
.issue-trend-chart figcaption span { font-size: 0.85rem; font-weight: 400; }
.trend-legend { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 0; margin: 12px 0 8px; list-style: none; color: var(--color-text-muted); font-size: 0.85rem; }
.trend-legend li { display: flex; align-items: center; gap: 7px; }
.trend-legend svg { width: 30px; height: 8px; }
.trend-plot { position: relative; }
.trend-plot > svg { display: block; width: 100%; overflow: visible; }
.trend-plot text { fill: var(--color-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.trend-tick line { stroke: var(--color-border); stroke-width: 1; stroke-dasharray: 3 4; }
.trend-axis { stroke: var(--color-border-strong); stroke-width: 1; fill: none; }
.trend-line { stroke: currentColor; stroke-width: 2.5; fill: none; vector-effect: non-scaling-stroke; }
.trend-dot { fill: currentColor; }
.trend-cursor { stroke: var(--color-text-muted); stroke-width: 1; stroke-dasharray: 4 4; pointer-events: none; }
.trend-hit-area { fill: transparent; outline: none; }
.trend-hit-area:focus-visible { stroke: var(--color-primary); stroke-width: 1.5; stroke-dasharray: 4 3; }
.trend-tooltip { position: absolute; top: 8px; right: 8px; max-width: calc(100% - 16px); padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: 8px; background: var(--color-surface); box-shadow: 0 3px 12px #20201f12; font-size: 0.8rem; pointer-events: none; }
.trend-tooltip strong { display: block; margin-bottom: 6px; }
.trend-tooltip > div { display: flex; align-items: center; gap: 7px; margin-top: 4px; }
.trend-tooltip b { margin-left: auto; padding-left: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.trend-tooltip-dot { width: 7px; height: 7px; flex-shrink: 0; border-radius: 50%; }
.trend-empty { min-height: 180px; display: flex; align-items: center; justify-content: center; margin: 0; text-align: center; }
.trend-hint { margin: 6px 0 0; font-size: 0.8rem; }
@media (max-width: 640px) {
  .issue-trend-chart { padding: 16px 12px; }
  .trend-plot { overflow-x: auto; }
  .trend-plot > svg { min-width: 560px; }
  .trend-tooltip { position: sticky; bottom: 4px; right: auto; width: fit-content; margin: -10px 4px 8px; }
}
</style>
