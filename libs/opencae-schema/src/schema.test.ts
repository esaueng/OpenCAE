import { describe, expect, it } from "vitest";
import { CoreCloudResultProvenanceSchema, CustomMaterialSchema, DynamicSolverSettingsSchema, MaterialSchema, MeshConvergenceRecordSchema, ProjectSchema, ResultFieldSchema, ResultSummarySchema, RunEventSchema, RunVariantResultSchema, SolverBackendSchema, StudyRunSchema, classifyResultProvenance, runStatusForResultProvenance } from "./index";

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

  it("persists compact three-rung static convergence records", () => {
    const completeRung = {
      status: "complete" as const,
      actualNodeCount: 100,
      actualElementCount: 300,
      totalDofs: 300,
      freeDofs: 270,
      actualMeshSizeMm: 12,
      rawElementPeakVonMises: 42,
      stressUnits: "MPa",
      probeDisplacement: 0.15,
      displacementUnits: "mm"
    };
    const record = MeshConvergenceRecordSchema.parse({
      id: "convergence-1",
      studyId: "study-1",
      caseId: "case-default",
      createdAt: "2026-07-14T12:00:00.000Z",
      completedAt: "2026-07-14T12:01:00.000Z",
      probe: { point: [1, 2, 3], source: "primary_load" },
      rungs: [
        { ...completeRung, requestedPreset: "coarse" },
        { ...completeRung, requestedPreset: "medium", totalDofs: 600 },
        { ...completeRung, requestedPreset: "fine", totalDofs: 900 }
      ],
      classification: "apparent_convergence",
      lastStepChanges: { displacement: 0.03, stress: 0.08 }
    });

    expect(record.rungs.map((rung) => rung.requestedPreset)).toEqual(["coarse", "medium", "fine"]);
    expect(() => MeshConvergenceRecordSchema.parse({
      ...record,
      rungs: [{ requestedPreset: "coarse", status: "complete" }, ...record.rungs.slice(1)]
    })).toThrow(/requires actualNodeCount/);
    expect(() => MeshConvergenceRecordSchema.parse({
      ...record,
      rungs: [record.rungs[1], record.rungs[0], record.rungs[2]]
    })).toThrow(/ordered coarse, medium, fine/);
    expect(() => MeshConvergenceRecordSchema.parse({
      ...record,
      rungs: [{ requestedPreset: "coarse", status: "skipped" }, ...record.rungs.slice(1)]
    })).toThrow(/requires a reason/);
  });

  it("round-trips project-scoped custom materials in canonical SI units", () => {
    const customMaterial = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };
    const parsed = ProjectSchema.parse({
      id: "project-custom-material",
      name: "Custom material project",
      schemaVersion: "0.3.0",
      unitSystem: "US",
      geometryFiles: [],
      customMaterials: [customMaterial],
      studies: [],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.customMaterials?.[0]).toEqual(customMaterial);
  });

  it("round-trips manufacturing process and 3D print parameters on material assignments", () => {
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
                manufacturingProcessId: "fdm",
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

    const reparsed = ProjectSchema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed.studies[0]?.materialAssignments[0]?.parameters).toMatchObject({
      manufacturingProcessId: "fdm",
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
    expect(parsed.studies[0]).toMatchObject({
      loadCases: [{ id: "case-default", name: "Default", enabled: true, loadIds: [] }],
      loadCombinations: []
    });
  });

  it("migrates legacy structural loads into one default case", () => {
    const parsed = ProjectSchema.parse({
      id: "project-cases",
      name: "Legacy cases",
      schemaVersion: "0.2.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [{
        id: "study-cases",
        projectId: "project-cases",
        name: "Static",
        type: "static_stress",
        geometryScope: [],
        materialAssignments: [],
        namedSelections: [],
        contacts: [],
        constraints: [],
        loads: [{ id: "load-a", type: "force", selectionRef: "face-a", parameters: {}, status: "complete" }],
        meshSettings: { preset: "medium", status: "not_started" },
        solverSettings: {},
        validation: [],
        runs: []
      }],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]).toMatchObject({
      loadCases: [{ id: "case-default", name: "Default", loadIds: ["load-a"] }],
      loadCombinations: []
    });
  });

  it("enforces a one-case load partition and static-only finite combinations", () => {
    const project = {
      id: "project-cases",
      name: "Cases",
      schemaVersion: "0.3.0",
      unitSystem: "SI" as const,
      geometryFiles: [],
      studies: [{
        id: "study-cases",
        projectId: "project-cases",
        name: "Static",
        type: "static_stress" as const,
        geometryScope: [],
        materialAssignments: [],
        namedSelections: [],
        contacts: [],
        constraints: [],
        loads: [{ id: "load-a", type: "force" as const, selectionRef: "face-a", parameters: {}, status: "complete" as const }],
        loadCases: [
          { id: "case-a", name: "A", enabled: true, loadIds: ["load-a"] },
          { id: "case-b", name: "B", enabled: true, loadIds: ["load-a"] }
        ],
        loadCombinations: [{ id: "combo", name: "A-B", enabled: true, factors: [{ caseId: "case-a", factor: 1 }, { caseId: "case-b", factor: -1 }] }],
        meshSettings: { preset: "medium" as const, status: "not_started" as const },
        solverSettings: {},
        validation: [],
        runs: []
      }],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    };
    const duplicate = ProjectSchema.safeParse(project);
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) expect(duplicate.error.issues.some((issue) => issue.message.includes("2 load cases"))).toBe(true);

    const dynamic = structuredClone(project);
    dynamic.studies[0]!.type = "dynamic_structural" as "static_stress";
    const dynamicCombination = ProjectSchema.safeParse(dynamic);
    expect(dynamicCombination.success).toBe(false);
    if (!dynamicCombination.success) expect(dynamicCombination.error.issues.some((issue) => issue.message.includes("Dynamic load combinations"))).toBe(true);
  });

  it("parses run variants and governing envelope indices", () => {
    const summary = {
      maxStress: 42,
      maxStressUnits: "MPa",
      maxDisplacement: 0.25,
      maxDisplacementUnits: "mm",
      safetyFactor: 2,
      reactionForce: 500,
      reactionForceUnits: "N"
    };
    expect(RunVariantResultSchema.parse({
      id: "variant-envelope",
      name: "Envelope",
      kind: "envelope",
      summary,
      fields: [],
      governingVariantIndices: {
        variantIds: ["case-a", "combo-a-b"],
        stress: [0, 1],
        displacement: [1, 0]
      }
    }).governingVariantIndices?.stress).toEqual([0, 1]);
  });

  it("accepts modal studies and defaults to six requested modes", () => {
    const parsed = ProjectSchema.parse({
      id: "project-modal",
      name: "Modal Project",
      schemaVersion: "0.3.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [{
        id: "study-modal",
        projectId: "project-modal",
        name: "Modal Analysis",
        type: "modal_analysis",
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
      }],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });
    expect(parsed.studies[0]).toMatchObject({ type: "modal_analysis", solverSettings: { modeCount: 6 } });
  });

  it("accepts modal summaries and normalized vector fields", () => {
    expect(ResultSummarySchema.parse({
      analysisType: "modal_analysis",
      requestedModeCount: 2,
      convergedModeCount: 1,
      modes: [{ modeIndex: 1, frequencyHz: 81.5, eigenvalue: 262_188, scaledResidual: 2e-8, fieldId: "mode-1" }],
      warning: "Only 1 of 2 requested modes converged."
    })).toMatchObject({ analysisType: "modal_analysis", convergedModeCount: 1 });
    expect(ResultFieldSchema.parse({
      id: "mode-1",
      runId: "run-modal",
      type: "mode_shape",
      location: "node",
      values: [0, 1],
      vectors: [[0, 0, 0], [0, 1, 0]],
      min: 0,
      max: 1,
      units: "normalized",
      modeIndex: 1,
      frequencyHz: 81.5,
      eigenvalue: 262_188,
      scaledResidual: 2e-8
    }).modeIndex).toBe(1);
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

  it("accepts optional stress components without changing legacy fields", () => {
    const base = {
      id: "field-stress",
      runId: "run-static",
      type: "stress" as const,
      location: "node" as const,
      values: [42],
      min: 42,
      max: 42,
      units: "MPa"
    };
    expect(ResultFieldSchema.parse(base).component).toBeUndefined();
    expect(ResultFieldSchema.parse({ ...base, component: "principal_max" }).component).toBe("principal_max");
    expect(() => ResultFieldSchema.parse({ ...base, component: "invalid" })).toThrow();
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
    // Legacy "opencae_core" predates the explicit cloud/local choice, so old
    // project files parse to "auto" (per-model routing), not a cloud selection.
    expect(parsed.studies[0]?.solverSettings).toMatchObject({
      backend: "auto",
      fidelity: "ultra"
    });
  });

  it("normalizes legacy solver backend settings to auto for imported project compatibility", () => {
    // Legacy and unknown backend tokens carry no explicit user choice.
    expect(SolverBackendSchema.parse("cloudflare_fea")).toBe("auto");
    expect(SolverBackendSchema.parse("cloudflare-fea-calculix")).toBe("auto");
    expect(SolverBackendSchema.parse("opencae_core")).toBe("auto");
    expect(SolverBackendSchema.parse("local_detailed")).toBe("auto");
    expect(SolverBackendSchema.parse("auto")).toBe("auto");
  });

  it("preserves explicit local backend choices and aliases retired cloud choices to auto", () => {
    expect(SolverBackendSchema.parse("opencae_core_local")).toBe("opencae_core_local");
    // B4a: the client cloud solve path is retired, but old projects that
    // saved an explicit cloud choice must still load — as "auto".
    expect(SolverBackendSchema.parse("opencae_core_cloud")).toBe("auto");
  });

  it("round-trips a retired opencae_core_cloud backend through parse -> serialize -> parse", () => {
    const parsed = SolverBackendSchema.parse("opencae_core_cloud");
    expect(parsed).toBe("auto");
    // Serialized form of the migrated value stays parseable and stable.
    const reparsed = SolverBackendSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toBe("auto");
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

  it("requires UUID-backed custom materials to be marked unverified", () => {
    const custom = {
      ...aluminum,
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      category: "metal" as const,
      verification: "user_supplied_unverified" as const
    };
    expect(CustomMaterialSchema.parse(custom).verification).toBe("user_supplied_unverified");
    expect(() => CustomMaterialSchema.parse({ ...custom, id: "shop-aluminum" })).toThrow();
    expect(() => CustomMaterialSchema.parse({ ...custom, verification: "verified" })).toThrow();
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

  it("accepts partial FDM calibration profiles and preserves their factors", () => {
    const material = MaterialSchema.parse({
      ...aluminum,
      printProfile: {
        process: "FDM",
        inPlaneModulusFactor: 0.88,
        interlayerModulusFactor: 0.6,
        inPlaneStrengthFactor: 0.7,
        interlayerStrengthFactor: 0.35
      }
    });

    expect(material.printProfile).toMatchObject({
      process: "FDM",
      inPlaneModulusFactor: 0.88,
      interlayerModulusFactor: 0.6,
      inPlaneStrengthFactor: 0.7,
      interlayerStrengthFactor: 0.35
    });
    expect(MaterialSchema.parse({ ...aluminum, printProfile: { process: "FDM" } }).printProfile?.process).toBe("FDM");
  });

  it("rejects out-of-range or stronger interlayer FDM calibration factors", () => {
    expect(() => MaterialSchema.parse({
      ...aluminum,
      printProfile: { process: "FDM", inPlaneStrengthFactor: 0.5, interlayerStrengthFactor: 0.7 }
    })).toThrow(/Interlayer strength/);
    expect(() => MaterialSchema.parse({
      ...aluminum,
      printProfile: { process: "FDM", inPlaneModulusFactor: 0.5, interlayerModulusFactor: 0.7 }
    })).toThrow(/Interlayer modulus/);
    expect(() => MaterialSchema.parse({
      ...aluminum,
      printProfile: { process: "FDM", interlayerStrengthFactor: 1.1 }
    })).toThrow();
  });
});
