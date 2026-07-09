import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertProductionSurfaceFieldInvariant,
  solverSurfaceMeshFromModel,
  validateProductionSurfaceFieldInvariant,
  validateCoreResult,
  type CoreSolveResult
} from "../src";
import { createSingleTetModel } from "./fixtures";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("Core result structures", () => {
  test("extracts a valid solver surface mesh from a volume model", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());

    expect(surfaceMesh.id).toBe("solver-surface");
    expect(surfaceMesh.source).toBe("opencae_core_volume_mesh");
    expect(surfaceMesh.coordinateSpace).toBe("solver");
    expect(surfaceMesh.nodes).toHaveLength(4);
    expect(surfaceMesh.nodeMap).toEqual([1, 2, 3, 0]);
    expect(surfaceMesh.triangles).toHaveLength(4);
    for (const triangle of surfaceMesh.triangles) {
      expect(triangle.every((node) => node >= 0 && node < surfaceMesh.nodes.length)).toBe(true);
    }
  });

  test("derives the full boundary skin even when surfaceFacets cover only tagged faces", () => {
    // Gmsh writes 2D elements solely for physical groups, so a meshed model may carry
    // surfaceFacets for just the support/load faces. The render skin must still be the
    // complete boundary derived from the volume connectivity (the Bracket Demo shipped
    // with a partial skin before this guard).
    const model = createSingleTetModel();
    const partial = solverSurfaceMeshFromModel(model);
    expect(partial.triangles).toHaveLength(4);

    model.surfaceFacets = [
      {
        id: 0,
        element: 0,
        elementFace: 0,
        nodes: [1, 2, 3],
        area: 0.5,
        normal: [1, 1, 1],
        center: [1 / 3, 1 / 3, 1 / 3]
      }
    ];
    const surfaceMesh = solverSurfaceMeshFromModel(model);
    expect(surfaceMesh.triangles).toHaveLength(4);
    expect(surfaceMesh.nodes).toHaveLength(4);
    expect([...surfaceMesh.nodeMap].sort()).toEqual([0, 1, 2, 3]);
  });

  test("validates finite non-empty fields and surface mesh triangle references", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields: [
        {
          id: "displacement-surface",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2, 0.3],
          min: 0,
          max: 0.3,
          units: "mm",
          surfaceMeshRef: "solver-surface"
        },
        {
          id: "stress-surface",
          type: "stress",
          location: "node",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa",
          surfaceMeshRef: "solver-surface"
        },
        {
          id: "stress-von-mises-element",
          type: "stress",
          location: "element",
          values: [4],
          min: 4,
          max: 4,
          units: "MPa",
          meshRef: "solver-volume"
        }
      ],
      surfaceMesh,
      diagnostics: [
        {
          id: "core-solve-diagnostics",
          fieldSurfaceAlignment: "ok",
          surfaceNodeCount: surfaceMesh.nodes.length,
          stressFieldValueCount: surfaceMesh.nodes.length,
          displacementFieldValueCount: surfaceMesh.nodes.length
        }
      ],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    expect(validateCoreResult(result).ok).toBe(true);
  });

  test("rejects production results missing solver surface mesh, required fields, and solve diagnostics", () => {
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields: [
        {
          id: "stress-surface",
          type: "stress",
          location: "node",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa"
        }
      ],
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "missing-surface-mesh",
        "missing-required-result-field",
        "missing-core-solve-diagnostics"
      ])
    );
  });

  test("rejects empty fields, non-finite values, bad min/max, and invalid triangles", () => {
    const result: CoreSolveResult = {
      summary: {
        maxStress: Number.POSITIVE_INFINITY,
        maxDisplacement: 0
      },
      fields: [
        {
          id: "empty",
          type: "stress",
          location: "element",
          values: [],
          min: 1,
          max: 0,
          units: "Pa"
        },
        {
          id: "bad-value",
          type: "velocity",
          location: "node",
          values: [Number.NaN],
          min: 0,
          max: 0,
          units: "m/s",
          frameIndex: 0
        }
      ],
      surfaceMesh: {
        id: "solver-surface",
        nodes: [[0, 0, 0]],
        triangles: [[0, 1, 2]],
        coordinateSpace: "solver",
        source: "opencae_core_volume_mesh",
        nodeMap: [0]
      },
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "non-finite-summary",
        "missing-summary-units",
        "empty-field-values",
        "invalid-field-range",
        "non-finite-field-value",
        "missing-frame-metadata",
        "invalid-surface-triangle-node"
      ])
    );
  });

  test("rejects empty solver surface meshes before rendering", () => {
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields: [
        {
          id: "displacement-surface",
          type: "displacement",
          location: "node",
          values: [0],
          min: 0,
          max: 0,
          units: "mm",
          surfaceMeshRef: "solver-surface"
        },
        {
          id: "stress-surface",
          type: "stress",
          location: "node",
          values: [1],
          min: 1,
          max: 1,
          units: "MPa",
          surfaceMeshRef: "solver-surface"
        },
        {
          id: "stress-von-mises-element",
          type: "stress",
          location: "element",
          values: [1],
          min: 1,
          max: 1,
          units: "MPa",
          meshRef: "solver-volume"
        }
      ],
      surfaceMesh: {
        id: "solver-surface",
        nodes: [],
        triangles: [],
        coordinateSpace: "solver",
        source: "opencae_core_volume_mesh",
        nodeMap: [],
        volumeNodeCount: 4
      },
      diagnostics: [
        {
          id: "core-solve-diagnostics",
          fieldSurfaceAlignment: "ok",
          surfaceNodeCount: 0,
          stressFieldValueCount: 0,
          displacementFieldValueCount: 0
        }
      ],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "empty-surface-mesh-nodes",
        "empty-surface-mesh-triangles",
        "surface-field-length-mismatch"
      ])
    );
  });

  test("rejects surface mesh fields that do not align one value per surface node", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields: [
        {
          id: "surface-stress",
          type: "stress",
          location: "node",
          values: [1, 2, 3],
          min: 1,
          max: 3,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id
        }
      ],
      surfaceMesh,
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(
      expect.objectContaining({
        code: "surface-field-length-mismatch",
        message: "Solver surface field length does not match surface mesh node count."
      })
    );
  });

  test("exports a production surface invariant helper for stress and displacement fields", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: Pick<CoreSolveResult, "surfaceMesh" | "fields"> = {
      surfaceMesh,
      fields: [
        {
          id: "displacement-surface",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2, 0.3],
          vectors: [
            [0, 0, 0],
            [0, 0, 0.1],
            [0, 0, 0.2],
            [0, 0, 0.3]
          ],
          min: 0,
          max: 0.3,
          units: "mm",
          surfaceMeshRef: surfaceMesh.id
        },
        {
          id: "stress-surface",
          type: "stress",
          location: "node",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id
        }
      ]
    };

    expect(validateProductionSurfaceFieldInvariant(result)).toEqual({
      ok: true,
      errors: [],
      warnings: []
    });
    expect(() => assertProductionSurfaceFieldInvariant(result)).not.toThrow();
  });

  test("production surface invariant rejects element stress and display mesh sources", () => {
    const surfaceMesh = {
      ...solverSurfaceMeshFromModel(createSingleTetModel()),
      source: "display_geometry"
    } as CoreSolveResult["surfaceMesh"];
    const result: Pick<CoreSolveResult, "surfaceMesh" | "fields"> = {
      surfaceMesh,
      fields: [
        {
          id: "displacement-surface",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2, 0.3],
          min: 0,
          max: 0.3,
          units: "mm",
          surfaceMeshRef: "solver-surface"
        },
        {
          id: "stress-surface",
          type: "stress",
          location: "element",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa",
          surfaceMeshRef: "solver-surface"
        }
      ]
    };

    const report = validateProductionSurfaceFieldInvariant(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "invalid-surface-mesh-source",
        "surface-field-location-mismatch"
      ])
    );
    expect(() => assertProductionSurfaceFieldInvariant(result)).toThrow(/solver surface invariant/i);
  });

  test("rejects surface mesh fields with non-node location or misaligned vectors and samples", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields: [
        {
          id: "element-stress-on-surface",
          type: "stress",
          location: "element",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id
        },
        {
          id: "surface-displacement",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2, 0.3],
          vectors: [[0, 0, 0]],
          samples: [{ node: 0 }],
          min: 0,
          max: 0.3,
          units: "mm",
          surfaceMeshRef: surfaceMesh.id
        }
      ],
      surfaceMesh,
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "surface-field-location-mismatch",
        "surface-field-vector-length-mismatch",
        "surface-field-sample-length-mismatch"
      ])
    );
  });

  test("keeps surface mesh nodeMap and triangle references aligned", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());

    expect(surfaceMesh.nodeMap).toHaveLength(surfaceMesh.nodes.length);
    for (const volumeNode of surfaceMesh.nodeMap) {
      expect(Number.isInteger(volumeNode)).toBe(true);
      expect(volumeNode).toBeGreaterThanOrEqual(0);
      expect(volumeNode).toBeLessThan(createSingleTetModel().nodes.coordinates.length / 3);
    }
    for (const triangle of surfaceMesh.triangles) {
      for (const surfaceNode of triangle) {
        expect(Number.isInteger(surfaceNode)).toBe(true);
        expect(surfaceNode).toBeGreaterThanOrEqual(0);
        expect(surfaceNode).toBeLessThan(surfaceMesh.nodes.length);
      }
    }
  });

  test("rejects dynamic solver-surface velocity and acceleration fields that bypass surface alignment", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-mdof-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        },
        transient: {
          analysisType: "dynamic_structural",
          frameCount: 1,
          startTime: 0,
          endTime: 0.1,
          timeStep: 0.1,
          outputInterval: 0.1,
          loadProfile: "half_sine",
          peakDisplacement: 0.1,
          peakDisplacementTimeSeconds: 0.1
        }
      },
      fields: [
        {
          id: "frame-0-displacement-surface",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2, 0.3],
          min: 0,
          max: 0.3,
          units: "mm",
          surfaceMeshRef: surfaceMesh.id,
          frameIndex: 0,
          timeSeconds: 0
        },
        {
          id: "frame-0-stress-surface",
          type: "stress",
          location: "node",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id,
          frameIndex: 0,
          timeSeconds: 0
        },
        {
          id: "frame-0-velocity",
          type: "velocity",
          location: "node",
          values: [0, 0, 0, 0],
          min: 0,
          max: 0,
          units: "mm/s",
          frameIndex: 0,
          timeSeconds: 0
        },
        {
          id: "frame-0-acceleration",
          type: "acceleration",
          location: "node",
          values: [0, 0],
          min: 0,
          max: 0,
          units: "mm/s^2",
          surfaceMeshRef: surfaceMesh.id,
          frameIndex: 0,
          timeSeconds: 0
        },
        {
          id: "frame-0-stress-von-mises-element",
          type: "stress",
          location: "element",
          values: [4],
          min: 4,
          max: 4,
          units: "MPa",
          meshRef: "solver-volume",
          frameIndex: 0,
          timeSeconds: 0
        }
      ],
      surfaceMesh,
      diagnostics: [
        {
          id: "core-solve-diagnostics",
          fieldSurfaceAlignment: "ok",
          surfaceNodeCount: surfaceMesh.nodes.length,
          stressFieldValueCount: surfaceMesh.nodes.length,
          displacementFieldValueCount: surfaceMesh.nodes.length
        }
      ],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-mdof-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["missing-surface-mesh-reference", "surface-field-length-mismatch"])
    );
  });

  test("does not contain modulo fallback surface-node indexing in packages or services", () => {
    const offenders = sourceFiles(repoRoot)
      .filter((file) => /(?:packages|services)\//.test(file))
      .filter((file) => /nodes\s*\[\s*index\s*%\s*nodes\.length\s*\]/.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });

  test("does not document nearest-sample or downsampling fallbacks for production solver surface fields", () => {
    const offenders = sourceFiles(repoRoot)
      .filter((file) => /(?:packages|services|docs)\//.test(file))
      .filter((file) => !file.endsWith("packages/core/tests/results.test.ts"))
      .filter((file) => /nearest-sample|nearest sample|downsampling fallback|downsample fallback/i.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });

  test("requires safety-factor-surface when a static result carries element safety-factor data", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const buildResult = (fields: CoreSolveResult["fields"]): CoreSolveResult => ({
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        safetyFactor: 2,
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields,
      surfaceMesh,
      diagnostics: [
        {
          id: "core-solve-diagnostics",
          fieldSurfaceAlignment: "ok",
          surfaceNodeCount: surfaceMesh.nodes.length,
          stressFieldValueCount: surfaceMesh.nodes.length,
          displacementFieldValueCount: surfaceMesh.nodes.length
        }
      ],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    });
    const baseFields: CoreSolveResult["fields"] = [
      {
        id: "displacement-surface",
        type: "displacement",
        location: "node",
        values: [0, 0.1, 0.2, 0.3],
        min: 0,
        max: 0.3,
        units: "mm",
        surfaceMeshRef: surfaceMesh.id
      },
      {
        id: "stress-surface",
        type: "stress",
        location: "node",
        values: [1, 2, 3, 4],
        min: 1,
        max: 4,
        units: "MPa",
        surfaceMeshRef: surfaceMesh.id
      },
      {
        id: "stress-von-mises-element",
        type: "stress",
        location: "element",
        values: [4],
        min: 4,
        max: 4,
        units: "MPa",
        meshRef: "solver-volume"
      },
      {
        id: "safety-factor",
        type: "safety_factor",
        location: "element",
        values: [2],
        min: 2,
        max: 2,
        units: "ratio",
        meshRef: "solver-volume"
      }
    ];

    const missingSurfaceSafety = validateCoreResult(buildResult(baseFields));
    expect(missingSurfaceSafety.ok).toBe(false);
    expect(missingSurfaceSafety.errors).toContainEqual(
      expect.objectContaining({
        code: "missing-required-result-field",
        message: expect.stringContaining("safety-factor-surface")
      })
    );

    const withSurfaceSafety = validateCoreResult(
      buildResult([
        ...baseFields,
        {
          id: "safety-factor-surface",
          type: "safety_factor",
          location: "node",
          values: [8, 4, 2.7, 2],
          min: 2,
          max: 8,
          units: "ratio",
          surfaceMeshRef: surfaceMesh.id
        }
      ])
    );
    expect(withSurfaceSafety.ok).toBe(true);
  });

  test("requires per-frame node stress and safety-factor surface fields for transient results", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const frameFields = (frame: number): CoreSolveResult["fields"] => [
      {
        id: `frame-${frame}-displacement-surface`,
        type: "displacement",
        location: "node",
        values: [0, 0.1, 0.2, 0.3],
        min: 0,
        max: 0.3,
        units: "mm",
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame,
        timeSeconds: frame * 0.01
      },
      {
        id: `frame-${frame}-stress-surface`,
        type: "stress",
        location: "node",
        values: [1, 2, 3, 4],
        min: 1,
        max: 4,
        units: "MPa",
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame,
        timeSeconds: frame * 0.01
      },
      {
        id: `frame-${frame}-stress-von-mises-element`,
        type: "stress",
        location: "element",
        values: [4],
        min: 4,
        max: 4,
        units: "MPa",
        meshRef: "solver-volume",
        frameIndex: frame,
        timeSeconds: frame * 0.01
      },
      {
        id: `frame-${frame}-safety-factor`,
        type: "safety_factor",
        location: "element",
        values: [2],
        min: 2,
        max: 2,
        units: "ratio",
        meshRef: "solver-volume",
        frameIndex: frame,
        timeSeconds: frame * 0.01
      },
      {
        id: `frame-${frame}-safety-factor-surface`,
        type: "safety_factor",
        location: "node",
        values: [8, 4, 2.7, 2],
        min: 2,
        max: 8,
        units: "ratio",
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame,
        timeSeconds: frame * 0.01
      }
    ];
    const buildResult = (fields: CoreSolveResult["fields"]): CoreSolveResult => ({
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        safetyFactor: 2,
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-mdof-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        },
        transient: {
          analysisType: "dynamic_structural",
          frameCount: 2,
          startTime: 0,
          endTime: 0.01,
          timeStep: 0.01,
          outputInterval: 0.01,
          loadProfile: "ramp",
          peakDisplacement: 0.3,
          peakDisplacementTimeSeconds: 0.01
        }
      },
      fields,
      surfaceMesh,
      diagnostics: [
        {
          id: "core-solve-diagnostics",
          fieldSurfaceAlignment: "ok",
          surfaceNodeCount: surfaceMesh.nodes.length,
          stressFieldValueCount: surfaceMesh.nodes.length,
          displacementFieldValueCount: surfaceMesh.nodes.length
        }
      ],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-mdof-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    });

    const complete = buildResult([...frameFields(0), ...frameFields(1)]);
    expect(validateCoreResult(complete).ok).toBe(true);

    const missingFrameStress = buildResult([
      ...frameFields(0),
      ...frameFields(1).filter((field) => field.id !== "frame-1-stress-surface")
    ]);
    const missingStressReport = validateCoreResult(missingFrameStress);
    expect(missingStressReport.ok).toBe(false);
    expect(missingStressReport.errors).toContainEqual(
      expect.objectContaining({
        code: "missing-required-result-field",
        message: expect.stringContaining("matching node stress field")
      })
    );

    const missingFrameSafety = buildResult([
      ...frameFields(0),
      ...frameFields(1).filter((field) => field.id !== "frame-1-safety-factor-surface")
    ]);
    const missingSafetyReport = validateCoreResult(missingFrameSafety);
    expect(missingSafetyReport.ok).toBe(false);
    expect(missingSafetyReport.errors).toContainEqual(
      expect.objectContaining({
        code: "missing-required-result-field",
        message: expect.stringContaining("matching node safety_factor field")
      })
    );
  });

  test("rejects Core results missing app-facing summary units and summary provenance", () => {
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxDisplacement: 0.1,
        reactionForce: 5
      } as CoreSolveResult["summary"],
      fields: [
        {
          id: "displacement",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2],
          min: 0,
          max: 0.2,
          units: "mm"
        }
      ],
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["missing-summary-units", "missing-summary-provenance"])
    );
  });
});

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const path = resolve(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|js|jsx|md)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
