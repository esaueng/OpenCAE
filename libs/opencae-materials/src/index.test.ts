import { describe, expect, test } from "vitest";
import {
  assertCompatibleManufacturingProcess,
  compatibleManufacturingProcessesFor,
  defaultManufacturingProcessIdFor,
  effectiveMaterialProperties,
  isManufacturingProcessCompatible,
  massKgForPayloadMaterial,
  normalizeManufacturingParameters,
  payloadMaterials,
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

  test("reduces effective printed material properties when infill is sparse", async () => {
    const petg = starterMaterials.find((material) => material.id === "mat-petg");
    expect(petg).toBeDefined();

    const printed = effectiveMaterialProperties(petg!, { printed: true, infillDensity: 35, wallCount: 3, layerOrientation: "z" });

    expect(printed.youngsModulus).toBeLessThan(petg!.youngsModulus);
    expect(printed.yieldStrength).toBeLessThan(petg!.yieldStrength);
    expect(printed.density).toBeLessThan(petg!.density);
  });

  test("treats Z build direction as the strongest printed orientation", () => {
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

  test("applies a severe interlayer penalty when the print direction is critical", () => {
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
