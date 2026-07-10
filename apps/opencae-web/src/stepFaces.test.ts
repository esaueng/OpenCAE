// Unit tests for the STEP B-rep face registry (plan A-M3 stage 1) against the
// checked-in box-with-bore fixture. occt-import-js runs fine in Node, so this
// exercises the REAL tessellation + brep_faces ranges, not synthetic data.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OcctMesh } from "occt-import-js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildStepFaceRegistry,
  resolvePickedStepFace,
  stepAttributionForRegistry,
  stepFaceFingerprint,
  stepFaceIdForMeshTriangle,
  stepFaceRecordForId,
  type StepFaceRegistry
} from "./stepFaces";

const FIXTURE_DIMENSIONS_MM = { x: 60, y: 40, z: 20, boreDiameter: 12 };

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step"
);

async function importFixtureMeshes(): Promise<OcctMesh[]> {
  const { default: occtimportjs } = await import("occt-import-js");
  const occt = await occtimportjs();
  const result = occt.ReadStepFile(new Uint8Array(readFileSync(fixturePath)), null);
  expect(result.success).toBe(true);
  return result.meshes ?? [];
}

describe("STEP face registry (box-with-bore fixture)", () => {
  let registry: StepFaceRegistry;
  let meshes: OcctMesh[];

  beforeAll(async () => {
    meshes = await importFixtureMeshes();
    registry = buildStepFaceRegistry(meshes);
  }, 60_000);

  it("finds one face record per brep face with global step-face ids", () => {
    const totalBrepFaces = meshes.reduce((total, mesh) => total + (mesh.brep_faces?.length ?? 0), 0);
    // Box with a through-bore: 6 box faces (two carry the bore hole) + 1 cylinder.
    expect(totalBrepFaces).toBe(7);
    expect(registry.faces).toHaveLength(7);
    expect(registry.faces.map((face) => face.faceId)).toEqual(
      Array.from({ length: 7 }, (_value, index) => `step-face-${index}`)
    );
    expect(registry.displayFaces).toHaveLength(7);
  });

  it("computes real areas, centroids, and normals in STEP model units (mm)", () => {
    const { x, y, z, boreDiameter } = FIXTURE_DIMENSIONS_MM;
    const boreRadius = boreDiameter / 2;

    // The four un-bored box sides have exact rectangular areas.
    const sideAreas = registry.faces.map((face) => Math.round(face.area));
    expect(sideAreas).toContain(x * z); // front/back (60x20)
    expect(sideAreas).toContain(y * z); // left/right (40x20)

    // Top/bottom carry the bore hole: x*y - pi*r^2 (tessellated circle is
    // slightly smaller, allow 2%).
    const boredArea = x * y - Math.PI * boreRadius ** 2;
    const boredFaces = registry.faces.filter((face) => Math.abs(face.area - boredArea) / boredArea < 0.02);
    expect(boredFaces.length).toBe(2);

    // The bore cylinder: lateral area 2*pi*r*z (tessellated, allow 2%).
    const boreArea = 2 * Math.PI * boreRadius * z;
    const boreFace = registry.faces.find((face) => Math.abs(face.area - boreArea) / boreArea < 0.02);
    expect(boreFace).toBeDefined();
    // Curved face: area-weighted normals cancel around the cylinder.
    expect(Math.hypot(...boreFace!.avgNormal)).toBeLessThanOrEqual(1);
    expect(boreFace!.centroid[0]).toBeCloseTo(x / 2, 0);
    expect(boreFace!.centroid[1]).toBeCloseTo(y / 2, 0);

    // A planar side face has an axis-aligned unit average normal.
    const planarSide = registry.faces.find((face) => Math.round(face.area) === y * z)!;
    const dominant = Math.max(...planarSide.avgNormal.map(Math.abs));
    expect(dominant).toBeGreaterThan(0.999);
  });

  it("maps every tessellation triangle back to exactly its owning face", () => {
    for (const face of registry.faces) {
      const [first, last] = face.triangleRange;
      expect(stepFaceIdForMeshTriangle(registry, face.meshIndex, first)).toBe(face.faceId);
      expect(stepFaceIdForMeshTriangle(registry, face.meshIndex, last)).toBe(face.faceId);
      expect(stepFaceIdForMeshTriangle(registry, face.meshIndex, Math.floor((first + last) / 2))).toBe(face.faceId);
    }
    const meshTriangleCount = registry.meshes[0]!.indices.length / 3;
    expect(stepFaceIdForMeshTriangle(registry, 0, meshTriangleCount)).toBeNull();
    expect(stepFaceIdForMeshTriangle(registry, 4, 0)).toBeNull();
  });

  it("issues quantized fingerprints that survive re-tessellation of the same file", async () => {
    const secondImport = buildStepFaceRegistry(await importFixtureMeshes());
    expect(secondImport.faces.map((face) => face.fingerprint)).toEqual(registry.faces.map((face) => face.fingerprint));
    // Distinct faces get distinct fingerprints on this fixture.
    expect(new Set(registry.faces.map((face) => face.fingerprint)).size).toBe(registry.faces.length);
    // Small numeric jitter within quantization does not change the digest.
    const face = registry.faces[0]!;
    expect(stepFaceFingerprint(face.area * 1.0005, face.centroid, face.avgNormal)).toBe(face.fingerprint);
  }, 60_000);

  it("produces viewer-space display faces matching the normalized STEP preview transform", () => {
    // normalizedStepPreviewFromMeshes scales the model to max dimension 2.4
    // and centers it on the origin; display faces must land inside that box.
    for (const displayFace of registry.displayFaces) {
      for (const component of displayFace.center) {
        expect(Math.abs(component)).toBeLessThanOrEqual(1.21);
      }
      expect(displayFace.area).toBeGreaterThan(0);
      expect(displayFace.label).toMatch(/F\d+/);
    }
    const scale = registry.normalization.scale;
    expect(scale).toBeCloseTo(2.4 / FIXTURE_DIMENSIONS_MM.x, 6);
    const record = registry.faces[0]!;
    const displayFace = registry.displayFaces[0]!;
    expect(displayFace.center[0]).toBeCloseTo(record.centroid[0] * scale + registry.normalization.offset[0], 6);
  });

  it("flattens to a transferable attribution tessellation with per-triangle faceIds", () => {
    const attribution = stepAttributionForRegistry(registry);
    expect(attribution.unitScale).toBe(0.001);
    expect(attribution.faceIds).toEqual(registry.faces.map((face) => face.faceId));
    expect(attribution.triangleFaceIndex.length * 3).toBe(attribution.indices.length);
    // Triangle ownership must agree with the registry's binary search.
    for (let triangle = 0; triangle < attribution.triangleFaceIndex.length; triangle += 1) {
      const expected = stepFaceIdForMeshTriangle(registry, 0, triangle);
      expect(attribution.faceIds[attribution.triangleFaceIndex[triangle]!]).toBe(expected);
    }
  });

  it("looks up records by faceId", () => {
    expect(stepFaceRecordForId(registry, "step-face-3")?.faceId).toBe("step-face-3");
    expect(stepFaceRecordForId(registry, "step-face-99")).toBeNull();
    expect(stepFaceRecordForId(registry, "face-upload-top")).toBeNull();
  });

  describe("resolvePickedStepFace", () => {
    const { x, y, z, boreDiameter } = FIXTURE_DIMENSIONS_MM;
    const toViewer = (model: [number, number, number]): [number, number, number] => [
      model[0] * registry.normalization.scale + registry.normalization.offset[0],
      model[1] * registry.normalization.scale + registry.normalization.offset[1],
      model[2] * registry.normalization.scale + registry.normalization.offset[2]
    ];
    const topFaceId = () => {
      const boredArea = x * y - Math.PI * (boreDiameter / 2) ** 2;
      return registry.faces.find((face) => Math.abs(face.area - boredArea) / boredArea < 0.02 && face.centroid[2] > z / 2)!.faceId;
    };
    const boreFaceId = () => {
      const boreArea = 2 * Math.PI * (boreDiameter / 2) * z;
      return registry.faces.find((face) => Math.abs(face.area - boreArea) / boreArea < 0.02)!.faceId;
    };

    it("resolves a pick on a planar face by point-to-triangle distance", () => {
      const resolved = resolvePickedStepFace(registry, toViewer([10, 10, z]), [0, 0, 1]);
      expect(resolved?.faceId).toBe(topFaceId());
    });

    it("resolves a pick on the bore cylinder via the nearest triangle's own normal", () => {
      // The bore is a hole, so its wall normals point toward the axis: -X at
      // the +X side of the bore — the same normal a viewport raycast reports.
      const resolved = resolvePickedStepFace(registry, toViewer([x / 2 + boreDiameter / 2, y / 2, z / 2]), [-1, 0, 0]);
      expect(resolved?.faceId).toBe(boreFaceId());
    });

    it("tolerates the picked id's 0.01 viewer-unit quantization", () => {
      const quantized = toViewer([10, 10, z]).map((value) => Math.round(value * 100) / 100) as [number, number, number];
      const resolved = resolvePickedStepFace(registry, quantized, [0, 0, 1]);
      expect(resolved?.faceId).toBe(topFaceId());
    });

    it("returns null for points off every surface and for disagreeing normals", () => {
      // Bore axis midpoint: 6 mm from the nearest surface, far beyond tolerance.
      expect(resolvePickedStepFace(registry, toViewer([x / 2, y / 2, z / 2]), [0, 0, 1])).toBeNull();
      // On the top face but with an inverted normal: the gate rejects it and
      // no other face is within tolerance.
      expect(resolvePickedStepFace(registry, toViewer([10, 10, z]), [0, 0, -1])).toBeNull();
    });
  });
});
