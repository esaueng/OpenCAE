// Regression guard for the nastiest gmsh-wasm 0.1.2 surprise found in the
// A-M1 spike: a SECOND gmsh session on the same WASM module instance aborts
// inside wasm (initialize -> finalize -> initialize crashes; clear()-based
// model reuse crashes too). The public mesh functions therefore instantiate a
// fresh module per call — this test proves back-to-back meshes survive, which
// is exactly what a long-lived mesh worker will do.
import { describe, expect, it } from "vitest";
import { bracketGeoScript } from "./bracketGeo";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import { meshGeoScriptToMshV2, meshStepToMshV2 } from "./wasmMesher";
import { readFileSync } from "node:fs";

describe("gmsh-wasm sequential sessions", () => {
  it("meshes twice in one process without crashing the wasm module", { timeout: 180_000 }, async () => {
    const geo = bracketGeoScript();
    const first = await meshGeoScriptToMshV2(geo, { elementOrder: 1 });
    const second = await meshStepToMshV2(
      readFileSync(new URL("../fixtures/box-with-bore.step", import.meta.url), "utf8"),
      { elementOrder: 1, meshSizeMm: 8 }
    );

    const firstArtifact = parseGmshMeshToCoreVolumeMesh(first.msh, { units: "mm" });
    const secondArtifact = parseGmshMeshToCoreVolumeMesh(second.msh, { units: "mm" });
    expect(firstArtifact.elements.length).toBeGreaterThan(0);
    expect(firstArtifact.elements.every((element) => element.type === "Tet4")).toBe(true);
    expect(secondArtifact.elements.length).toBeGreaterThan(0);
    expect(secondArtifact.elements.every((element) => element.type === "Tet4")).toBe(true);
  });
});
