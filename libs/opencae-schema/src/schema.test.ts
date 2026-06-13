import { describe, expect, it } from "vitest";
import { CoreCloudResultProvenanceSchema, DynamicSolverSettingsSchema, MaterialSchema, ProjectSchema, ResultFieldSchema, ResultSummarySchema, RunEventSchema, SolverBackendSchema, StudyRunSchema, classifyResultProvenance, isRunResultReadyStatus, runStatusForResultProvenance } from "./index";

describe("ProjectSchema", () => {
  it("accepts the minimum local project shape", () => {
    const parsed = ProjectSchema.parse({
      id: "project-test",
      name: "Test Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.name).toBe("Test Project");
  });

  it("preserves 3D print parameters on material assignments", () => {
    const parsed = ProjectSchema.parse({
      id: "project-test",
      name: "Test Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [
        {
          id: "study-test",
          projectId: "project-test",
          name: "Static Stress",
          type: "static_stress",
          geometryScope: [],
          materialAssignments: [
            {
              id: "assign-material",
              materialId: "mat-petg",
              selectionRef: "selection-body",
              parameters: {
                printed: true,
                infillDensity: 35,
                wallCount: 3,
                layerOrientation: "z"
              },
              status: "complete"
            }
          ],
          namedSelections: [],
          contacts: [],
          constraints: [],
          loads: [],
          meshSettings: { preset: "medium", status: "not_started" },
          solverSettings: {},
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.materialAssignments[0]?.parameters).toMatchObject({
      printed: true,
      infillDensity: 35
    });
  });

  it("accepts dynamic structural studies and applies default solver settings", () => {
    const parsed = ProjectSchema.parse({
      id: "project-test",
      name: "Dynamic Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [
        {
          id: "study-dynamic",
          projectId: "project-test",
          name: "Dynamic",
          type: "dynamic_structural",
          geometryScope: [],
          materialAssignments: [],
          namedSelections: [],
          contacts: [],
          constraints: [],
          loads: [],
          meshSettings: { preset: "medium", status: "not_started" },
          solverSettings: {},
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.type).toBe("dynamic_structural");
    expect(parsed.studies[0]?.solverSettings).toMatchObject({
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0.02,
      integrationMethod: "newmark_average_acceleration",
      loadProfile: "ramp"
    });
  });

  it("accepts framed velocity and acceleration result fields while keeping unframed static fields valid", () => {
    expect(ResultFieldSchema.parse({
      id: "field-velocity-frame-1",
      runId: "run-dynamic",
      type: "velocity",
      location: "face",
      values: [0, 1.25],
      min: 0,
      max: 1.25,
      units: "mm/s",
      frameIndex: 1,
      timeSeconds: 0.005,
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-dynamic-tet4",
        solverVersion: "0.1.0",
        meshSource: "opencae_core_tet4",
        resultSource: "computed",
        units: "mm-N-s-MPa",
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp",
        accelerationSource: "derived_from_velocity"
      }
    })).toMatchObject({ frameIndex: 1, timeSeconds: 0.005 });

    expect(ResultFieldSchema.parse({
      id: "field-stress-static",
      runId: "run-static",
      type: "stress",
      location: "face",
      values: [42],
      min: 42,
      max: 42,
      units: "MPa"
    }).frameIndex).toBeUndefined();
  });

  it("accepts OpenCAE Core dynamic settings and transient metadata", () => {
    expect(DynamicSolverSettingsSchema.parse({
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.005,
      outputInterval: 0.01,
      dampingRatio: 0.02,
      integrationMethod: "newmark_average_acceleration",
      loadProfile: "sinusoidal",
      rayleighAlpha: 0.1,
      rayleighBeta: 0.0002
    })).toMatchObject({
      integrationMethod: "newmark_average_acceleration",
      loadProfile: "sinusoidal",
      rayleighAlpha: 0.1,
      rayleighBeta: 0.0002
    });

    expect(ResultSummarySchema.parse({
      maxStress: 0.3,
      maxStressUnits: "MPa",
      maxDisplacement: 0.003,
      maxDisplacementUnits: "mm",
      safetyFactor: 920,
      reactionForce: 1,
      reactionForceUnits: "N",
      transient: {
        analysisType: "dynamic_structural",
        integrationMethod: "newmark_average_acceleration",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.01,
        dampingRatio: 0.02,
        frameCount: 11,
        peakDisplacementTimeSeconds: 0.1,
        peakDisplacement: 0.003
      }
    }).transient?.integrationMethod).toBe("newmark_average_acceleration");
  });

  it("accepts optional timing estimates on run events", () => {
    const parsed = RunEventSchema.parse({
      runId: "run-dynamic",
      type: "progress",
      progress: 62,
      message: "Integrating dynamic response.",
      timestamp: "2026-04-24T12:00:00.000Z",
      elapsedMs: 1200,
      estimatedDurationMs: 4800,
      estimatedRemainingMs: 3600
    });

    expect(parsed).toMatchObject({
      elapsedMs: 1200,
      estimatedDurationMs: 4800,
      estimatedRemainingMs: 3600
    });
  });

  it("accepts OpenCAE Core simulation backend settings and ultra mesh quality", () => {
    const parsed = ProjectSchema.parse({
      id: "project-detailed",
      name: "Detailed Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [
        {
          id: "study-detailed",
          projectId: "project-detailed",
          name: "Detailed Static",
          type: "static_stress",
          geometryScope: [],
          materialAssignments: [],
          namedSelections: [],
          contacts: [],
          constraints: [],
          loads: [],
          meshSettings: { preset: "ultra", status: "complete", summary: { nodes: 182400, elements: 119808, warnings: [], analysisSampleCount: 45000, quality: "ultra" } },
          solverSettings: { backend: "opencae_core", fidelity: "ultra" },
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.meshSettings.preset).toBe("ultra");
    expect(parsed.studies[0]?.solverSettings).toMatchObject({
      backend: "opencae_core_cloud",
      fidelity: "ultra"
    });
  });

  it("normalizes legacy solver backend settings for imported project compatibility", () => {
    const parsed = SolverBackendSchema.parse("cloudflare_fea");

    expect(parsed).toBe("opencae_core_cloud");
    expect(SolverBackendSchema.parse("cloudflare-fea-calculix")).toBe("opencae_core_cloud");
    expect(SolverBackendSchema.parse("opencae_core")).toBe("opencae_core_cloud");
  });

  it("requires production Core Cloud provenance and rejects CalculiX or preview sources", () => {
    expect(CoreCloudResultProvenanceSchema.parse({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      solverVersion: "0.1.0",
      meshSource: "actual_volume_mesh",
      resultSource: "computed",
      units: "mm-N-s-MPa"
    }).solver).toBe("opencae-core-cloud");

    expect(() => CoreCloudResultProvenanceSchema.parse({
      kind: "opencae_core_fea",
      solver: "cloudflare-fea-calculix",
      solverVersion: "0.1.0",
      meshSource: "actual_volume_mesh",
      resultSource: "computed",
      units: "mm-N-s-MPa"
    })).toThrow();
    expect(() => CoreCloudResultProvenanceSchema.parse({
      kind: "local_estimate",
      solver: "opencae-core-preview-sdof",
      solverVersion: "0.1.0",
      meshSource: "structured_block_proxy",
      resultSource: "computed_preview",
      units: "mm-N-s-MPa"
    })).toThrow();
  });

  it("classifies result provenance into load-bearing run statuses", () => {
    expect(runStatusForResultProvenance({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      solverVersion: "0.1.0",
      meshSource: "actual_volume_mesh",
      resultSource: "computed",
      units: "mm-N-s-MPa"
    })).toBe("complete");
    expect(runStatusForResultProvenance({
      kind: "local_estimate",
      solver: "opencae-core-preview-tet4",
      solverVersion: "0.1.0",
      meshSource: "structured_block_proxy",
      resultSource: "computed_preview",
      units: "mm-N-s-MPa"
    })).toBe("complete_preview");
    expect(runStatusForResultProvenance({
      kind: "local_estimate",
      solver: "opencae-local-heuristic-surface",
      solverVersion: "0.1.0",
      meshSource: "mock",
      resultSource: "generated",
      units: "mm-N-s-MPa"
    })).toBe("complete_estimate");
    expect(runStatusForResultProvenance({
      kind: "analytical_benchmark",
      solver: "opencae-euler-bernoulli",
      solverVersion: "0.1.0",
      meshSource: "structured_block",
      resultSource: "generated",
      units: "mm-N-s-MPa"
    })).toBe("complete_benchmark");
    expect(classifyResultProvenance({
      kind: "opencae_core_fea",
      solver: ["cloudflare-fea", "calculix"].join("-"),
      solverVersion: "0.1.0",
      meshSource: "actual_volume_mesh",
      resultSource: "computed",
      units: "mm-N-s-MPa"
    })).toBe("imported_legacy");
  });

  it("keeps production attribution reserved for OpenCAE Core Cloud", () => {
    // Valid Core Cloud provenance is the only production FEA path.
    const cloud = {
      kind: "opencae_core_fea" as const,
      solver: "opencae-core-cloud",
      solverVersion: "0.1.0",
      meshSource: "actual_volume_mesh" as const,
      resultSource: "computed" as const,
      units: "mm-N-s-MPa"
    };
    expect(classifyResultProvenance(cloud)).toBe("production_fea");
    expect(runStatusForResultProvenance(cloud)).toBe("complete");

    // Real local Core actual-mesh solves are honest FEA but not production.
    for (const solver of ["opencae-core-sparse-tet", "opencae-core-mdof-tet"]) {
      const local = {
        kind: "opencae_core_fea" as const,
        solver,
        solverVersion: "0.1.0",
        meshSource: "actual_volume_mesh" as const,
        resultSource: "computed" as const,
        units: "m-N-s-Pa"
      };
      expect(classifyResultProvenance(local)).toBe("core_local_fea");
      expect(runStatusForResultProvenance(local)).toBe("complete_local_fea");
    }

    // structured_block_core mesh from a local solver is still local, not production.
    expect(classifyResultProvenance({
      kind: "opencae_core_fea",
      solver: "opencae-core-sparse-tet",
      solverVersion: "0.1.0",
      meshSource: "structured_block_core",
      resultSource: "computed",
      units: "m-N-s-Pa"
    })).toBe("core_local_fea");

    // An unrecognized opencae_core_fea solver must never reach production.
    const unknownSolver = {
      kind: "opencae_core_fea" as const,
      solver: "opencae-core-experimental",
      solverVersion: "0.1.0",
      meshSource: "actual_volume_mesh" as const,
      resultSource: "computed" as const,
      units: "m-N-s-Pa"
    };
    expect(classifyResultProvenance(unknownSolver)).toBe("unknown");
    expect(runStatusForResultProvenance(unknownSolver)).not.toBe("complete");
  });

  it("accepts explicit non-production terminal run statuses", () => {
    expect(StudyRunSchema.parse({
      id: "run-preview",
      studyId: "study-test",
      status: "complete_preview",
      jobId: "job-preview",
      solverBackend: "opencae_core_local",
      solverVersion: "0.1.0",
      diagnostics: []
    }).status).toBe("complete_preview");
    expect(StudyRunSchema.parse({
      id: "run-estimate",
      studyId: "study-test",
      status: "complete_estimate",
      jobId: "job-estimate",
      solverBackend: "local",
      solverVersion: "0.1.0",
      diagnostics: []
    }).status).toBe("complete_estimate");
    const localFea = StudyRunSchema.parse({
      id: "run-local-fea",
      studyId: "study-test",
      status: "complete_local_fea",
      jobId: "job-local-fea",
      solverBackend: "opencae_core_local",
      solverVersion: "0.1.0",
      diagnostics: []
    });
    expect(localFea.status).toBe("complete_local_fea");
    expect(isRunResultReadyStatus(localFea.status)).toBe(true);
  });

  it("accepts rich OpenCAE Core result sample metadata", () => {
    const parsed = ResultFieldSchema.parse({
      id: "field-stress-cloud",
      runId: "run-cloud",
      type: "stress",
      location: "node",
      values: [123100],
      min: 123100,
      max: 123100,
      units: "Pa",
      samples: [
        {
          point: [0, 0, 0],
          normal: [0, 1, 0],
          value: 123100,
          vector: [0.001, -0.002, 0],
          nodeId: "N42",
          elementId: "E7",
          source: "opencae_core",
          vonMisesStressPa: 123100
        }
      ]
    });

    expect(parsed.samples?.[0]).toMatchObject({
      nodeId: "N42",
      elementId: "E7",
      source: "opencae_core",
      vector: [0.001, -0.002, 0],
      vonMisesStressPa: 123100
    });
  });

  it("accepts old result summaries without provenance", () => {
    const parsed = ResultSummarySchema.parse({
      maxStress: 142,
      maxStressUnits: "MPa",
      maxDisplacement: 0.184,
      maxDisplacementUnits: "mm",
      safetyFactor: 1.8,
      reactionForce: 500,
      reactionForceUnits: "N"
    });

    expect(parsed.provenance).toBeUndefined();
  });

  it("defaults missing result summary diagnostics to an empty array", () => {
    const parsed = ResultSummarySchema.parse({
      maxStress: 142,
      maxStressUnits: "MPa",
      maxDisplacement: 0.184,
      maxDisplacementUnits: "mm",
      safetyFactor: 1.8,
      reactionForce: 500,
      reactionForceUnits: "N"
    });

    expect(parsed.diagnostics).toEqual([]);
  });

  it("accepts result summaries and fields with explicit provenance", () => {
    const provenance = {
      kind: "opencae_core_fea",
      solver: "opencae-core-cpu-tet4",
      solverVersion: "2.21",
      meshSource: "opencae_core_tet4",
      resultSource: "computed",
      units: "mm-N-s-MPa"
    } as const;

    expect(ResultSummarySchema.parse({
      maxStress: 123100,
      maxStressUnits: "Pa",
      maxDisplacement: 0.001,
      maxDisplacementUnits: "m",
      safetyFactor: 2.1,
      reactionForce: 500,
      reactionForceUnits: "N",
      provenance
    }).provenance).toEqual(provenance);

    expect(ResultFieldSchema.parse({
      id: "field-stress-cloud",
      runId: "run-cloud",
      type: "stress",
      location: "node",
      values: [123100],
      min: 123100,
      max: 123100,
      units: "Pa",
      provenance
    }).provenance).toEqual(provenance);
  });

  it("accepts OpenCAE Core result summaries and element/node fields", () => {
    const provenance = {
      kind: "opencae_core_fea",
      solver: "opencae-core-cpu-tet4",
      solverVersion: "0.1.0",
      meshSource: "opencae_core_tet4",
      resultSource: "computed",
      units: "mm-N-s-MPa"
    } as const;

    expect(ResultSummarySchema.parse({
      maxStress: 0.18,
      maxStressUnits: "MPa",
      maxDisplacement: 0.0014,
      maxDisplacementUnits: "mm",
      safetyFactor: 1533.33,
      reactionForce: 1,
      reactionForceUnits: "N",
      provenance
    }).provenance).toEqual(provenance);

    expect(ResultFieldSchema.parse({
      id: "field-run-cloud-stress-0",
      runId: "run-cloud",
      type: "stress",
      location: "element",
      values: [0.18],
      min: 0.18,
      max: 0.18,
      units: "MPa",
      provenance,
      samples: [{ point: [50, 15, 5], normal: [0, 0, 1], value: 0.18, elementId: "E1", source: "opencae_core", vonMisesStressPa: 180000 }]
    }).samples?.[0]?.source).toBe("opencae_core");

    expect(ResultFieldSchema.parse({
      id: "field-run-cloud-displacement-0",
      runId: "run-cloud",
      type: "displacement",
      location: "node",
      values: [0.0014],
      min: 0,
      max: 0.0014,
      units: "mm",
      provenance,
      samples: [{ point: [100, 15, 10], normal: [0, 0, 1], value: 0.0014, vector: [0, 0, -0.0014], nodeId: "N2", source: "opencae_core" }]
    }).samples?.[0]?.vector).toEqual([0, 0, -0.0014]);
  });
});

describe("MaterialSchema", () => {
  const aluminum = {
    id: "mat-aluminum-6061",
    name: "Aluminum 6061",
    youngsModulus: 68900000000,
    poissonRatio: 0.33,
    density: 2700,
    yieldStrength: 276000000
  };

  it("accepts physically valid materials", () => {
    expect(MaterialSchema.parse(aluminum).id).toBe("mat-aluminum-6061");
  });

  it("rejects non-positive stiffness, density, and strength", () => {
    expect(() => MaterialSchema.parse({ ...aluminum, youngsModulus: 0 })).toThrow();
    expect(() => MaterialSchema.parse({ ...aluminum, density: -1 })).toThrow();
    expect(() => MaterialSchema.parse({ ...aluminum, yieldStrength: 0 })).toThrow();
  });

  it("rejects physically impossible Poisson ratios", () => {
    expect(() => MaterialSchema.parse({ ...aluminum, poissonRatio: 0.5 })).toThrow();
    expect(() => MaterialSchema.parse({ ...aluminum, poissonRatio: -1 })).toThrow();
    expect(MaterialSchema.parse({ ...aluminum, poissonRatio: 0.499 }).poissonRatio).toBe(0.499);
  });
});
