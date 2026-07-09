// Tet10 elevation rescue (July 2026): gmsh's default curved second-order
// elevation snaps mid-side nodes onto the CAD surface, which inverts elements
// on thin bent shells (a 3 mm tablet-stand-like part measures minSICN -0.29
// curved vs +0.31 straight at the 12 mm medium preset). meshStepSession must
// detect the collapse and re-elevate with straight edges instead of letting
// the quality gate reject the model outright.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { meshStepToMshV2 } from "./wasmMesher";
import { generateBentShellStandStep } from "./stepFixtures";
import { MESH_QUALITY_REJECT_MIN_SICN } from "./meshQualityGate";

const MEDIUM_PRESET_MM = 12;

describe("STEP Tet10 elevation rescue", () => {
  test("bent thin shell re-elevates with straight edges and passes the quality floor", async () => {
    const step = await generateBentShellStandStep();
    const meshed = await meshStepToMshV2(new TextEncoder().encode(step), {
      elementOrder: 2,
      meshSizeMm: MEDIUM_PRESET_MM
    });

    expect(meshed.elevation).toBe("straight_edge");
    expect(meshed.qualityMinSICN).toBeDefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
    // Still a quadratic mesh: msh2 element type 11 = Tet10.
    expect(/^\d+ 11 /m.test(meshed.msh)).toBe(true);
  }, 120_000);

  test("geometry that elevates cleanly keeps gmsh's curved elevation", async () => {
    const stepText = readFileSync(new URL("../fixtures/box-with-bore.step", import.meta.url), "utf8");
    const meshed = await meshStepToMshV2(new TextEncoder().encode(stepText), { elementOrder: 2 });

    expect(meshed.elevation).toBe("curved");
    expect(meshed.qualityMinSICN).toBeDefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
  }, 120_000);

  test("linear meshes carry no elevation marker", async () => {
    const stepText = readFileSync(new URL("../fixtures/box-with-bore.step", import.meta.url), "utf8");
    const meshed = await meshStepToMshV2(new TextEncoder().encode(stepText), { elementOrder: 1 });

    expect(meshed.elevation).toBeUndefined();
  }, 120_000);
});
