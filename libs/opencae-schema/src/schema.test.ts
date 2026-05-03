import { describe, expect, it } from "vitest";
import { DynamicSolverSettingsSchema, ProjectSchema, ResultFieldSchema, ResultSummarySchema, RunEventSchema } from "./index";

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
        kind: "calculix_fea",
        solver: "calculix-ccx",
        solverVersion: "2.21",
        meshSource: "structured_block",
        resultSource: "parsed_frd_dat",
        units: "mm-N-s-MPa",
        integrationMethod: "calculix_dynamic_direct",
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

  it("accepts CalculiX direct dynamic settings and transient metadata", () => {
    expect(DynamicSolverSettingsSchema.parse({
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.005,
      outputInterval: 0.01,
      dampingRatio: 0.02,
      integrationMethod: "calculix_dynamic_direct",
      loadProfile: "sinusoidal",
      rayleighAlpha: 0.1,
      rayleighBeta: 0.0002
    })).toMatchObject({
      integrationMethod: "calculix_dynamic_direct",
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
        integrationMethod: "calculix_dynamic_direct",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.01,
        dampingRatio: 0.02,
        frameCount: 11,
        peakDisplacementTimeSeconds: 0.1,
        peakDisplacement: 0.003
      }
    }).transient?.integrationMethod).toBe("calculix_dynamic_direct");
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

  it("accepts detailed simulation backend settings and ultra mesh quality", () => {
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
          solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" },
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.meshSettings.preset).toBe("ultra");
    expect(parsed.studies[0]?.solverSettings).toMatchObject({
      backend: "cloudflare_fea",
      fidelity: "ultra"
    });
  });

  it("accepts rich result sample metadata from local and cloud FEA backends", () => {
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
          source: "calculix",
          vonMisesStressPa: 123100
        }
      ]
    });

    expect(parsed.samples?.[0]).toMatchObject({
      nodeId: "N42",
      elementId: "E7",
      source: "calculix",
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

  it("accepts result summaries and fields with explicit provenance", () => {
    const provenance = {
      kind: "calculix_fea",
      solver: "calculix-ccx",
      solverVersion: "2.21",
      meshSource: "gmsh",
      resultSource: "parsed_frd_dat",
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

  it("accepts parsed CalculiX DAT result summaries and element/node fields", () => {
    const provenance = {
      kind: "calculix_fea",
      solver: "calculix-ccx",
      solverVersion: "2.21",
      meshSource: "structured_block",
      resultSource: "parsed_dat",
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
      samples: [{ point: [50, 15, 5], normal: [0, 0, 1], value: 0.18, elementId: "E1", source: "calculix-dat", vonMisesStressPa: 180000 }]
    }).samples?.[0]?.source).toBe("calculix-dat");

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
      samples: [{ point: [100, 15, 10], normal: [0, 0, 1], value: 0.0014, vector: [0, 0, -0.0014], nodeId: "N2", source: "calculix-dat" }]
    }).samples?.[0]?.vector).toEqual([0, 0, -0.0014]);
  });
});
