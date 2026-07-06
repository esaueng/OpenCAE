// Spike test 1 (plan A-M1): can @loumalouomega/gmsh-wasm mesh the procedural
// bracket .geo (the exact script the cloud runner feeds native gmsh) fully
// in-process, and does the mirrored parser accept the result?
import { connectedComponents } from "@opencae/core";
import { describe, expect, it } from "vitest";
import { bracketGeoScript, bracketGeometrySourceMetadata } from "./bracketGeo";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import { meshGeoScriptToMshV2 } from "./wasmMesher";
import type { CoreVolumeMeshArtifact } from "./types";

describe("gmsh-wasm bracket .geo spike", () => {
  it("meshes the cloud bracket .geo to a valid Tet10 CoreVolumeMeshArtifact", { timeout: 180_000 }, async () => {
    const geo = bracketGeoScript();
    const started = Date.now();
    const meshed = await meshGeoScriptToMshV2(geo, { elementOrder: 2 });
    const wallMs = Date.now() - started;

    const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
      units: "mm",
      sourceSelectionRefs: bracketGeometrySourceMetadata(),
      diagnostics: ["gmsh-wasm spike bracket"]
    });

    // Loud spike evidence — this is the deliverable.
    console.log(
      `[SPIKE bracket.geo] nodes=${artifact.metadata.nodeCount} elements=${artifact.metadata.elementCount} ` +
        `tet10=${artifact.elements.filter((e) => e.type === "Tet10").length} ` +
        `surfaceFacets=${artifact.metadata.surfaceFacetCount} components=${artifact.metadata.connectedComponentCount} ` +
        `inverted=${artifact.metadata.meshQuality.invertedElementCount} wallMs=${wallMs} ` +
        `phases=${JSON.stringify(meshed.timings)}`
    );

    // >0 Tet10 elements, and nothing but Tet10 after setOrder(2).
    expect(artifact.elements.length).toBeGreaterThan(0);
    expect(artifact.elements.every((element) => element.type === "Tet10")).toBe(true);

    // Zero inverted elements.
    expect(artifact.metadata.meshQuality.invertedElementCount).toBe(0);
    expect(artifact.metadata.meshQuality.minTetVolume).toBeGreaterThan(0);

    // Single connected component — both by the parser's own count and by the
    // @opencae/core topology helper.
    expect(artifact.metadata.connectedComponentCount).toBe(1);
    expect(coreConnectedComponentCount(artifact)).toBe(1);

    // Node/element counts in a sane range for the 18 mm default bracket mesh.
    expect(artifact.metadata.nodeCount).toBeGreaterThan(300);
    expect(artifact.metadata.nodeCount).toBeLessThan(200_000);
    expect(artifact.metadata.elementCount).toBeGreaterThan(100);
    expect(artifact.metadata.elementCount).toBeLessThan(100_000);

    // The bracket has no curved faces, so summed corner-tet volumes must match
    // the analytic solid volume: base + upright + triangular gusset (mm -> m).
    const expectedVolumeM3 = (120 * 34 * 10 + 18 * 34 * (88 - 10) + (72 * 58 / 2) * 34) * 1e-9;
    expect(meshVolumeM3(artifact)).toBeGreaterThan(expectedVolumeM3 * 0.98);
    expect(meshVolumeM3(artifact)).toBeLessThan(expectedVolumeM3 * 1.02);

    // Named physical surfaces survive the round trip (the load/BC contract).
    const surfaceSetNames = artifact.surfaceSets.map((set) => set.name);
    expect(surfaceSetNames).toContain("fixed_support");
    expect(surfaceSetNames).toContain("load_surface");
    const fixedSet = artifact.surfaceSets.find((set) => set.name === "fixed_support");
    expect(fixedSet && fixedSet.facets.length).toBeGreaterThan(0);
  });
});

function coreConnectedComponentCount(artifact: CoreVolumeMeshArtifact): number {
  return connectedComponents({
    nodes: { coordinates: artifact.nodes.coordinates },
    elementBlocks: [
      {
        name: "solid",
        type: "Tet10",
        material: "solid",
        connectivity: artifact.elements.flatMap((element) => element.connectivity)
      }
    ]
  }).componentCount;
}

function meshVolumeM3(artifact: CoreVolumeMeshArtifact): number {
  const coordinates = artifact.nodes.coordinates;
  let volume = 0;
  for (const element of artifact.elements) {
    const [a, b, c, d] = element.connectivity;
    volume += signedTetVolume(coordinates, a!, b!, c!, d!);
  }
  return volume;
}

function signedTetVolume(coordinates: number[], a: number, b: number, c: number, d: number): number {
  const ax = coordinates[a * 3]!, ay = coordinates[a * 3 + 1]!, az = coordinates[a * 3 + 2]!;
  const bx = coordinates[b * 3]! - ax, by = coordinates[b * 3 + 1]! - ay, bz = coordinates[b * 3 + 2]! - az;
  const cx = coordinates[c * 3]! - ax, cy = coordinates[c * 3 + 1]! - ay, cz = coordinates[c * 3 + 2]! - az;
  const dx = coordinates[d * 3]! - ax, dy = coordinates[d * 3 + 1]! - ay, dz = coordinates[d * 3 + 2]! - az;
  return (bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)) / 6;
}
