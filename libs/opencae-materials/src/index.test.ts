import { describe, expect, test } from "vitest";
import { massKgForPayloadMaterial, payloadMaterials, starterMaterials } from "./index";

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

  test("treats Z build direction as the strongest printed orientation", async () => {
    const { effectiveMaterialProperties } = await import("./index");
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const parameters = { printed: true, infillDensity: 35, wallCount: 3 };
    const zBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "z" });
    const xBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "x" });
    const yBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "y" });

    expect(zBuild.yieldStrength).toBeGreaterThan(xBuild.yieldStrength);
    expect(zBuild.yieldStrength).toBeGreaterThan(yBuild.yieldStrength);
    expect(xBuild.yieldStrength).toBe(yBuild.yieldStrength);
  });

  test("applies a severe interlayer penalty when the print direction is critical", async () => {
    const { effectiveMaterialProperties } = await import("./index");
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const parameters = { printed: true, infillDensity: 100, wallCount: 3 };
    const xCritical = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "x" }, { criticalLayerAxis: "x" });
    const yBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "y" }, { criticalLayerAxis: "x" });
    const genericX = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "x" });

    expect(xCritical.yieldStrength).toBeCloseTo(petg!.yieldStrength * 0.35);
    expect(xCritical.yieldStrength).toBeLessThan(yBuild.yieldStrength * 0.6);
    expect(genericX.yieldStrength).toBe(yBuild.yieldStrength);
  });
});

describe("payloadMaterials", () => {
  test("includes a broad dedicated payload material library", () => {
    expect(payloadMaterials.length).toBeGreaterThanOrEqual(50);
    expect(payloadMaterials.map((material) => material.id)).toEqual(
      expect.arrayContaining(["payload-steel", "payload-abs", "payload-silicon", "payload-glass", "payload-water"])
    );
    expect([...new Set(payloadMaterials.map((material) => material.category))]).toEqual(
      expect.arrayContaining(["metal", "plastic", "semiconductor", "ceramic-glass", "liquid", "wood"])
    );
  });

  test("calculates payload mass from density and volume", () => {
    expect(massKgForPayloadMaterial("payload-aluminum-6061", 0.002)).toBeCloseTo(5.4);
  });
});
