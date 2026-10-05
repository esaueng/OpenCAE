import type { SampleAnalysisType } from "../lib/api";

export interface SampleAnalysisOption {
  id: SampleAnalysisType;
  label: string;
  fullLabel: string;
}

export const SAMPLE_ANALYSIS_OPTIONS: readonly SampleAnalysisOption[] = [
  { id: "static_stress", label: "Static", fullLabel: "Static Stress" },
  { id: "dynamic_structural", label: "Dynamic", fullLabel: "Dynamic Structural" },
  { id: "modal_analysis", label: "Modal", fullLabel: "Modal Analysis" },
  { id: "steady_state_thermal", label: "Thermal", fullLabel: "Steady-State Thermal" }
];

export function sampleAnalysisOptionFor(id: SampleAnalysisType): SampleAnalysisOption {
  return SAMPLE_ANALYSIS_OPTIONS.find((option) => option.id === id) ?? SAMPLE_ANALYSIS_OPTIONS[0]!;
}
