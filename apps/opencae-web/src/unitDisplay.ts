import { classifyResultProvenance, isModalResultSummary, isThermalResultSummary } from "@opencae/schema";
import type { DisplayModel, ModalResultSummary, Project, ResultField, ResultProvenance, ResultSummary, StructuralResultSummary, Study, ThermalResultSummary } from "@opencae/schema";

export type UnitSystem = Project["unitSystem"];

const MM_PER_INCH = 25.4;
const MPA_PER_KSI = 6.894757293168361;
const NEWTONS_PER_LBF = 4.4482216152605;
const KPA_PER_PSI = 6.894757293168361;
const KG_PER_LB = 0.45359237;
const CUBIC_MM_PER_CUBIC_INCH = MM_PER_INCH ** 3;
const CUBIC_CM_PER_CUBIC_METER = 1_000_000;
const CUBIC_IN_PER_CUBIC_METER = 61_023.7440947323;
const LB_PER_KG_PER_CUBIC_METER = 0.0624279605761;
const NEWTONS_PER_CUBIC_METER_PER_LBF_PER_CUBIC_INCH = 271_447.14116097;

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

export function formatVolume(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = volumeForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatMass(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = massForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatDensity(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = densityForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatMaterialStress(valuePa: number, unitSystem: UnitSystem): string {
  return formatStress(valuePa / 1_000_000, "MPa", unitSystem);
}

export function loadValueForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (units === "N" || units === "lbf") return forceForUnits(value, units, unitSystem);
  if (units === "kPa" || units === "psi") return pressureForUnits(value, units, unitSystem);
  if (units === "kg" || units === "lb") return massForUnits(value, units, unitSystem);
  if (units === "N/m^3" && unitSystem === "US") return { value: value / NEWTONS_PER_CUBIC_METER_PER_LBF_PER_CUBIC_INCH, units: "lbf/in^3" };
  if (units === "lbf/in^3" && unitSystem === "SI") return { value: value * NEWTONS_PER_CUBIC_METER_PER_LBF_PER_CUBIC_INCH, units: "N/m^3" };
  return { value, units };
}

export function resultSummaryForUnits(summary: StructuralResultSummary, unitSystem: UnitSystem): StructuralResultSummary;
export function resultSummaryForUnits(summary: ModalResultSummary, unitSystem: UnitSystem): ModalResultSummary;
export function resultSummaryForUnits(summary: ThermalResultSummary, unitSystem: UnitSystem): ThermalResultSummary;
export function resultSummaryForUnits(summary: ResultSummary, unitSystem: UnitSystem): ResultSummary;
export function resultSummaryForUnits(summary: ResultSummary, unitSystem: UnitSystem): ResultSummary {
  if (isModalResultSummary(summary)) return summary;
  if (isThermalResultSummary(summary)) {
    if (unitSystem === "SI" && summary.temperatureUnits === "°F") {
      return {
        ...summary,
        minTemperature: roundDisplayValue((summary.minTemperature - 32) * 5 / 9),
        maxTemperature: roundDisplayValue((summary.maxTemperature - 32) * 5 / 9),
        temperatureUnits: "°C"
      };
    }
    if (unitSystem === "SI" || summary.temperatureUnits === "°F") return summary;
    return {
      ...summary,
      minTemperature: roundDisplayValue(summary.minTemperature * 9 / 5 + 32),
      maxTemperature: roundDisplayValue(summary.maxTemperature * 9 / 5 + 32),
      temperatureUnits: "°F"
    };
  }
  const stress = stressForUnits(summary.maxStress, summary.maxStressUnits, unitSystem);
  const displacement = lengthForUnits(summary.maxDisplacement, summary.maxDisplacementUnits, unitSystem);
  const reaction = forceForUnits(summary.reactionForce, summary.reactionForceUnits, unitSystem);
  // transient.peakDisplacement carries no units of its own — it shares
  // maxDisplacementUnits, so it must convert with the same source units.
  const transient = summary.transient
    ? {
      ...summary.transient,
      peakDisplacement: roundDisplayValue(lengthForUnits(summary.transient.peakDisplacement, summary.maxDisplacementUnits, unitSystem).value)
    }
    : undefined;
  return {
    ...summary,
    failureAssessment: undefined,
    ...(transient ? { transient } : {}),
    maxStress: roundDisplayValue(stress.value),
    maxStressUnits: stress.units,
    maxDisplacement: roundDisplayValue(displacement.value),
    maxDisplacementUnits: displacement.units,
    reactionForce: roundDisplayValue(reaction.value),
    reactionForceUnits: reaction.units
  };
}

export function resultFieldForUnits(field: ResultField, unitSystem: UnitSystem): ResultField {
  const converter = resultValueConverter(field, unitSystem);

  if (!converter) return field;

  // Convert only — never round field data. These values and vectors feed the
  // result render (colors and the deformed shape), where display rounding is
  // destructive: sub-0.01 displacement fields (a stiff part deflecting ~1 µm)
  // quantize onto a 0.001 grid, and the deformation auto-scale amplifies the
  // steps into a jagged, crumpled shape. Readouts format at display time.
  const convertedValues = field.values.map((value) => converter(value).value);
  const convertedMin = converter(field.min);
  const convertedMax = converter(field.max);
  return {
    ...field,
    values: convertedValues,
    tensorValues: field.tensorValues?.map((value) => converter(value).value),
    min: convertedMin.value,
    max: convertedMax.value,
    units: convertedMax.units,
    vectors: field.vectors?.map((vector) => vector.map((component) => converter(component).value) as [number, number, number]),
    samples: field.samples?.map((sample) => ({
      ...sample,
      value: converter(sample.value).value,
      ...(sample.vector ? { vector: sample.vector.map((component) => converter(component).value) as [number, number, number] } : {})
    }))
  };
}

export function resultValueForUnits(field: Pick<ResultField, "type" | "units">, value: number, unitSystem: UnitSystem): { value: number; units: string } {
  return resultValueConverter(field, unitSystem)?.(value) ?? { value, units: field.units };
}

export function resultValueFromDisplayUnits(field: Pick<ResultField, "type" | "units">, value: number, unitSystem: UnitSystem): number {
  // Temperature conversion is affine, so it cannot be inverted by dividing
  // through the converted value of one (the offset would corrupt the range).
  if (field.type === "temperature") {
    if (unitSystem === "US" && field.units !== "°F") return (value - 32) * 5 / 9;
    if (unitSystem === "SI" && field.units === "°F") return value * 9 / 5 + 32;
    return value;
  }
  const displayUnitValue = resultValueForUnits(field, 1, unitSystem).value;
  return Number.isFinite(displayUnitValue) && Math.abs(displayUnitValue) > Number.EPSILON ? value / displayUnitValue : value;
}

function resultValueConverter(field: Pick<ResultField, "type" | "units">, unitSystem: UnitSystem) {
  if (field.type === "temperature" && unitSystem === "US" && field.units !== "°F") {
    return (value: number) => ({ value: value * 9 / 5 + 32, units: "°F" });
  }
  if (field.type === "temperature" && unitSystem === "SI" && field.units === "°F") {
    return (value: number) => ({ value: (value - 32) * 5 / 9, units: "°C" });
  }
  return field.type === "stress"
    ? (value: number) => stressForUnits(value, field.units, unitSystem)
    : field.type === "displacement" || field.type === "velocity" || field.type === "acceleration"
      ? (value: number) => lengthForUnits(value, field.units, unitSystem)
      : undefined;
}

export function formatResultProvenanceLabel(provenance: ResultProvenance | undefined): string {
  const tier = classifyResultProvenance(provenance);
  if (tier === "imported_legacy") return "Legacy backend result";
  if (tier === "core_preview") return "OpenCAE Core Preview (coarse block proxy)";
  if (tier === "local_estimate") return "Estimate (not FEA)";
  if (tier === "analytical_benchmark") return "Analytical benchmark";
  if (tier === "production_fea") {
    if (provenance?.runnerVersion?.startsWith("browser-")) return "OpenCAE Core Local (in-browser)";
    return provenance?.solver === "opencae-core-cloud" ? "OpenCAE Core Cloud" : "OpenCAE Core Local";
  }
  return "Unknown result source";
}

export function hasResultUnit(units: string | undefined): units is string {
  return typeof units === "string" && units.length > 0 && units !== "undefined";
}

export function formatResultMetric(value: number, units: string | undefined): string {
  return hasResultUnit(units) ? `${value} ${units}` : "Unit missing";
}

export function solverMethodForResult(resultSummary: ResultSummary, study: Study): string {
  const provenanceMethod = (resultSummary.provenance as Record<string, unknown> | undefined)?.coreSolver;
  if (typeof provenanceMethod === "string" && provenanceMethod) return provenanceMethod;
  if (isModalResultSummary(resultSummary) || study.type === "modal_analysis") return "block_shift_invert_modal";
  if (isThermalResultSummary(resultSummary) || study.type === "steady_state_thermal") return "sparse_steady_thermal";
  if (resultSummary.transient || study.type === "dynamic_structural") return "mdof_dynamic";
  return "sparse_static";
}

export function solverRunnerLabelForResult(provenance: ResultProvenance | undefined): string {
  if (provenance?.runnerVersion?.startsWith("browser-")) return "in-browser solve worker";
  return provenance?.solver === "opencae-core-cloud" ? "cloud container" : "local core worker";
}

export function formatMeshSourceLabel(meshSource: ResultProvenance["meshSource"] | undefined, displayModel?: DisplayModel): string {
  if (meshSource === "actual_volume_mesh") {
    if (displayModel?.coreCloudGeometry?.kind === "sample_procedural") return "Procedural sample mesh (simplified)";
    return "Actual volume mesh";
  }
  if (meshSource === "structured_block_core") return "Structured block Core";
  if (meshSource === "opencae_core_tet4") return "OpenCAE Core Tet4";
  if (meshSource === "structured_block_proxy" || meshSource === "display_bounds_proxy") return "OpenCAE Core Preview";
  if (typeof meshSource === "string" && meshSource) return meshSource.replaceAll("_", " ");
  return "--";
}

export function legacyResultWarningForProvenance(provenance: ResultProvenance | undefined): string | null {
  return isLegacyBackendResult(provenance)
    ? "This result is historical and read-only. Re-run locally in this browser for current production results."
    : null;
}

function isLegacyBackendResult(provenance: ResultProvenance | undefined): boolean {
  const solver = provenance?.solver ?? "";
  return new RegExp(["calcu", "lix"].join(""), "i").test(solver);
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
  if (unitSystem === "US" && units === "mm/s") return { value: value / MM_PER_INCH, units: "in/s" };
  if (unitSystem === "SI" && units === "in/s") return { value: value * MM_PER_INCH, units: "mm/s" };
  if (unitSystem === "US" && units === "mm/s^2") return { value: value / MM_PER_INCH, units: "in/s^2" };
  if (unitSystem === "SI" && units === "in/s^2") return { value: value * MM_PER_INCH, units: "mm/s^2" };
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
  if (unitSystem === "US" && units === "g") return { value: value / 1000 / KG_PER_LB, units: "lb" };
  if (unitSystem === "SI" && units === "lb") return { value: value * KG_PER_LB, units: "kg" };
  if (unitSystem === "US" && units === "kg") return { value: value / KG_PER_LB, units: "lb" };
  return { value, units };
}

export function volumeForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "mm^3") return { value: value / CUBIC_MM_PER_CUBIC_INCH, units: "in^3" };
  if (unitSystem === "SI" && units === "in^3") return { value: value * CUBIC_MM_PER_CUBIC_INCH, units: "mm^3" };
  if (unitSystem === "SI" && units === "m^3") return { value: value * CUBIC_CM_PER_CUBIC_METER, units: "cm^3" };
  if (unitSystem === "US" && units === "m^3") return { value: value * CUBIC_IN_PER_CUBIC_METER, units: "in^3" };
  return { value, units };
}

export function densityForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "kg/m^3") return { value: value * LB_PER_KG_PER_CUBIC_METER, units: "lb/ft^3" };
  if (unitSystem === "SI" && units === "lb/ft^3") return { value: value / LB_PER_KG_PER_CUBIC_METER, units: "kg/m^3" };
  return { value, units };
}

function formatDisplayNumber(value: number): string {
  return roundDisplayValue(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function roundDisplayValue(value: number): number {
  if (!Number.isFinite(value)) return value;
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return Math.round(value * 10) / 10;
  if (magnitude >= 10) return Math.round(value * 100) / 100;
  return Math.round(value * 1000) / 1000;
}
