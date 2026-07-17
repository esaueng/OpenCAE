import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { geometryFromOcctMesh, normalizedStepPreviewFromMeshes } from "./stepPreview";
import { occtMeshesFromStepSurfacePreview, rememberStepSurfacePreview } from "./stepSurfacePreviewFallback";

const importedMesh = {
  attributes: {
    position: { array: [0, 0, 0, 10, 0, 0, 0, 4, 0] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] }
  },
  index: { array: [0, 1, 2] }
};

const secondImportedMesh = {
  attributes: {
    position: { array: [20, 0, 0, 30, 0, 0, 20, 4, 0] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] }
  },
  index: { array: [0, 1, 2] },
  name: "Rod 2"
};

describe("STEP preview helpers", () => {
  test("builds three geometry from imported STEP mesh data", () => {
    const geometry = geometryFromOcctMesh(importedMesh);

    expect(geometry.getAttribute("position").count).toBe(3);
    expect(Array.from(geometry.getIndex()?.array ?? [])).toEqual([0, 1, 2]);
  });

  test("normalizes imported STEP meshes instead of substituting a placeholder box", () => {
    const preview = normalizedStepPreviewFromMeshes([importedMesh], "#9aa7b4");
    const group = preview.object;
    const mesh = group.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined;

    expect(mesh).toBeDefined();
    expect((mesh?.geometry as THREE.BufferGeometry).getAttribute("position").count).toBe(3);
    expect(group.scale.x).toBeCloseTo(0.24);
    expect(group.position.x).toBeCloseTo(-1.2);
    const box = new THREE.Box3().setFromObject(group);
    expect(box.getCenter(new THREE.Vector3()).length()).toBeCloseTo(0);
  });

  test("measures source STEP dimensions before preview normalization", () => {
    const preview = normalizedStepPreviewFromMeshes([importedMesh], "#9aa7b4");

    expect(preview.dimensions).toEqual({ x: 10, y: 4, z: 0, units: "mm" });
  });

  test("returns normalized bounds matching the rendered preview object", () => {
    const preview = normalizedStepPreviewFromMeshes([importedMesh], "#9aa7b4");
    const renderedBounds = new THREE.Box3().setFromObject(preview.object);

    expect(preview.normalizedBounds.min.x).toBeCloseTo(renderedBounds.min.x);
    expect(preview.normalizedBounds.min.y).toBeCloseTo(renderedBounds.min.y);
    expect(preview.normalizedBounds.min.z).toBeCloseTo(renderedBounds.min.z);
    expect(preview.normalizedBounds.max.x).toBeCloseTo(renderedBounds.max.x);
    expect(preview.normalizedBounds.max.y).toBeCloseTo(renderedBounds.max.y);
    expect(preview.normalizedBounds.max.z).toBeCloseTo(renderedBounds.max.z);
  });

  test("assigns stable payload metadata to each imported part mesh", () => {
    const preview = normalizedStepPreviewFromMeshes([{ ...importedMesh, name: "Rod 1" }, secondImportedMesh], "#9aa7b4");
    const meshes = preview.object.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);

    expect(meshes.map((mesh) => mesh.userData.opencaeObjectId)).toEqual(["step-object-1", "step-object-2"]);
    expect(meshes.map((mesh) => mesh.userData.opencaeObjectLabel)).toEqual(["Rod 1", "Rod 2"]);
  });

  test("can skip imported STEP edge geometry for lightweight playback previews", () => {
    const preview = normalizedStepPreviewFromMeshes([importedMesh], "#9aa7b4", { includeEdges: false });
    const mesh = preview.object.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined;

    expect(mesh?.children.some((child) => child instanceof THREE.LineSegments)).toBe(false);
  });

  test("can share imported STEP materials when selection highlighting is not needed", () => {
    const preview = normalizedStepPreviewFromMeshes([importedMesh, secondImportedMesh], "#9aa7b4", { includeEdges: false, shareMaterials: true });
    const meshes = preview.object.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);

    expect(meshes).toHaveLength(2);
    expect(meshes[0]?.material).toBe(meshes[1]?.material);
  });

  test("keeps empty OCCT assembly placeholders without hiding later renderable meshes", () => {
    const preview = normalizedStepPreviewFromMeshes([
      { attributes: { position: { array: [] } }, index: { array: [] }, name: "Empty assembly" },
      importedMesh
    ], "#9aa7b4");

    expect(preview.object.children[0]).toBeInstanceOf(THREE.Group);
    expect(preview.object.children[0]).not.toBeInstanceOf(THREE.Mesh);
    expect(preview.object.children[1]).toBeInstanceOf(THREE.Mesh);
    expect(preview.dimensions).toEqual({ x: 10, y: 4, z: 0, units: "mm" });
  });

  test("converts the retained Gmsh surface mesh into the OCCT-compatible preview contract", () => {
    const meshes = occtMeshesFromStepSurfacePreview({
      meshes: [{
        name: "Faceted body",
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 4, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceRanges: [{ first: 0, last: 0 }]
      }]
    });
    const preview = normalizedStepPreviewFromMeshes(meshes, "#9aa7b4");

    expect(preview.object.children[0]?.name).toBe("Faceted body");
    expect(preview.dimensions).toEqual({ x: 10, y: 4, z: 0, units: "mm" });
    expect(meshes[0]?.brep_faces).toEqual([{ first: 0, last: 0, color: null }]);
  });

  test("remembers when the Gmsh surface must be preferred over an empty OCCT result", async () => {
    const contentBase64 = "cached-faceted-step";
    rememberStepSurfacePreview(contentBase64, {
      status: "solid",
      volumeCount: 1,
      surfaceCount: 1,
      orphanSurfaceCount: 0,
      openBoundaryCurveCount: 0,
      surfaceMeshValid: true,
      repairable: false
    }, {
      meshes: [{
        name: "Fallback body",
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 4, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceRanges: [{ first: 0, last: 0 }]
      }]
    }, { preferred: true });

    const { stepPreviewFromBase64 } = await import("./stepPreview");
    const preview = await stepPreviewFromBase64(contentBase64, "#9aa7b4");

    expect(preview.object.children[0]?.name).toBe("Fallback body");
    expect(preview.dimensions).toEqual({ x: 10, y: 4, z: 0, units: "mm" });
  });
});
