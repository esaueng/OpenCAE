import { describe, expect, test } from "vitest";
import {
  assertCompatibleManufacturingProcess,
  compatibleManufacturingProcessesFor,
  defaultManufacturingProcessIdFor,
  effectiveMaterialProperties,
  fdmPropertyFactorsFor,
  isManufacturingProcessCompatible,
  massKgForPayloadMaterial,
  materialCatalog,
  materialManufacturingProfilesFor,
  normalizeManufacturingParameters,
  payloadMaterials,
  resolveMaterial,
  starterMaterials
} from "./index";

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

  test("offers CNC machining, injection molding, and FDM for ABS, but not SLA", () => {
    const abs = starterMaterials.find((material) => material.id === "mat-abs");
    expect(abs).toBeDefined();

    expect(compatibleManufacturingProcessesFor(abs!).map((process) => process.id)).toEqual([
      "cnc_machining",
      "injection_molding",
      "fdm"
    ]);
    expect(isManufacturingProcessCompatible(abs!, "sla")).toBe(false);
  });

  test("offers SLA as the only compatible process for photopolymer resin", () => {
    const resin = starterMaterials.find((material) => material.id === "mat-sla-tough-resin");
    expect(resin).toBeDefined();

    expect(compatibleManufacturingProcessesFor(resin!).map((process) => process.id)).toEqual(["sla"]);
  });

  test("rejects an incompatible explicit material and process pair with a useful error", () => {
    expect(() => assertCompatibleManufacturingProcess("mat-abs", "sla")).toThrow(
      /SLA printing.*not compatible with ABS/i
    );
  });

  test("resolves project custom materials without changing the built-in catalog", () => {
    const custom = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };

    expect(resolveMaterial(custom.id, [custom])).toBe(custom);
    expect(materialCatalog([custom]).at(-1)).toBe(custom);
    expect(() => resolveMaterial("missing-material", [custom])).toThrow('Unknown material "missing-material".');
  });

  test("defaults custom bulk materials to an unvalidated CNC profile and preserves copied additive profiles", () => {
    const customBulk = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6
    };
    const customPrinted = {
      ...customBulk,
      id: "16a41211-8a49-40e4-a667-60acc6a2ecc8",
      printProfile: starterMaterials.find((material) => material.id === "mat-petg")!.printProfile
    };

    expect(materialManufacturingProfilesFor(customBulk).map((profile) => profile.processId)).toEqual(["cnc_machining"]);
    expect(materialManufacturingProfilesFor(customPrinted).map((profile) => profile.processId)).toEqual(["cnc_machining", "fdm"]);
  });

  test("keeps solid CNC properties unchanged even when stale print settings are present", () => {
    const abs = starterMaterials.find((material) => material.id === "mat-abs");
    expect(abs).toBeDefined();

    const machined = effectiveMaterialProperties(abs!, {
      manufacturingProcessId: "cnc_machining",
      printed: true,
      infillDensity: 10,
      wallCount: 1,
      layerOrientation: "x"
    });

    expect(machined).toEqual(abs);
  });

  test("reduces effective FDM properties when infill is sparse", () => {
    const abs = starterMaterials.find((material) => material.id === "mat-abs");
    expect(abs).toBeDefined();

    const printed = effectiveMaterialProperties(abs!, {
      manufacturingProcessId: "fdm",
      infillDensity: 35,
      wallCount: 3,
      layerOrientation: "z"
    });

    expect(printed.youngsModulus).toBeLessThan(abs!.youngsModulus);
    expect(printed.yieldStrength).toBeLessThan(abs!.yieldStrength);
    expect(printed.density).toBeLessThan(abs!.density);
  });

  test("ignores stale FDM infill and wall settings for SLA", () => {
    const resin = starterMaterials.find((material) => material.id === "mat-sla-tough-resin");
    expect(resin).toBeDefined();

    const printed = effectiveMaterialProperties(resin!, {
      manufacturingProcessId: "sla",
      printed: true,
      infillDensity: 5,
      wallCount: 12,
      layerOrientation: "x"
    });

    expect(printed).toEqual(resin);
  });

  test("maps legacy printed flags onto compatible manufacturing processes", () => {
    const abs = starterMaterials.find((material) => material.id === "mat-abs");
    expect(abs).toBeDefined();

    expect(defaultManufacturingProcessIdFor(abs!, { printed: true })).toBe("fdm");
    expect(defaultManufacturingProcessIdFor(abs!, { printed: false })).toBe("cnc_machining");
    expect(normalizeManufacturingParameters(abs!, { printed: true })).toMatchObject({
      manufacturingProcessId: "fdm",
      printed: true
    });
    expect(normalizeManufacturingParameters(abs!, { printed: false })).toMatchObject({
      manufacturingProcessId: "cnc_machining",
      printed: false
    });
  });

  test("reduces effective printed material properties when infill is sparse", () => {
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const printed = effectiveMaterialProperties(petg!, { printed: true, infillDensity: 35, wallCount: 3, layerOrientation: "z" });

    expect(printed.youngsModulus).toBeLessThan(petg!.youngsModulus);
    expect(printed.yieldStrength).toBeLessThan(petg!.yieldStrength);
    expect(printed.density).toBeLessThan(petg!.density);
  });

  test("uses the build axis as the weak direction only when it crosses the governing load path", () => {
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const parameters = { manufacturingProcessId: "fdm", infillDensity: 35, wallCount: 3 } as const;
    const xBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "x" }, { criticalLayerAxis: "x" });
    const yBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "y" }, { criticalLayerAxis: "x" });
    const zBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "z" }, { criticalLayerAxis: "x" });

    expect(xBuild.youngsModulus).toBeLessThan(yBuild.youngsModulus);
    expect(xBuild.yieldStrength).toBeLessThan(yBuild.yieldStrength);
    expect(yBuild.youngsModulus).toBe(zBuild.youngsModulus);
    expect(yBuild.yieldStrength).toBe(zBuild.yieldStrength);
    expect(xBuild.density).toBe(yBuild.density);
    expect(yBuild.density).toBe(zBuild.density);
  });

  test("has no intrinsic X, Y, or Z preference without a resolved load path", () => {
    const abs = starterMaterials.find((material) => material.id === "mat-abs")!;
    const parameters = { manufacturingProcessId: "fdm", infillDensity: 35, wallCount: 3 } as const;
    const results = (["x", "y", "z"] as const).map((layerOrientation) =>
      effectiveMaterialProperties(abs, { ...parameters, layerOrientation })
    );

    expect(new Set(results.map((material) => material.youngsModulus)).size).toBe(1);
    expect(new Set(results.map((material) => material.yieldStrength)).size).toBe(1);
    expect(fdmPropertyFactorsFor(abs, { ...parameters, layerOrientation: "x" })?.loadPathRelation).toBe("conservative");
  });

  test("increases density, stiffness, and strength monotonically with infill and walls", () => {
    const abs = starterMaterials.find((material) => material.id === "mat-abs")!;
    const context = { criticalLayerAxis: "x" as const };
    const sparse = effectiveMaterialProperties(abs, { manufacturingProcessId: "fdm", infillDensity: 20, wallCount: 1, layerOrientation: "x" }, context);
    const denser = effectiveMaterialProperties(abs, { manufacturingProcessId: "fdm", infillDensity: 60, wallCount: 1, layerOrientation: "x" }, context);
    const moreWalls = effectiveMaterialProperties(abs, { manufacturingProcessId: "fdm", infillDensity: 20, wallCount: 5, layerOrientation: "x" }, context);

    for (const property of ["density", "youngsModulus", "yieldStrength"] as const) {
      expect(denser[property]).toBeGreaterThan(sparse[property]);
      expect(moreWalls[property]).toBeGreaterThan(sparse[property]);
      expect(denser[property]).toBeLessThanOrEqual(abs[property]);
      expect(moreWalls[property]).toBeLessThanOrEqual(abs[property]);
    }
  });

  test("applies a severe interlayer penalty when the print direction is critical", () => {
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const parameters = { printed: true, infillDensity: 100, wallCount: 3 };
    const xCritical = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "x" }, { criticalLayerAxis: "x" });
    const yBuild = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "y" }, { criticalLayerAxis: "x" });
    const genericX = effectiveMaterialProperties(petg!, { ...parameters, layerOrientation: "x" });

    expect(xCritical.yieldStrength).toBeCloseTo(petg!.yieldStrength * 0.36);
    expect(xCritical.yieldStrength).toBeLessThan(yBuild.yieldStrength * 0.6);
    expect(xCritical.youngsModulus).toBeLessThan(yBuild.youngsModulus);
    expect(genericX.yieldStrength).toBe(xCritical.yieldStrength);
  });

  test("honors an explicit critical-layer strength override", () => {
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const xCritical = effectiveMaterialProperties(
      petg!,
      { manufacturingProcessId: "fdm", infillDensity: 100, wallCount: 3, layerOrientation: "x" },
      { criticalLayerAxis: "x", criticalLayerFactor: 0.5 }
    );

    expect(xCritical.yieldStrength).toBeCloseTo(petg!.yieldStrength * 0.5);
  });

  test("never lets a partial custom profile make interlayer response stronger than in-plane response", () => {
    const custom = {
      id: "custom-fdm",
      name: "Custom FDM",
      youngsModulus: 2_000_000_000,
      poissonRatio: 0.35,
      density: 1_000,
      yieldStrength: 40_000_000,
      printProfile: {
        process: "FDM" as const,
        inPlaneModulusFactor: 0.2,
        interlayerModulusFactor: 0.8,
        inPlaneStrengthFactor: 0.2,
        interlayerStrengthFactor: 0.8
      }
    };
    const parameters = { manufacturingProcessId: "fdm", infillDensity: 100, wallCount: 3, layerOrientation: "x" };
    const across = effectiveMaterialProperties(custom, parameters, { criticalLayerAxis: "x" });
    const within = effectiveMaterialProperties(custom, parameters, { criticalLayerAxis: "y" });

    expect(across.youngsModulus).toBeLessThanOrEqual(within.youngsModulus);
    expect(across.yieldStrength).toBeLessThanOrEqual(within.yieldStrength);
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
