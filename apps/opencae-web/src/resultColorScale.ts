import type { ResultField, StressComponent } from "@opencae/schema";
import type { ResultMode } from "./workspaceViewTypes";

export type ResultColorBands = "continuous" | "bands8";
export type ResultRangeMode = "auto" | "manual";

export interface ResultColorScaleSetting {
  rangeMode: ResultRangeMode;
  bands: ResultColorBands;
  manualMin?: number;
  manualMax?: number;
}

export type ResultColorScaleSettings = Record<string, ResultColorScaleSetting>;

export interface ResolvedResultColorScale {
  type: ResultMode;
  component?: StressComponent;
  min: number;
  max: number;
  bands: ResultColorBands;
}

const STRESS_RAMP = ["#0759d6", "#0ea5e9", "#22c55e", "#facc15", "#f97316", "#ef4444"];
const MOTION_RAMP = ["#0759d6", "#0ea5e9", "#10b8f0", "#2ee875", "#f2e94e", "#ff8f1f", "#ef4444"];
// Low factors of safety are dangerous and remain red; high values remain green.
const SAFETY_RAMP = ["#ef4444", "#fb923c", "#facc15", "#a3e635", "#4ade80", "#22c55e"];
const DIVERGING_NEGATIVE = "#2563eb";
const DIVERGING_NEUTRAL = "#f5f5f4";
const DIVERGING_POSITIVE = "#dc2626";
const BAND_COUNT = 8;

export const DEFAULT_RESULT_COLOR_SCALE_SETTING: ResultColorScaleSetting = Object.freeze({
  rangeMode: "auto",
  bands: "continuous"
});

export function isDivergingStressComponent(component: StressComponent | undefined): boolean {
  return component === "principal_max" || component === "principal_min";
}

export function resultScaleRangeEpsilon(min: number, max: number): number {
  return Math.max(1, Math.abs(min), Math.abs(max)) * 1e-12;
}

export function validManualResultRange(min: number | undefined, max: number | undefined): min is number {
  return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && max - min > resultScaleRangeEpsilon(min, max);
}

export function automaticResultFieldRange(fields: ResultField[], semanticKey: (field: ResultField) => string, activeField: ResultField): { min: number; max: number } {
  const activeKey = semanticKey(activeField);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const field of fields) {
    if (semanticKey(field) !== activeKey) continue;
    if (Number.isFinite(field.min)) min = Math.min(min, field.min);
    if (Number.isFinite(field.max)) max = Math.max(max, field.max);
  }
  if (Number.isFinite(min) && Number.isFinite(max) && max - min > resultScaleRangeEpsilon(min, max)) return { min, max };
  const fallbackMin = Number.isFinite(activeField.min) ? activeField.min : 0;
  const fallbackMax = Number.isFinite(activeField.max) ? activeField.max : fallbackMin + 1;
  return fallbackMax - fallbackMin > resultScaleRangeEpsilon(fallbackMin, fallbackMax)
    ? { min: fallbackMin, max: fallbackMax }
    : { min: fallbackMin, max: fallbackMin + Math.max(1, Math.abs(fallbackMin)) * 1e-6 };
}

export function resolveResultColorScale({
  type,
  component,
  automaticRange,
  setting = DEFAULT_RESULT_COLOR_SCALE_SETTING
}: {
  type: ResultMode;
  component?: StressComponent;
  automaticRange: { min: number; max: number };
  setting?: ResultColorScaleSetting;
}): ResolvedResultColorScale {
  const manual = setting.rangeMode === "manual" && validManualResultRange(setting.manualMin, setting.manualMax);
  return {
    type,
    ...(component ? { component } : {}),
    min: manual ? setting.manualMin! : automaticRange.min,
    max: manual ? setting.manualMax! : automaticRange.max,
    bands: setting.bands
  };
}

export function normalizedResultScaleValue(value: number, scale: Pick<ResolvedResultColorScale, "min" | "max">): number {
  if (!Number.isFinite(value)) return 0;
  const span = scale.max - scale.min;
  if (!Number.isFinite(span) || span <= resultScaleRangeEpsilon(scale.min, scale.max)) return 0;
  return clamp01((value - scale.min) / span);
}

export function resultColorForValue(value: number, scale: ResolvedResultColorScale): string {
  const normalized = normalizedResultScaleValue(value, scale);
  const sample = scale.bands === "bands8" ? quantizedBandSample(normalized) : normalized;
  return colorAtScalePosition(sample, scale);
}

export function resultColorAtNormalized(type: ResultMode, component: StressComponent | undefined, value: number, bands: ResultColorBands = "continuous"): string {
  const normalized = clamp01(value);
  const sample = bands === "bands8" ? quantizedBandSample(normalized) : normalized;
  return colorAtScalePosition(sample, { type, component, min: 0, max: 1 });
}

export function resultScaleCssGradient(scale: ResolvedResultColorScale): string {
  if (scale.bands === "bands8") {
    const stops: string[] = [];
    for (let index = 0; index < BAND_COUNT; index += 1) {
      const start = (index / BAND_COUNT) * 100;
      const end = ((index + 1) / BAND_COUNT) * 100;
      const color = colorAtScalePosition((index + 0.5) / BAND_COUNT, scale);
      stops.push(`${color} ${formatPercent(start)}%`, `${color} ${formatPercent(end)}%`);
    }
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }
  if (scale.type === "stress" && isDivergingStressComponent(scale.component)) {
    if (scale.min < 0 && scale.max > 0) {
      const zero = normalizedResultScaleValue(0, scale) * 100;
      return `linear-gradient(90deg, ${DIVERGING_NEGATIVE} 0%, ${DIVERGING_NEUTRAL} ${formatPercent(zero)}%, ${DIVERGING_POSITIVE} 100%)`;
    }
    return scale.min >= 0
      ? `linear-gradient(90deg, ${DIVERGING_NEUTRAL} 0%, ${DIVERGING_POSITIVE} 100%)`
      : `linear-gradient(90deg, ${DIVERGING_NEGATIVE} 0%, ${DIVERGING_NEUTRAL} 100%)`;
  }
  const ramp = sequentialRamp(scale.type);
  const denominator = Math.max(1, ramp.length - 1);
  return `linear-gradient(90deg, ${ramp.map((color, index) => `${color} ${formatPercent(index / denominator * 100)}%`).join(", ")})`;
}

function colorAtScalePosition(position: number, scale: Pick<ResolvedResultColorScale, "type" | "component" | "min" | "max">): string {
  if (scale.type === "stress" && isDivergingStressComponent(scale.component)) {
    return divergingColor(position, scale.min, scale.max);
  }
  return interpolateRamp(sequentialRamp(scale.type), position);
}

function divergingColor(position: number, min: number, max: number): string {
  if (min < 0 && max > 0) {
    const zero = clamp01((0 - min) / (max - min));
    if (position <= zero) return interpolateHex(DIVERGING_NEGATIVE, DIVERGING_NEUTRAL, zero > 0 ? position / zero : 1);
    return interpolateHex(DIVERGING_NEUTRAL, DIVERGING_POSITIVE, zero < 1 ? (position - zero) / (1 - zero) : 0);
  }
  return min >= 0
    ? interpolateHex(DIVERGING_NEUTRAL, DIVERGING_POSITIVE, position)
    : interpolateHex(DIVERGING_NEGATIVE, DIVERGING_NEUTRAL, position);
}

function sequentialRamp(type: ResultMode): string[] {
  if (type === "displacement" || type === "velocity" || type === "acceleration") return MOTION_RAMP;
  if (type === "safety_factor") return SAFETY_RAMP;
  return STRESS_RAMP;
}

function interpolateRamp(colors: string[], value: number): string {
  const position = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(position));
  return interpolateHex(colors[index]!, colors[index + 1]!, position - index);
}

function interpolateHex(start: string, end: string, value: number): string {
  const a = parseHex(start);
  const b = parseHex(end);
  const t = clamp01(value);
  return `#${[0, 1, 2].map((index) => Math.round(a[index]! + (b[index]! - a[index]!) * t).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(color: string): [number, number, number] {
  const value = color.startsWith("#") ? color.slice(1) : color;
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function quantizedBandSample(value: number): number {
  const band = Math.min(BAND_COUNT - 1, Math.floor(clamp01(value) * BAND_COUNT));
  return (band + 0.5) / BAND_COUNT;
}

function formatPercent(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
