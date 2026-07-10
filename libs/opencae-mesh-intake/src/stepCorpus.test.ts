// STEP robustness corpus (plan A-M3 stage 5): four generated fixtures that
// stress the wasm meshing + attribution pipeline beyond the box-with-bore
// smoke case — fillets (26 B-rep faces), a multi-hole plate, an L-bracket
// with a fused gusset (boolean union seams), and a deliberately thin-walled
// tray (2 mm walls). Per fixture: meshes successfully (Delaunay with the
// existing Frontal auto-retry), zero inverted elements, a single connected
// component, min SICN sanity when the quality query is available, and at
// least one selection maps via byFace after facet->face attribution.
//
// The per-fixture stats table (algorithm, nodes/elements, minSICN, wall time)
// is printed as test output — that log IS part of the deliverable.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attributeFacetsToStepFaces,
  buildStepAttributionTessellation,
  type StepAttributionTessellation
} from "./facetFaceAttribution";
import { mapSelectionToSurfaceSet, type SelectionMappingDiagnostic } from "./coreModelFromMesh";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import { meshStepToMshV2 } from "./wasmMesher";

type CorpusEntry = {
  fixture: string;
  meshSizeMm: number;
  expectedFaceCount: number;
};

const CORPUS: CorpusEntry[] = [
  { fixture: "filleted-block.step", meshSizeMm: 6, expectedFaceCount: 26 },
  { fixture: "multi-hole-plate.step", meshSizeMm: 6, expectedFaceCount: 11 },
  { fixture: "l-bracket-gusset.step", meshSizeMm: 8, expectedFaceCount: 11 },
  { fixture: "thin-walled-tray.step", meshSizeMm: 4, expectedFaceCount: 11 },
  // Production-class complexity: a 160x120 mm carrier frame with 16 scallop
  // cradles pierced by 4 mm drainage bores (curved-curved boolean seams,
  // 40:1 part-to-feature scale) plus counterbored bolt holes and grip notches.
  { fixture: "seed-holder-tray.step", meshSizeMm: 8, expectedFaceCount: 67 }
];

describe("STEP robustness corpus (gmsh-wasm + facet->face attribution)", () => {
  for (const entry of CORPUS) {
    it(`meshes and attributes ${entry.fixture}`, { timeout: 300_000 }, async () => {
      const stepText = readFileSync(new URL(`../fixtures/${entry.fixture}`, import.meta.url), "utf8");

      // Display tessellation (occt-import-js) for attribution.
      const { default: occtimportjs } = await import("occt-import-js");
      const occt = await occtimportjs();
      const imported = occt.ReadStepFile(new TextEncoder().encode(stepText), null);
      expect(imported.success).toBe(true);
      const tessellation = buildStepAttributionTessellation(
        (imported.meshes ?? []).map((mesh: {
          attributes?: { position?: { array: ArrayLike<number> } };
          index?: { array: ArrayLike<number> };
          brep_faces?: Array<{ first: number; last: number }>;
        }) => ({
          positions: mesh.attributes?.position?.array ?? [],
          indices: mesh.index?.array ?? [],
          brepFaces: mesh.brep_faces ?? []
        }))
      );
      expect(tessellation.faceIds).toHaveLength(entry.expectedFaceCount);

      // Volume mesh with the production retry logic.
      const started = Date.now();
      const meshed = await meshStepToMshV2(stepText, { elementOrder: 2, meshSizeMm: entry.meshSizeMm });
      const wallMs = Date.now() - started;
      const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
        units: "mm",
        diagnostics: [`A-M3 corpus ${entry.fixture}`]
      });

      // Mesh validity gates.
      expect(artifact.metadata.elementCount).toBeGreaterThan(0);
      expect(artifact.metadata.meshQuality.invertedElementCount).toBe(0);
      expect(artifact.metadata.meshQuality.minTetVolume).toBeGreaterThan(0);
      expect(artifact.metadata.connectedComponentCount).toBe(1);
      if (meshed.qualityMinSICN !== undefined) {
        expect(meshed.qualityMinSICN).toBeGreaterThan(0);
        expect(meshed.qualityMinSICN).toBeLessThanOrEqual(1);
      }

      // Attribution: every gmsh surface set resolves to some display face.
      const report = attributeFacetsToStepFaces(artifact, tessellation);
      const attributed = report.sets.filter((set) => set.faceId !== null);
      expect(attributed.length).toBe(report.sets.length);
      expect(report.attributedFacetCount).toBe(artifact.surfaceFacets.length);

      // Selection-mapping gate: the largest display face maps via byFace.
      const largestFaceId = largestFace(tessellation);
      const diagnostics: SelectionMappingDiagnostic[] = [];
      const mapped = mapSelectionToSurfaceSet({
        study: {
          namedSelections: [{
            id: "selection-corpus-face",
            entityType: "face",
            geometryRefs: [{ entityType: "face", entityId: largestFaceId }]
          }]
        },
        volumeMesh: artifact,
        selectionRef: "selection-corpus-face",
        role: "fixed_support",
        diagnostics
      });
      expect(mapped.facets.length).toBeGreaterThan(0);
      expect(diagnostics[0]?.mode).toBe("byFace");

      console.log(
        `[A-M3 corpus] fixture=${entry.fixture} algorithm3D=${meshed.algorithm3D} ` +
          `nodes=${artifact.metadata.nodeCount} elements=${artifact.metadata.elementCount} ` +
          `surfaceSets=${artifact.surfaceSets.length} brepFaces=${tessellation.faceIds.length} ` +
          `minSICN=${meshed.qualityMinSICN?.toFixed(4) ?? "n/a"} inverted=0 components=1 ` +
          `byFaceSets=${attributed.length}/${report.sets.length} wallMs=${wallMs}`
      );
    });
  }
});

function largestFace(tessellation: StepAttributionTessellation): string {
  const areas = new Map<number, number>();
  const triangleCount = tessellation.indices.length / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = vertex(tessellation, tessellation.indices[triangle * 3]!);
    const b = vertex(tessellation, tessellation.indices[triangle * 3 + 1]!);
    const c = vertex(tessellation, tessellation.indices[triangle * 3 + 2]!);
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const face = tessellation.triangleFaceIndex[triangle]!;
    areas.set(face, (areas.get(face) ?? 0) + Math.hypot(nx, ny, nz) / 2);
  }
  const winner = [...areas.entries()].sort((left, right) => right[1] - left[1])[0]!;
  return tessellation.faceIds[winner[0]]!;
}

function vertex(tessellation: StepAttributionTessellation, index: number): [number, number, number] {
  return [tessellation.positions[index * 3]!, tessellation.positions[index * 3 + 1]!, tessellation.positions[index * 3 + 2]!];
}
