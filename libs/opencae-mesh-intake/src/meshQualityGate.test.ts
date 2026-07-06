import { describe, expect, test } from "vitest";
import {
  enforceWasmMeshQualityGate,
  isMeshQualityErrorLike,
  MESH_QUALITY_REJECT_MIN_SICN,
  MESH_QUALITY_WARN_MIN_SICN,
  MeshQualityError
} from "./meshQualityGate";
import type { CoreVolumeMeshArtifact } from "./types";

function artifactFixture(): CoreVolumeMeshArtifact {
  return {
    nodes: { coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    elements: [{ type: "Tet4", connectivity: [0, 1, 2, 3] }],
    surfaceFacets: [],
    surfaceSets: [],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    metadata: {
      source: "gmsh",
      nodeCount: 4,
      elementCount: 1,
      surfaceFacetCount: 0,
      physicalGroups: [],
      connectedComponentCount: 1,
      meshQuality: { minTetVolume: 1, maxTetVolume: 1, invertedElementCount: 0 },
      diagnostics: [],
      units: "m"
    }
  };
}

describe("wasm mesh quality gate (A-M4)", () => {
  test("rejects meshes below the minSICN floor with an actionable error", () => {
    const artifact = artifactFixture();
    expect(() => enforceWasmMeshQualityGate(artifact, 0.01, "Test meshing")).toThrowError(MeshQualityError);
    expect(() => enforceWasmMeshQualityGate(artifact, 0.01, "Test meshing")).toThrowError(/minSICN=0.0100/);
    expect(() => enforceWasmMeshQualityGate(artifact, 0.01, "Test meshing")).toThrowError(/mesh preset|simplify/i);
  });

  test("rejects wasm sessions that cannot measure quality (first-class, not best-effort)", () => {
    expect(() => enforceWasmMeshQualityGate(artifactFixture(), undefined, "Test meshing")).toThrowError(MeshQualityError);
    expect(() => enforceWasmMeshQualityGate(artifactFixture(), Number.NaN, "Test meshing")).toThrowError(/quality/i);
  });

  test("records a warning onto artifact metadata for marginal quality", () => {
    const artifact = artifactFixture();
    const marginal = (MESH_QUALITY_REJECT_MIN_SICN + MESH_QUALITY_WARN_MIN_SICN) / 2;
    const outcome = enforceWasmMeshQualityGate(artifact, marginal, "Test meshing");
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toMatch(/quality warning/i);
    expect(artifact.metadata.meshQuality.minSICN).toBe(marginal);
    expect(artifact.metadata.meshQuality.warnings).toEqual(outcome.warnings);
  });

  test("passes clean meshes with no warnings and stamps minSICN", () => {
    const artifact = artifactFixture();
    const outcome = enforceWasmMeshQualityGate(artifact, 0.42, "Test meshing");
    expect(outcome).toEqual({ minSICN: 0.42, warnings: [] });
    expect(artifact.metadata.meshQuality.minSICN).toBe(0.42);
    expect(artifact.metadata.meshQuality.warnings).toBeUndefined();
  });

  test("quality rejections keep their identity across worker-style serialization", () => {
    try {
      enforceWasmMeshQualityGate(artifactFixture(), 0.01, "Test meshing");
      expect.unreachable("gate must throw");
    } catch (error) {
      // The mesh worker protocol forwards { name, message }; the identity
      // check must work on that shape, not only on the class instance.
      const wireShape = { name: (error as Error).name, message: (error as Error).message };
      expect(isMeshQualityErrorLike(error)).toBe(true);
      expect(isMeshQualityErrorLike(wireShape)).toBe(true);
      expect(isMeshQualityErrorLike(new Error("other"))).toBe(false);
    }
  });
});
