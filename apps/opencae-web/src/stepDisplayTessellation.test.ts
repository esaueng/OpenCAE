import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { OcctImporter, OcctMesh } from "occt-import-js";
import occtimportjs from "occt-import-js";
import { buildParametricPartStep } from "@opencae/step";
import { normalizedStepPreviewFromMeshes } from "./stepPreview";
import {
  readStepFileForDisplay,
  stepDisplayCacheKey,
  stepDisplayTessellationParameters
} from "./stepDisplayTessellation";

const TEST_DIAMETERS_MM = [1, 25, 500] as const;
const NORMAL_VIEW_RADIUS_PX = 480;
const CLOSE_VIEW_RADIUS_PX = 2_000;
const MAX_VISIBLE_CHORD_ERROR_PX = 0.5;

let importer: OcctImporter;

beforeAll(async () => {
  importer = await occtimportjs();
}, 60_000);

describe("STEP display tessellation", () => {
  it.each(TEST_DIAMETERS_MM)(
    "keeps a %s mm analytic cylinder silhouette and outline sub-pixel smooth at normal and close zoom",
    (diameter) => {
      const { stepText } = buildParametricPartStep(
        "cylinder",
        { diameter, height: diameter },
        { createdAt: new Date("2026-07-28T00:00:00Z") }
      );

      // The display refinement must never replace the exact CAD source.
      expect(stepText).toContain("CYLINDRICAL_SURFACE");
      expect(stepText).toContain("CIRCLE");

      const result = readStepFileForDisplay(
        importer,
        new TextEncoder().encode(stepText),
        "detailed"
      );
      expect(result.success).toBe(true);
      const mesh = result.meshes?.[0];
      expect(mesh).toBeDefined();

      const perimeter = topPerimeter(mesh!, diameter);
      const maxAngularGap = maximumAngularGap(perimeter);
      expect(perimeter.length).toBeGreaterThanOrEqual(180);
      expect(projectedChordError(maxAngularGap, NORMAL_VIEW_RADIUS_PX))
        .toBeLessThan(MAX_VISIBLE_CHORD_ERROR_PX);
      expect(projectedChordError(maxAngularGap, CLOSE_VIEW_RADIUS_PX))
        .toBeLessThan(MAX_VISIBLE_CHORD_ERROR_PX);

      const preview = normalizedStepPreviewFromMeshes([mesh!], "#9aa7b4");
      const surface = preview.object.children.find(
        (child): child is THREE.Mesh => child instanceof THREE.Mesh
      );
      const outline = surface?.children.find(
        (child): child is THREE.LineSegments => child instanceof THREE.LineSegments
      );
      expect(surface).toBeDefined();
      expect(outline).toBeDefined();

      const surfaceGeometry = surface!.geometry as THREE.BufferGeometry;
      const outlineGeometry = outline!.geometry as THREE.BufferGeometry;
      const outlinePerimeter = topPerimeterFromAttribute(
        outlineGeometry.getAttribute("position").array,
        diameter
      );
      expect(outlinePerimeter.length).toBe(perimeter.length);
      expect(projectedChordError(maximumAngularGap(outlinePerimeter), CLOSE_VIEW_RADIUS_PX))
        .toBeLessThan(MAX_VISIBLE_CHORD_ERROR_PX);
      expectOutlineVerticesOnSurface(outlineGeometry, surfaceGeometry);
      expectSmoothCylinderNormals(mesh!, diameter);

      // Bound a simple cylinder so a display-quality increase cannot silently
      // turn into an unbounded triangle-count regression.
      expect((mesh?.index?.array.length ?? 0) / 3).toBeLessThan(1_200);
    }
  );

  it("uses a lower-cost balanced LOD while retaining a smooth curved silhouette", () => {
    const { stepText } = buildParametricPartStep(
      "cylinder",
      { diameter: 25, height: 25 },
      { createdAt: new Date("2026-07-28T00:00:00Z") }
    );
    const content = new TextEncoder().encode(stepText);
    const detailed = readStepFileForDisplay(importer, content, "detailed").meshes?.[0];
    const balanced = readStepFileForDisplay(importer, content, "balanced").meshes?.[0];
    const detailedSegments = topPerimeter(detailed!, 25).length;
    const balancedPerimeter = topPerimeter(balanced!, 25);

    expect(balancedPerimeter.length).toBeGreaterThanOrEqual(120);
    expect(balancedPerimeter.length).toBeLessThan(detailedSegments);
    expect(projectedChordError(maximumAngularGap(balancedPerimeter), NORMAL_VIEW_RADIUS_PX))
      .toBeLessThan(MAX_VISIBLE_CHORD_ERROR_PX);
  });

  it("scales chordal tolerance with the model and invalidates tessellation caches", () => {
    expect(stepDisplayTessellationParameters("detailed")).toMatchObject({
      linearUnit: "millimeter",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.0001,
      angularDeflection: 0.12
    });
    expect(stepDisplayCacheKey("geometry-a")).not.toBe(stepDisplayCacheKey("geometry-b"));
    expect(stepDisplayCacheKey("geometry-a", "detailed"))
      .not.toBe(stepDisplayCacheKey("geometry-a", "balanced"));
  });
});

function topPerimeter(mesh: OcctMesh, diameter: number): Array<[number, number]> {
  return topPerimeterFromAttribute(mesh.attributes?.position?.array ?? [], diameter);
}

function topPerimeterFromAttribute(
  positions: ArrayLike<number>,
  diameter: number
): Array<[number, number]> {
  const radius = diameter / 2;
  const coordinateTolerance = Math.max(1e-6, diameter * 1e-5);
  const radialTolerance = Math.max(1e-6, diameter * 1e-4);
  const unique = new Map<string, [number, number]>();
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const x = positions[offset]!;
    const y = positions[offset + 1]!;
    const z = positions[offset + 2]!;
    if (Math.abs(z - diameter) > coordinateTolerance) continue;
    if (Math.abs(Math.hypot(x, y) - radius) > radialTolerance) continue;
    unique.set(`${x.toPrecision(8)}:${y.toPrecision(8)}`, [x, y]);
  }
  return [...unique.values()].sort(
    (left, right) => Math.atan2(left[1], left[0]) - Math.atan2(right[1], right[0])
  );
}

function maximumAngularGap(perimeter: Array<[number, number]>): number {
  expect(perimeter.length).toBeGreaterThan(2);
  const angles = perimeter.map(([x, y]) => Math.atan2(y, x));
  let maximum = 0;
  for (let index = 0; index < angles.length; index += 1) {
    const current = angles[index]!;
    const next = index + 1 < angles.length ? angles[index + 1]! : angles[0]! + Math.PI * 2;
    maximum = Math.max(maximum, next - current);
  }
  return maximum;
}

function projectedChordError(maxAngularGap: number, projectedRadiusPx: number): number {
  return projectedRadiusPx * (1 - Math.cos(maxAngularGap / 2));
}

function expectOutlineVerticesOnSurface(
  outline: THREE.BufferGeometry,
  surface: THREE.BufferGeometry
): void {
  const surfacePositions = surface.getAttribute("position");
  const surfaceVertices = new Set<string>();
  for (let index = 0; index < surfacePositions.count; index += 1) {
    surfaceVertices.add(positionKey(surfacePositions, index));
  }
  const outlinePositions = outline.getAttribute("position");
  for (let index = 0; index < outlinePositions.count; index += 1) {
    expect(surfaceVertices.has(positionKey(outlinePositions, index))).toBe(true);
  }
}

function positionKey(
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number
): string {
  return [
    positions.getX(index).toPrecision(8),
    positions.getY(index).toPrecision(8),
    positions.getZ(index).toPrecision(8)
  ].join(":");
}

function expectSmoothCylinderNormals(mesh: OcctMesh, diameter: number): void {
  const positions = mesh.attributes?.position?.array ?? [];
  const normals = mesh.attributes?.normal?.array ?? [];
  const radius = diameter / 2;
  let checked = 0;
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const x = positions[offset]!;
    const y = positions[offset + 1]!;
    const nx = normals[offset]!;
    const ny = normals[offset + 1]!;
    const nz = normals[offset + 2]!;
    if (Math.abs(Math.hypot(x, y) - radius) > diameter * 1e-4 || Math.abs(nz) > 0.1) continue;
    const radialLength = Math.hypot(x, y);
    const normalLength = Math.hypot(nx, ny, nz);
    const alignment = (x * nx + y * ny) / (radialLength * normalLength);
    expect(alignment).toBeGreaterThan(0.999);
    checked += 1;
  }
  expect(checked).toBeGreaterThan(100);
}
