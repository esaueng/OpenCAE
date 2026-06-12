/**
 * Round-trip validation through Open CASCADE (occt-import-js), the same STEP
 * reader the OpenCAE viewer uses. Importing each generated part and checking
 * the tessellated volume against the exact analytic volume proves the files
 * are watertight, outward-oriented analytic B-rep solids — the property that
 * makes them open smooth and dimension-editable in CAD packages.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildParametricPartStep, defaultPartParameters, type ParametricPartId } from "./parts";

interface OcctMeshLike {
  name?: string;
  attributes: { position: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> };
}

interface OcctReaderLike {
  ReadStepFile(content: Uint8Array, params: null): { success: boolean; meshes?: OcctMeshLike[] };
}

let occt: OcctReaderLike;

beforeAll(async () => {
  const module = (await import("occt-import-js")) as unknown as { default?: () => Promise<OcctReaderLike> } & (() => Promise<OcctReaderLike>);
  const factory = module.default ?? module;
  occt = await factory();
}, 60_000);

function importPart(partId: ParametricPartId, values?: Record<string, number>) {
  const { stepText, bodyCount } = buildParametricPartStep(partId, values ?? defaultPartParameters(partId), {
    createdAt: new Date("2026-06-12T00:00:00Z")
  });
  const result = occt.ReadStepFile(new TextEncoder().encode(stepText), null);
  expect(result.success, `OCCT failed to import ${partId}`).toBe(true);
  expect(result.meshes ?? []).toHaveLength(bodyCount);
  return (result.meshes ?? []).map((mesh) => ({ name: mesh.name ?? "", ...meshStats(mesh) }));
}

interface MeshStats {
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** Signed volume of the triangle mesh; positive only for closed, outward-oriented shells. */
function meshStats(mesh: OcctMeshLike): MeshStats {
  const positions = mesh.attributes.position.array;
  const indices = mesh.index?.array;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[offset + axis]);
      max[axis] = Math.max(max[axis], positions[offset + axis]);
    }
  }
  const vertex = (index: number): [number, number, number] => [positions[3 * index], positions[3 * index + 1], positions[3 * index + 2]];
  const triangleCount = indices ? indices.length / 3 : positions.length / 9;
  let volume = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const [a, b, c] = indices
      ? [indices[3 * triangle], indices[3 * triangle + 1], indices[3 * triangle + 2]]
      : [3 * triangle, 3 * triangle + 1, 3 * triangle + 2];
    const [pa, pb, pc] = [vertex(a), vertex(b), vertex(c)];
    volume +=
      (pa[0] * (pb[1] * pc[2] - pc[1] * pb[2]) -
        pb[0] * (pa[1] * pc[2] - pc[1] * pa[2]) +
        pc[0] * (pa[1] * pb[2] - pb[1] * pa[2])) /
      6;
  }
  return { volume, min, max };
}

function expectClose(actual: number, expected: number, relativeTolerance: number, label: string) {
  const error = Math.abs(actual - expected) / Math.abs(expected);
  expect(error, `${label}: expected ${expected}, got ${actual} (relative error ${(error * 100).toFixed(2)}%)`).toBeLessThan(relativeTolerance);
}

describe("generated STEP files round-trip through Open CASCADE", () => {
  it("imports the cylinder as a watertight solid with the exact analytic volume", () => {
    const [cylinder] = importPart("cylinder", { diameter: 34, height: 36 });
    expectClose(cylinder.volume, Math.PI * 17 ** 2 * 36, 0.01, "cylinder volume");
    expect(cylinder.min[2]).toBeCloseTo(0, 1);
    expect(cylinder.max[2]).toBeCloseTo(36, 1);
    expect(cylinder.max[0]).toBeCloseTo(17, 1);
  });

  it("imports the ring as a single smooth torus with the exact analytic volume", () => {
    const [ring] = importPart("ring", { ringOuterDiameter: 64, ringTubeDiameter: 16 });
    // Torus volume 2*pi^2*R*r^2 with R = (64-16)/2 = 24 and r = 8.
    expectClose(ring.volume, 2 * Math.PI ** 2 * 24 * 8 ** 2, 0.01, "ring volume");
    expect(ring.min[2]).toBeCloseTo(0, 1);
    expect(ring.max[2]).toBeCloseTo(16, 1);
    expect(ring.max[0]).toBeCloseTo(32, 1);
  });

  it("imports the coat hook as two overlapping analytic bodies", () => {
    const meshes = importPart("coat-hook");
    // occt-import-js does not surface MANIFOLD_SOLID_BREP names, so identify
    // the bodies by their footprint: the ring is the wider of the two.
    const sorted = [...meshes].sort((a, b) => b.max[0] - a.max[0]);
    const [ring, boss] = sorted;
    expectClose(ring.volume, 2 * Math.PI ** 2 * 24 * 8 ** 2, 0.01, "ring volume");
    expectClose(boss.volume, Math.PI * 17 ** 2 * 36, 0.01, "boss volume");
    // The default boss (diameter 34) overlaps the ring's 32 mm centre hole.
    expect(boss.max[0]).toBeGreaterThan(24 - 8);
    expect(boss.max[2]).toBeGreaterThan(ring.max[2]);
  });

  it("imports the plate with the exact box volume", () => {
    const [plate] = importPart("plate", { width: 120, depth: 80, thickness: 8 });
    expectClose(plate.volume, 120 * 80 * 8, 0.001, "plate volume");
    expect(plate.min).toEqual([-60, -40, 0]);
    expect(plate.max).toEqual([60, 40, 8]);
  });

  it("imports custom dimensions, allowing diameters to be tuned per print", () => {
    const [cylinder] = importPart("cylinder", { diameter: 20, height: 50 });
    expectClose(cylinder.volume, Math.PI * 10 ** 2 * 50, 0.01, "custom cylinder volume");
    expect(cylinder.max[0]).toBeCloseTo(10, 1);
  });
});
