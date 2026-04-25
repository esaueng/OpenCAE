import { describe, expect, test } from "vitest";
import { starterMaterials } from "./index";

describe("starterMaterials", () => {
  test("includes common engineering and 3D printed material options", () => {
    expect(starterMaterials.map((material) => material.id)).toEqual(
      expect.arrayContaining(["mat-petg", "mat-asa", "mat-nylon-cf", "mat-peek", "mat-sla-tough-resin"])
    );
  });

  test("marks printable materials with default print parameters", () => {
    const petg = starterMaterials.find((material) => material.id === "mat-petg");

    expect(petg?.printProfile).toMatchObject({
      process: "FDM",
      defaultInfillDensity: 40,
      defaultWallCount: 3
    });
  });

  test("reduces effective printed material properties when infill is sparse", async () => {
    const { effectiveMaterialProperties } = await import("./index");
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const printed = effectiveMaterialProperties(petg!, { printed: true, infillDensity: 35, wallCount: 3, layerOrientation: "z" });

    expect(printed.youngsModulus).toBeLessThan(petg!.youngsModulus);
    expect(printed.yieldStrength).toBeLessThan(petg!.yieldStrength);
    expect(printed.density).toBeLessThan(petg!.density);
  });
});
