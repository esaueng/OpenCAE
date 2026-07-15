export type ValidationMetric = {
  id: string;
  label: string;
  value: number;
  units: string;
  reference?: number;
  tolerancePercent?: number;
};

export type ValidationBenchmarkResult = {
  benchmarkId: ValidationBenchmarkId;
  passed: boolean;
  measuredAt: string;
  durationMs: number;
  metrics: ValidationMetric[];
  details: string[];
};

export type ValidationBenchmarkDefinition = {
  id: ValidationBenchmarkId;
  title: string;
  category: "accuracy" | "performance";
  summary: string;
  oracle: string;
  releaseBaseline: ValidationBenchmarkResult;
};

export type ValidationBenchmarkId = "cantilever-static" | "plate-with-hole" | "scale-100k";

const RELEASE_MEASURED_AT = "2026-07-14T00:00:00.000Z";

export const VALIDATION_BENCHMARKS: readonly ValidationBenchmarkDefinition[] = [
  {
    id: "cantilever-static",
    title: "Cantilever beam",
    category: "accuracy",
    summary: "Structured Tet model compared with Timoshenko beam deflection and elementary bending stress.",
    oracle: "Tip deflection FL³/(3EI) with shear correction; root stress FLc/I.",
    releaseBaseline: {
      benchmarkId: "cantilever-static",
      passed: true,
      measuredAt: RELEASE_MEASURED_AT,
      durationMs: 595,
      metrics: [
        { id: "tip-displacement", label: "Tip displacement", value: 0.1771, units: "mm", reference: 0.1782, tolerancePercent: 3 },
        { id: "root-stress", label: "Peak von Mises", value: 45.2, units: "MPa", reference: 39.06, tolerancePercent: 35 },
        { id: "reaction", label: "Reaction", value: 500, units: "N", reference: 500, tolerancePercent: 0.2 }
      ],
      details: ["OpenCAE sparse Tet solver", "Steel · 180 × 24 × 24 mm", "500 N transverse tip load"]
    }
  },
  {
    id: "plate-with-hole",
    title: "Plate with a central hole",
    category: "accuracy",
    summary: "WASM Gmsh, mesh intake, Tet10 solve, and stress recovery against the finite-width Kt oracle.",
    oracle: "Kt,net = 2 + (1 − d/W)³ = 2.422 for d/W = 0.25.",
    releaseBaseline: {
      benchmarkId: "plate-with-hole",
      passed: true,
      measuredAt: RELEASE_MEASURED_AT,
      durationMs: 3074,
      metrics: [
        { id: "kt", label: "Net-section Kt", value: 2.51, units: "", reference: 2.422, tolerancePercent: 15 },
        { id: "reaction", label: "Reaction", value: 1000, units: "N", reference: 1000, tolerancePercent: 1 },
        { id: "quality", label: "Minimum SICN", value: 0.309, units: "" }
      ],
      details: ["2,909 Tet10 elements", "Hole-edge mesh refinement", "Production WASM meshing path"]
    }
  },
  {
    id: "scale-100k",
    title: "100k-DOF browser solve",
    category: "performance",
    summary: "A drilled STEP part meshed and solved as a 100k-class CPU scale checkpoint.",
    oracle: "Finite positive fields and reaction balance within 1% at 90k–100k DOF.",
    releaseBaseline: {
      benchmarkId: "scale-100k",
      passed: true,
      measuredAt: RELEASE_MEASURED_AT,
      durationMs: 12545,
      metrics: [
        { id: "dofs", label: "Degrees of freedom", value: 99345, units: "DOF" },
        { id: "reaction", label: "Reaction", value: 500, units: "N", reference: 500, tolerancePercent: 1 },
        { id: "solve-time", label: "Solve time", value: 12.545, units: "s" }
      ],
      details: ["33,115 Tet10 nodes", "21,273 elements", "Below the 150k CPU guard"]
    }
  }
] as const;

export function validationBenchmark(id: ValidationBenchmarkId): ValidationBenchmarkDefinition {
  const benchmark = VALIDATION_BENCHMARKS.find((candidate) => candidate.id === id);
  if (!benchmark) throw new Error(`Unknown validation benchmark ${id}.`);
  return benchmark;
}

export function metricPercentError(metric: ValidationMetric): number | null {
  if (metric.reference === undefined || Math.abs(metric.reference) <= Number.EPSILON) return null;
  return (Math.abs(metric.value - metric.reference) / Math.abs(metric.reference)) * 100;
}
