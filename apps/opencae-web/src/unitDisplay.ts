import type { DisplayModel, Project, ResultField, ResultSummary } from "@opencae/schema";

export type UnitSystem = Project["unitSystem"];

const MM_PER_INCH = 25.4;
const MPA_PER_KSI = 6.894757293168361;
const NEWTONS_PER_LBF = 4.4482216152605;
const KPA_PER_PSI = 6.894757293168361;
const KG_PER_LB = 0.45359237;

export function formatUnitSystemLabel(unitSystem: UnitSystem): string {
  return unitSystem === "US" ? "Imperial · in" : "Metric · mm";
}

export function formatLength(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = lengthForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatStress(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = stressForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatForce(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = forceForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function loadValueForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (units === "N" || units === "lbf") return forceForUnits(value, units, unitSystem);
  if (units === "kPa" || units === "psi") return pressureForUnits(value, units, unitSystem);
  if (units === "kg" || units === "lb") return massForUnits(value, units, unitSystem);
  return { value, units };
}

export function resultSummaryForUnits(summary: ResultSummary, unitSystem: UnitSystem): ResultSummary {
  const stress = stressForUnits(summary.maxStress, summary.maxStressUnits, unitSystem);
  const displacement = lengthForUnits(summary.maxDisplacement, summary.maxDisplacementUnits, unitSystem);
  const reaction = forceForUnits(summary.reactionForce, summary.reactionForceUnits, unitSystem);
  return {
    ...summary,
    failureAssessment: undefined,
    maxStress: roundDisplayValue(stress.value),
    maxStressUnits: stress.units,
    maxDisplacement: roundDisplayValue(displacement.value),
    maxDisplacementUnits: displacement.units,
    reactionForce: roundDisplayValue(reaction.value),
    reactionForceUnits: reaction.units
  };
}

export function resultFieldForUnits(field: ResultField, unitSystem: UnitSystem): ResultField {
  const converter = field.type === "stress"
    ? (value: number) => stressForUnits(value, field.units, unitSystem)
    : field.type === "displacement"
      ? (value: number) => lengthForUnits(value, field.units, unitSystem)
      : undefined;

  if (!converter) return field;

  const convertedValues = field.values.map((value) => roundDisplayValue(converter(value).value));
  const convertedMin = converter(field.min);
  const convertedMax = converter(field.max);
  return {
    ...field,
    values: convertedValues,
    min: roundDisplayValue(convertedMin.value),
    max: roundDisplayValue(convertedMax.value),
    units: convertedMax.units
  };
}

export function displayModelForUnits(displayModel: DisplayModel, unitSystem: UnitSystem): DisplayModel {
  const dimensions = displayModel.dimensions;
  if (!dimensions) return displayModel;
  const x = lengthForUnits(dimensions.x, dimensions.units, unitSystem);
  const y = lengthForUnits(dimensions.y, dimensions.units, unitSystem);
  const z = lengthForUnits(dimensions.z, dimensions.units, unitSystem);
  return {
    ...displayModel,
    dimensions: {
      x: roundDisplayValue(x.value),
      y: roundDisplayValue(y.value),
      z: roundDisplayValue(z.value),
      units: x.units
    }
  };
}

export function lengthForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "mm") return { value: value / MM_PER_INCH, units: "in" };
  if (unitSystem === "SI" && units === "in") return { value: value * MM_PER_INCH, units: "mm" };
  return { value, units };
}

export function stressForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "MPa") return { value: value / MPA_PER_KSI, units: "ksi" };
  if (unitSystem === "SI" && units === "ksi") return { value: value * MPA_PER_KSI, units: "MPa" };
  return { value, units };
}

export function forceForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "N") return { value: value / NEWTONS_PER_LBF, units: "lbf" };
  if (unitSystem === "SI" && units === "lbf") return { value: value * NEWTONS_PER_LBF, units: "N" };
  return { value, units };
}

export function pressureForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "kPa") return { value: value / KPA_PER_PSI, units: "psi" };
  if (unitSystem === "SI" && units === "psi") return { value: value * KPA_PER_PSI, units: "kPa" };
  return { value, units };
}

export function massForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "kg") return { value: value / KG_PER_LB, units: "lb" };
  if (unitSystem === "SI" && units === "lb") return { value: value * KG_PER_LB, units: "kg" };
  return { value, units };
}

function formatDisplayNumber(value: number): string {
  return roundDisplayValue(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function roundDisplayValue(value: number): number {
  if (!Number.isFinite(value)) return value;
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return Math.round(value * 10) / 10;
  if (magnitude >= 10) return Math.round(value * 100) / 100;
  return Math.round(value * 1000) / 1000;
}
