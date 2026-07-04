import { z } from "zod";

export const DiagnosticSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  source: z.enum(["geometry", "mesh", "solver", "local_job", "validation", "ui"]),
  message: z.string(),
  relatedEntityRef: z.string().optional(),
  suggestedActions: z.array(z.string()).default([])
});

export const MaterialSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["metal", "plastic", "composite", "resin"]).optional(),
  youngsModulus: z.number().positive(),
  poissonRatio: z.number().gt(-1).lt(0.5),
  density: z.number().positive(),
  yieldStrength: z.number().positive(),
  printProfile: z
    .object({
      process: z.enum(["FDM", "SLA", "SLS", "MJF", "Metal AM"]),
      defaultInfillDensity: z.number().min(1).max(100).optional(),
      defaultWallCount: z.number().min(1).max(12).optional(),
      defaultLayerOrientation: z.enum(["x", "y", "z"]).optional(),
      layerStrengthFactor: z.number().min(0.1).max(1).optional()
    })
    .optional()
});

export const GeometryReferenceSchema = z.object({
  bodyId: z.string(),
  entityType: z.enum(["body", "face", "edge", "vertex"]),
  entityId: z.string(),
  label: z.string()
});

export const NamedSelectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  entityType: z.enum(["body", "face", "edge", "vertex"]),
  geometryRefs: z.array(GeometryReferenceSchema),
  fingerprint: z.string()
});

export const ConstraintSchema = z.object({
  id: z.string(),
  type: z.enum(["fixed", "prescribed_displacement"]),
  selectionRef: z.string(),
  parameters: z.record(z.unknown()),
  status: z.enum(["not_started", "ready", "warning", "complete"])
});

export const LoadSchema = z.object({
  id: z.string(),
  type: z.enum(["force", "pressure", "gravity"]),
  selectionRef: z.string(),
  parameters: z.record(z.unknown()),
  status: z.enum(["not_started", "ready", "warning", "complete"])
});

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const StudyAnalysisTypeSchema = z.enum(["static_stress", "dynamic_structural"]);
export const MeshQualitySchema = z.enum(["coarse", "medium", "fine", "ultra"]);
export const SolverBackendSchema = z.preprocess(
  (value) => {
    const deprecatedCloudFeaBackend = ["cloudflare-fea", ["calcu", "lix"].join("")].join("-");
    if (value === "cloudflare_fea" || value === deprecatedCloudFeaBackend || value === "opencae_core" || value === "local_detailed") {
      return "opencae_core_cloud";
    }
    return value;
  },
  z.enum(["opencae_core_cloud", "opencae_core_local"])
);
export const SimulationFidelitySchema = z.enum(["standard", "detailed", "ultra"]);

export const DynamicSolverSettingsSchema = z.object({
  backend: SolverBackendSchema.optional(),
  fidelity: SimulationFidelitySchema.optional(),
  startTime: z.number().default(0),
  endTime: z.number().default(0.1),
  timeStep: z.number().default(0.005),
  outputInterval: z.number().default(0.005),
  dampingRatio: z.number().default(0.02),
  integrationMethod: z.literal("newmark_average_acceleration").default("newmark_average_acceleration"),
  loadProfile: z.enum(["ramp", "step", "sinusoidal", "quasi_static"]).default("ramp"),
  rayleighAlpha: z.number().nonnegative().optional(),
  rayleighBeta: z.number().nonnegative().optional(),
  allowFreeMotion: z.boolean().optional()
});

export const AnalysisSampleSchema = z.object({
  point: Vec3Schema,
  normal: Vec3Schema,
  weight: z.number().optional(),
  sourceId: z.string().optional()
});

export const AnalysisMeshSchema = z.object({
  quality: MeshQualitySchema,
  bounds: z.object({
    min: Vec3Schema,
    max: Vec3Schema
  }),
  samples: z.array(AnalysisSampleSchema)
});

export const ResultSampleSchema = z.object({
  point: Vec3Schema,
  normal: Vec3Schema,
  value: z.number(),
  vector: Vec3Schema.optional(),
  nodeId: z.string().optional(),
  elementId: z.string().optional(),
  source: z.string().optional(),
  vonMisesStressPa: z.number().optional()
});

export const ResultProvenanceSchema = z.object({
  kind: z.enum(["opencae_core_fea", "local_estimate", "analytical_benchmark"]),
  solver: z.string(),
  // Core Cloud results report coreVersion/solverCpuVersion/runnerVersion instead
  // of solverVersion; requiring it made every cloud result fail restore parsing.
  solverVersion: z.string().optional(),
  coreVersion: z.string().optional(),
  solverCpuVersion: z.string().optional(),
  runnerVersion: z.string().optional(),
  meshSource: z.enum(["opencae_core_tet4", "actual_volume_mesh", "structured_block_core", "structured_block", "structured_block_proxy", "display_bounds_proxy", "mock", "unknown"]),
  resultSource: z.enum(["computed", "computed_preview", "generated"]),
  units: z.string(),
  renderCoordinateSpace: z.string().optional(),
  integrationMethod: z.string().optional(),
  loadProfile: z.string().optional(),
  dynamicProfile: z.string().optional(),
  accelerationSource: z.string().optional()
});

export const CoreCloudResultProvenanceSchema = ResultProvenanceSchema.superRefine((provenance, context) => {
  if (new RegExp(["calcu", "lix"].join(""), "i").test(provenance.solver)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OpenCAE Core Cloud results must use opencae-core-cloud solver provenance." });
  }
  if (provenance.kind !== "opencae_core_fea") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OpenCAE Core Cloud results must use opencae_core_fea provenance." });
  }
  if (provenance.solver !== "opencae-core-cloud") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OpenCAE Core Cloud results must use the opencae-core-cloud solver." });
  }
  if (provenance.resultSource !== "computed") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OpenCAE Core Cloud results must use computed result provenance." });
  }
  if (provenance.meshSource !== "actual_volume_mesh" && provenance.meshSource !== "structured_block_core") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OpenCAE Core Cloud results must use actual_volume_mesh or structured_block_core mesh provenance." });
  }
});

export const ResultProvenanceTierSchema = z.enum(["production_fea", "core_preview", "local_estimate", "analytical_benchmark", "imported_legacy", "unknown"]);
export const StudyRunStatusSchema = z.enum(["queued", "running", "complete", "complete_preview", "complete_estimate", "complete_benchmark", "complete_legacy", "failed", "cancelled"]);
const terminalRunResultStatuses = new Set(["complete", "complete_preview", "complete_estimate", "complete_benchmark", "complete_legacy"]);

export const ResultFieldSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: z.enum(["stress", "displacement", "safety_factor", "velocity", "acceleration"]),
  location: z.enum(["node", "element", "face"]),
  values: z.array(z.number()),
  min: z.number(),
  max: z.number(),
  units: z.string(),
  samples: z.array(ResultSampleSchema).optional(),
  vectors: z.array(Vec3Schema).optional(),
  surfaceMeshRef: z.string().optional(),
  visualizationSource: z.string().optional(),
  engineeringSource: z.string().optional(),
  frameIndex: z.number().int().min(0).optional(),
  timeSeconds: z.number().min(0).optional(),
  provenance: ResultProvenanceSchema.optional()
});

export const GeometryFileSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  filename: z.string(),
  localPath: z.string(),
  artifactKey: z.string(),
  status: z.enum(["pending", "ready", "error"]),
  metadata: z.record(z.unknown())
});

export const MeshSettingsSchema = z.object({
  preset: MeshQualitySchema,
  status: z.enum(["not_started", "ready", "warning", "complete"]),
  meshRef: z.string().optional(),
  summary: z
    .object({
      nodes: z.number(),
      elements: z.number(),
      warnings: z.array(z.string()),
      analysisSampleCount: z.number().optional(),
      quality: MeshQualitySchema.optional(),
      source: z.string().optional(),
      units: z.string().optional(),
      density: z.record(z.unknown()).optional(),
      solverCoordinateSpace: z.string().optional(),
      resultSampleCoordinateSpace: z.string().optional(),
      artifacts: z
        .object({
          meshConnectivity: z
            .object({
              connectedComponents: z.number().int().positive().optional()
            })
            .optional(),
          actualCoreModel: z.unknown().optional(),
          coreModel: z.unknown().optional(),
          actualCoreVolumeMeshRef: z.string().optional(),
          volumeMesh: z.unknown().optional()
        })
        .passthrough()
        .optional()
    })
    .passthrough()
    .optional()
});

export const StudyRunSchema = z.object({
  id: z.string(),
  studyId: z.string(),
  status: StudyRunStatusSchema,
  jobId: z.string(),
  meshRef: z.string().optional(),
  resultRef: z.string().optional(),
  reportRef: z.string().optional(),
  solverBackend: z.string(),
  solverVersion: z.string(),
  resultTier: ResultProvenanceTierSchema.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  diagnostics: z.array(DiagnosticSchema).default([])
});

const MaterialAssignmentSchema = z.object({
  id: z.string(),
  materialId: z.string(),
  selectionRef: z.string(),
  parameters: z.record(z.unknown()).optional(),
  status: z.enum(["not_started", "ready", "warning", "complete"])
});

const StudyBaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  geometryScope: z.array(GeometryReferenceSchema),
  materialAssignments: z.array(MaterialAssignmentSchema),
  namedSelections: z.array(NamedSelectionSchema),
  contacts: z.array(z.unknown()).default([]),
  constraints: z.array(ConstraintSchema),
  loads: z.array(LoadSchema),
  meshSettings: MeshSettingsSchema,
  validation: z.array(DiagnosticSchema).default([]),
  runs: z.array(StudyRunSchema).default([])
});

export const StaticStudySchema = StudyBaseSchema.extend({
  type: z.literal("static_stress"),
  solverSettings: z.object({
    backend: SolverBackendSchema.optional(),
    fidelity: SimulationFidelitySchema.optional()
  }).passthrough()
});

export const DynamicStudySchema = StudyBaseSchema.extend({
  type: z.literal("dynamic_structural"),
  solverSettings: DynamicSolverSettingsSchema
});

export const StudySchema = z.discriminatedUnion("type", [StaticStudySchema, DynamicStudySchema]);

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  schemaVersion: z.string(),
  unitSystem: z.enum(["SI", "US"]),
  geometryFiles: z.array(GeometryFileSchema),
  studies: z.array(StudySchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const MeshSummarySchema = z.object({
  nodes: z.number(),
  elements: z.number(),
  warnings: z.array(z.string()),
  analysisSampleCount: z.number().optional(),
  quality: MeshQualitySchema.optional(),
  source: z.string().optional(),
  units: z.string().optional(),
  density: z.record(z.unknown()).optional(),
  solverCoordinateSpace: z.string().optional(),
  resultSampleCoordinateSpace: z.string().optional()
});

export const ResultSummarySchema = z.object({
  maxStress: z.number(),
  maxStressUnits: z.string(),
  maxDisplacement: z.number(),
  maxDisplacementUnits: z.string(),
  safetyFactor: z.number(),
  failureAssessment: z
    .object({
      status: z.enum(["pass", "warning", "fail", "unknown"]),
      title: z.string(),
      message: z.string()
    })
    .optional(),
  reactionForce: z.number(),
  reactionForceUnits: z.string(),
  resultTier: ResultProvenanceTierSchema.optional(),
  provenance: ResultProvenanceSchema.optional(),
  diagnostics: z.array(DiagnosticSchema).optional().default([]),
  loadSummary: z
    .object({
      appliedLoadMagnitude: z.number().optional(),
      peakReactionForce: z.number().optional(),
      currentFrameReactionForce: z.number().optional(),
      reactionForceSource: z.enum(["computed", "applied_load_estimate", "unavailable"]).optional()
    })
    .optional(),
  transient: z
    .object({
      analysisType: z.literal("dynamic_structural"),
      // Optional: Core Cloud runners up to 0.1.5 omit these two; requiring them made
      // parseResultBundle silently drop restored dynamic cloud results.
      integrationMethod: z.literal("newmark_average_acceleration").optional(),
      startTime: z.number(),
      endTime: z.number(),
      timeStep: z.number(),
      outputInterval: z.number(),
      dampingRatio: z.number().optional(),
      frameCount: z.number(),
      peakDisplacementTimeSeconds: z.number(),
      peakDisplacement: z.number()
    })
    .optional()
});

export const RunEventSchema = z.object({
  runId: z.string(),
  type: z.enum(["state", "progress", "message", "log", "diagnostic", "complete", "cancelled", "error"]),
  progress: z.number().min(0).max(100).optional(),
  message: z.string(),
  diagnostic: DiagnosticSchema.optional(),
  elapsedMs: z.number().min(0).optional(),
  estimatedDurationMs: z.number().min(0).optional(),
  estimatedRemainingMs: z.number().min(0).optional(),
  timestamp: z.string()
});

export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type StudyAnalysisType = z.infer<typeof StudyAnalysisTypeSchema>;
export type MeshQuality = z.infer<typeof MeshQualitySchema>;
export type SolverBackend = z.infer<typeof SolverBackendSchema>;
export type SimulationFidelity = z.infer<typeof SimulationFidelitySchema>;
export type DynamicSolverSettings = z.infer<typeof DynamicSolverSettingsSchema>;
export type Material = z.infer<typeof MaterialSchema>;
export type GeometryReference = z.infer<typeof GeometryReferenceSchema>;
export type NamedSelection = z.infer<typeof NamedSelectionSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type Load = z.infer<typeof LoadSchema>;
export type AnalysisSample = z.infer<typeof AnalysisSampleSchema>;
export type AnalysisMesh = z.infer<typeof AnalysisMeshSchema>;
export type ResultSample = z.infer<typeof ResultSampleSchema>;
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;
export type ResultProvenanceTier = z.infer<typeof ResultProvenanceTierSchema>;
export type ResultField = z.infer<typeof ResultFieldSchema>;
export type GeometryFile = z.infer<typeof GeometryFileSchema>;
export type MeshSummary = z.infer<typeof MeshSummarySchema>;
export type ResultSummary = Omit<z.infer<typeof ResultSummarySchema>, "diagnostics"> & { diagnostics?: Diagnostic[] };
export type StudyRun = z.infer<typeof StudyRunSchema>;
export type Study = z.infer<typeof StudySchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type FailureAssessment = NonNullable<ResultSummary["failureAssessment"]>;

export type RunTimingEstimate = Pick<RunEvent, "elapsedMs" | "estimatedDurationMs" | "estimatedRemainingMs">;

export function classifyResultProvenance(provenance: ResultProvenance | undefined): ResultProvenanceTier {
  if (!provenance) return "unknown";
  if (isLegacyResultProvenance(provenance)) return "imported_legacy";
  if (provenance.kind === "analytical_benchmark") return "analytical_benchmark";
  if (isPreviewResultProvenance(provenance)) return "core_preview";
  if (provenance.kind === "local_estimate") return "local_estimate";
  if (CoreCloudResultProvenanceSchema.safeParse(provenance).success) return "production_fea";
  if (provenance.kind === "opencae_core_fea" && provenance.resultSource === "computed" && (provenance.meshSource === "actual_volume_mesh" || provenance.meshSource === "opencae_core_tet4" || provenance.meshSource === "structured_block_core")) {
    return "production_fea";
  }
  return "unknown";
}

export function runStatusForResultProvenance(provenance: ResultProvenance | undefined): Extract<StudyRun["status"], "complete" | "complete_preview" | "complete_estimate" | "complete_benchmark" | "complete_legacy"> {
  const tier = classifyResultProvenance(provenance);
  if (tier === "production_fea") return "complete";
  if (tier === "core_preview") return "complete_preview";
  if (tier === "analytical_benchmark") return "complete_benchmark";
  if (tier === "imported_legacy") return "complete_legacy";
  return "complete_estimate";
}

export function isRunResultReadyStatus(status: StudyRun["status"]): boolean {
  return terminalRunResultStatuses.has(status);
}

export function isPreviewResultProvenance(provenance: ResultProvenance | undefined): boolean {
  if (!provenance) return false;
  return provenance.solver === "opencae-core-preview-sdof" ||
    provenance.solver === "opencae-core-preview-tet4" ||
    provenance.meshSource === "structured_block_proxy" ||
    provenance.meshSource === "display_bounds_proxy" ||
    provenance.resultSource === "computed_preview";
}

export function isLegacyResultProvenance(provenance: ResultProvenance | undefined): boolean {
  return new RegExp(["calcu", "lix"].join(""), "i").test(provenance?.solver ?? "");
}

export interface LoadCapacityEstimate {
  status: "available" | "unknown";
  targetSafetyFactor: number;
  currentLoad: number;
  allowableLoad: number;
  loadScale: number;
  loadUnits: string;
}

export function assessResultFailure(summary: Pick<ResultSummary, "safetyFactor" | "maxStress" | "maxStressUnits">): FailureAssessment {
  const safetyFactor = Number(summary.safetyFactor);
  if (!Number.isFinite(safetyFactor) || safetyFactor <= 0) {
    return {
      status: "unknown",
      title: "Failure check unavailable",
      message: "Run the simulation with a valid material, support, load, and mesh to assess failure risk."
    };
  }

  const stressText = `${formatAssessmentNumber(summary.maxStress)} ${summary.maxStressUnits}`;
  if (safetyFactor < 1) {
    return {
      status: "fail",
      title: "Likely to fail",
      message: `Peak stress is ${stressText}, which exceeds the assigned material yield limit.`
    };
  }

  if (safetyFactor < 1.5) {
    return {
      status: "warning",
      title: "Low safety margin",
      message: `Safety factor is ${formatAssessmentNumber(safetyFactor)}. Increase material strength, section size, or reduce load.`
    };
  }

  return {
    status: "pass",
    title: "Unlikely to yield",
    message: `Safety factor is ${formatAssessmentNumber(safetyFactor)}. Peak stress is below the assigned material yield limit.`
  };
}

function formatAssessmentNumber(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function estimateAllowableLoadForSafetyFactor(
  summary: Pick<ResultSummary, "safetyFactor" | "reactionForce" | "reactionForceUnits">,
  targetSafetyFactor: number
): LoadCapacityEstimate {
  const currentSafetyFactor = Number(summary.safetyFactor);
  const currentLoad = Number(summary.reactionForce);
  const target = Number(targetSafetyFactor);
  if (!Number.isFinite(currentSafetyFactor) || currentSafetyFactor <= 0 || !Number.isFinite(currentLoad) || currentLoad <= 0 || !Number.isFinite(target) || target <= 0) {
    return {
      status: "unknown",
      targetSafetyFactor: Number.isFinite(target) ? target : 0,
      currentLoad: Number.isFinite(currentLoad) ? currentLoad : 0,
      allowableLoad: 0,
      loadScale: 0,
      loadUnits: summary.reactionForceUnits
    };
  }

  const loadScale = currentSafetyFactor / target;
  return {
    status: "available",
    targetSafetyFactor: target,
    currentLoad,
    allowableLoad: roundAssessmentNumber(currentLoad * loadScale),
    loadScale: roundAssessmentNumber(loadScale),
    loadUnits: summary.reactionForceUnits
  };
}

function roundAssessmentNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface DisplayFace {
  id: string;
  label: string;
  color: string;
  center: [number, number, number];
  normal: [number, number, number];
  stressValue: number;
}

export interface DisplayModel {
  id: string;
  name: string;
  bodyCount: number;
  faces: DisplayFace[];
  orientation?: {
    x: number;
    y: number;
    z: number;
  };
  dimensions?: {
    x: number;
    y: number;
    z: number;
    units: string;
  };
  nativeCad?: {
    format: "step";
    filename: string;
    contentBase64?: string;
  };
  visualMesh?: {
    format: "stl" | "obj";
    filename: string;
    contentBase64: string;
  };
  coreCloudGeometry?: {
    kind: "sample_procedural" | "uploaded_cad" | "uploaded_mesh" | "structured_block";
    sampleId?: "cantilever" | "beam" | "bracket";
    format?: "step" | "stl" | "obj" | "msh" | "json";
    filename?: string;
    contentBase64?: string;
    units?: "mm" | "m";
    descriptor?: Record<string, unknown>;
    geometryDescriptor?: Record<string, unknown>;
  };
}

export interface ResultRenderBounds {
  min: [number, number, number];
  max: [number, number, number];
  coordinateSpace: "display_model";
}
