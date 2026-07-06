// Facet -> B-rep face attribution tests (plan A-M3 stage 4) on the real
// pipeline: occt-import-js tessellates the checked-in STEP fixture,
// gmsh-wasm volume-meshes the same file, and the attribution must bridge the
// two OCCT sessions geometrically (surface tags are NOT assumed to match).
//
// Acceptance gate: with attribution stamped, selection mapping resolves via
// byFace (or bySelection) and NEVER the geometric fallback.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  attributeFacetsToStepFaces,
  buildStepAttributionTessellation,
  type FacetAttributionReport,
  type StepAttributionTessellation
} from "./facetFaceAttribution";
import { mapSelectionToSurfaceSet, type SelectionMappingDiagnostic } from "./coreModelFromMesh";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import { meshStepToMshV2 } from "./wasmMesher";
import type { CoreVolumeMeshArtifact } from "./types";

const fixtureUrl = new URL("../fixtures/box-with-bore.step", import.meta.url);
const DIMS = { x: 60, y: 40, z: 20, boreDiameter: 12 };

type OcctFaceInfo = {
  faceId: string;
  area: number;
  centroid: [number, number, number];
  avgNormal: [number, number, number];
  /** |area-weighted normal sum| / area: ~1 planar, << 1 for closed curved faces. */
  normalCoherence: number;
};

let tessellation: StepAttributionTessellation;
let occtFaces: OcctFaceInfo[];
let artifact: CoreVolumeMeshArtifact;
let report: FacetAttributionReport;

beforeAll(async () => {
  const stepBytes = readFileSync(fixtureUrl);

  // Display tessellation via occt-import-js (same wasm the app ships).
  const { default: occtimportjs } = await import("occt-import-js");
  const occt = await occtimportjs();
  const imported = occt.ReadStepFile(new Uint8Array(stepBytes), null);
  expect(imported.success).toBe(true);
  const meshes = (imported.meshes ?? []).map((mesh: {
    attributes?: { position?: { array: ArrayLike<number> } };
    index?: { array: ArrayLike<number> };
    brep_faces?: Array<{ first: number; last: number }>;
  }) => ({
    positions: mesh.attributes?.position?.array ?? [],
    indices: mesh.index?.array ?? [],
    brepFaces: mesh.brep_faces ?? []
  }));
  tessellation = buildStepAttributionTessellation(meshes, { unitScale: 0.001 });
  occtFaces = faceInfos(tessellation);

  // Volume mesh of the SAME file via gmsh-wasm.
  const meshed = await meshStepToMshV2(stepBytes.toString("utf8"), { elementOrder: 2, meshSizeMm: 6 });
  artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm", diagnostics: ["A-M3 attribution test"] });

  report = attributeFacetsToStepFaces(artifact, tessellation);
}, 240_000);

describe("buildStepAttributionTessellation", () => {
  it("flattens the fixture into 7 faces with contiguous triangle ownership", () => {
    expect(tessellation.faceIds).toHaveLength(7);
    expect(tessellation.triangleFaceIndex.length).toBe(tessellation.indices.length / 3);
    const counts = new Map<number, number>();
    for (const faceIndex of tessellation.triangleFaceIndex) {
      counts.set(faceIndex, (counts.get(faceIndex) ?? 0) + 1);
    }
    expect(counts.size).toBe(7);
  });

  it("rejects mismatched explicit faceIds", () => {
    expect(() => buildStepAttributionTessellation(
      [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], brepFaces: [{ first: 0, last: 0 }] }],
      { faceIds: ["a", "b"] }
    )).toThrow(/faceIds length/);
  });
});

describe("attributeFacetsToStepFaces (whole-set voting)", () => {
  it("stamps sourceFaceId on every facet of every gmsh surface set", () => {
    expect(report.sets.length).toBeGreaterThanOrEqual(7);
    expect(report.attributedSetCount).toBe(report.sets.length);
    expect(report.attributedFacetCount).toBe(artifact.surfaceFacets.length);
    expect(artifact.surfaceFacets.every((facet) => typeof facet.sourceFaceId === "string")).toBe(true);
  });

  it("votes unanimously within each surface set on this clean fixture", () => {
    for (const set of report.sets) {
      expect(set.faceId, `set ${set.surfaceSet}`).not.toBeNull();
      expect(set.agreement, `set ${set.surfaceSet} agreement`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("assigns geometrically correct faces (fixed -X side and bore cylinder)", () => {
    const minusXFace = occtFaces.find((face) => face.avgNormal[0] < -0.99)!;
    expect(minusXFace).toBeDefined();
    const minusXFacets = artifact.surfaceFacets.filter((facet) => facet.sourceFaceId === minusXFace.faceId);
    expect(minusXFacets.length).toBeGreaterThan(0);
    for (const facet of minusXFacets) {
      expect(facet.center?.[0]).toBeCloseTo(0, 4); // x = 0 plane, meters
    }

    const boreFace = occtFaces.reduce((best, face) => (face.normalCoherence < best.normalCoherence ? face : best));
    const boreFacets = artifact.surfaceFacets.filter((facet) => facet.sourceFaceId === boreFace.faceId);
    expect(boreFacets.length).toBeGreaterThan(0);
    const radius = (DIMS.boreDiameter / 2) * 1e-3;
    for (const facet of boreFacets) {
      const dx = facet.center![0] - DIMS.x / 2 * 1e-3;
      const dy = facet.center![1] - DIMS.y / 2 * 1e-3;
      // Facet centroids of a tessellated cylinder sit slightly inside r.
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(radius * 1.02);
      expect(Math.hypot(dx, dy)).toBeGreaterThan(radius * 0.85);
    }
  });
});

describe("selection mapping acceptance gate (byFace, never geometric)", () => {
  it("resolves face selections via byFace with the stamped artifact", () => {
    const supportFace = occtFaces.find((face) => face.avgNormal[0] < -0.99)!;
    const loadFace = occtFaces.find((face) => face.avgNormal[2] > 0.99)!;
    const study = {
      namedSelections: [
        {
          id: "selection-support",
          entityType: "face",
          geometryRefs: [{ entityType: "face", entityId: supportFace.faceId }]
        },
        {
          id: "selection-load",
          entityType: "face",
          geometryRefs: [{ entityType: "face", entityId: loadFace.faceId }]
        }
      ]
    };

    const diagnostics: SelectionMappingDiagnostic[] = [];
    const supportSet = mapSelectionToSurfaceSet({
      study,
      volumeMesh: artifact,
      selectionRef: "selection-support",
      role: "fixed_support",
      diagnostics
    });
    const loadSet = mapSelectionToSurfaceSet({
      study,
      volumeMesh: artifact,
      selectionRef: "selection-load",
      role: "load_surface",
      diagnostics
    });

    expect(supportSet.facets.length).toBeGreaterThan(0);
    expect(loadSet.facets.length).toBeGreaterThan(0);
    expect(supportSet.name).not.toBe(loadSet.name);
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.mode).toBe("byFace");
      expect(diagnostic.mode).not.toBe("geometric");
      expect(diagnostic.matchedFacetCount).toBeGreaterThan(0);
    }
  });

  it("without attribution the same selections cannot resolve byFace (control)", async () => {
    const stepBytes = readFileSync(fixtureUrl);
    const meshed = await meshStepToMshV2(stepBytes.toString("utf8"), { elementOrder: 1, meshSizeMm: 10 });
    const bareArtifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm" });
    const supportFace = occtFaces.find((face) => face.avgNormal[0] < -0.99)!;
    const diagnostics: SelectionMappingDiagnostic[] = [];
    expect(() => mapSelectionToSurfaceSet({
      study: {
        namedSelections: [{
          id: "selection-support",
          entityType: "face",
          geometryRefs: [{ entityType: "face", entityId: supportFace.faceId }]
        }]
      },
      volumeMesh: bareArtifact,
      selectionRef: "selection-support",
      role: "fixed_support",
      diagnostics
    })).toThrow(/could not map selection/);
    expect(diagnostics).toHaveLength(0);
  }, 240_000);
});

function faceInfos(input: StepAttributionTessellation): OcctFaceInfo[] {
  const faces: OcctFaceInfo[] = input.faceIds.map((faceId) => ({
    faceId,
    area: 0,
    centroid: [0, 0, 0],
    avgNormal: [0, 0, 0],
    normalCoherence: 0
  }));
  const triangleCount = input.indices.length / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const face = faces[input.triangleFaceIndex[triangle]!]!;
    const a = vertexAt(input, input.indices[triangle * 3]!);
    const b = vertexAt(input, input.indices[triangle * 3 + 1]!);
    const c = vertexAt(input, input.indices[triangle * 3 + 2]!);
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const area = Math.hypot(nx, ny, nz) / 2;
    face.area += area;
    face.centroid[0] += ((a[0] + b[0] + c[0]) / 3) * area;
    face.centroid[1] += ((a[1] + b[1] + c[1]) / 3) * area;
    face.centroid[2] += ((a[2] + b[2] + c[2]) / 3) * area;
    face.avgNormal[0] += nx / 2;
    face.avgNormal[1] += ny / 2;
    face.avgNormal[2] += nz / 2;
  }
  for (const face of faces) {
    if (face.area > 0) {
      face.centroid = face.centroid.map((value) => value / face.area) as [number, number, number];
    }
    const length = Math.hypot(...face.avgNormal);
    face.normalCoherence = face.area > 0 ? length / face.area : 0;
    face.avgNormal = (length > 0 ? face.avgNormal.map((value) => value / length) : [0, 0, 1]) as [number, number, number];
  }
  return faces;
}

function vertexAt(input: StepAttributionTessellation, index: number): [number, number, number] {
  return [input.positions[index * 3]!, input.positions[index * 3 + 1]!, input.positions[index * 3 + 2]!];
}
