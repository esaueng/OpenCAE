import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { singleTetStaticFixture } from "@opencae/examples";
import { validateCoreResult, type OpenCAEModelJson } from "@opencae/core";
import {
  SOLVER_CPU_VERSION,
  solveCoreDynamic,
  solveCorePreviewDynamic,
  solveCoreStatic,
  solvePreviewSdofTet4Cpu,
  solveStaticLinearTet,
  solveStaticLinearTetSparse
} from "../src";

const repoRoot = resolve(import.meta.dirname, "../../..");

const densityModel = {
  ...singleTetStaticFixture,
  schemaVersion: "0.2.0",
  materials: [
    {
      ...singleTetStaticFixture.materials[0],
      density: 1200,
      yieldStrength: 250e6
    }
  ],
  steps: [
    {
      name: "dynamicStep",
      type: "dynamicLinear",
      boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
      loads: ["tipLoad"],
      startTime: 0,
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01,
      loadProfile: "ramp"
    }
  ]
} satisfies OpenCAEModelJson;

describe("public Core solver APIs", () => {
  test("exports stable static solver entrypoints", () => {
    expect(typeof solveStaticLinearTet).toBe("function");
    expect(typeof solveStaticLinearTetSparse).toBe("function");
    expect(typeof solveCoreStatic).toBe("function");
  });

  test("exports the solver CPU version from the package entrypoint", () => {
    expect(SOLVER_CPU_VERSION).toBe("0.1.5");
  });

  test("solveCoreStatic returns a validated CoreSolveResult", () => {
    const result = solveCoreStatic(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.provenance.resultSource).toBe("computed");
    expect(result.result.provenance.solver).toBe("opencae-core-sparse-tet");
    expect(result.result.provenance.kind).toBe("opencae_core_fea");
    expect(result.diagnostics.solverMode).toBe("sparse");
    expect(result.result.summary.maxStressUnits).toBe("MPa");
    expect(result.result.summary.maxDisplacementUnits).toBe("mm");
    expect(result.result.provenance.units).toBe("mm-N-s-MPa");
    expect(result.result.fields.map((field) => field.type)).toEqual(expect.arrayContaining(["displacement", "stress"]));
    const surfaceStress = result.result.fields.find((field) => field.id === "stress-surface");
    const principalMax = result.result.fields.find((field) => field.component === "principal_max");
    const principalMin = result.result.fields.find((field) => field.component === "principal_min");
    const maxShear = result.result.fields.find((field) => field.component === "max_shear");
    const surfaceDisplacement = result.result.fields.find((field) => field.id === "displacement-surface");
    const engineeringStress = result.result.fields.find((field) => field.id === "stress-von-mises-element");
    expect(surfaceStress?.location).toBe("node");
    expect(surfaceStress?.units).toBe("MPa");
    expect(surfaceStress?.surfaceMeshRef).toBe(result.result.surfaceMesh?.id);
    expect(surfaceStress?.visualizationSource).toBe("volume_weighted_nodal_recovery");
    expect(surfaceStress?.engineeringSource).toBe("raw_element_von_mises");
    expect(surfaceStress?.component).toBe("von_mises");
    expect(surfaceStress?.values).toHaveLength(result.result.surfaceMesh?.nodes.length ?? -1);
    expect(principalMax?.values).toHaveLength(result.result.surfaceMesh?.nodes.length ?? -1);
    expect(principalMin?.values).toHaveLength(result.result.surfaceMesh?.nodes.length ?? -1);
    expect(maxShear?.values).toHaveLength(result.result.surfaceMesh?.nodes.length ?? -1);
    expect(surfaceDisplacement?.location).toBe("node");
    expect(surfaceDisplacement?.units).toBe("mm");
    expect(surfaceDisplacement?.values).toHaveLength(result.result.surfaceMesh?.nodes.length ?? -1);
    expect(surfaceDisplacement?.vectors).toHaveLength(result.result.surfaceMesh?.nodes.length ?? -1);
    expect(engineeringStress?.location).toBe("element");
    expect(engineeringStress?.surfaceMeshRef).toBeUndefined();
    expect(result.result.summary.maxStress).toBe(engineeringStress?.max);
    expect(JSON.stringify(result.result)).not.toContain("local_estimate");
    expect(JSON.stringify(result.result)).not.toContain("computed_preview");
    expect(validateCoreResult(result.result).ok).toBe(true);
  });

  test("solveCoreDynamic returns MDOF CoreSolveResult and never preview by default", () => {
    const result = solveCoreDynamic(densityModel);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.provenance.resultSource).toBe("computed");
    expect(result.result.provenance.kind).toBe("opencae_core_fea");
    expect(result.result.provenance.solver).toBe("opencae-core-mdof-tet");
    expect(result.diagnostics.solver).toBe("opencae-core-mdof-newmark");
    expect(result.result.summary.transient?.frameCount).toBeGreaterThan(1);
    expect(JSON.stringify(result.result)).not.toContain("local_estimate");
    expect(JSON.stringify(result.result)).not.toContain("computed_preview");
    expect(validateCoreResult(result.result).ok).toBe(true);
  });

  test("production APIs reject display proxy mesh sources without estimate fallback", () => {
    const proxyModel: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      meshProvenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "display_bounds_proxy"
      }
    };

    const result = solveCoreStatic(proxyModel);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.message).toBe(
      "OpenCAE Core requires an actual volume mesh for this solve. No estimate fallback was used."
    );
  });

  test("production APIs reject preview or local-estimate provenance inputs", () => {
    const previewModel: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      meshProvenance: {
        kind: "local_estimate",
        solver: "opencae-core-preview-sdof",
        resultSource: "computed_preview",
        meshSource: "structured_block_core"
      }
    };

    const result = solveCoreStatic(previewModel);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("preview-provenance-not-allowed");
  });

  test("production dynamic API requires dynamicLinear steps", () => {
    const result = solveCoreDynamic({
      ...densityModel,
      steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: ["fixedSupport"], loads: ["tipLoad"] }]
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("invalid-dynamic-step");
  });

  test("production dynamic solve fails instead of silently falling back to preview", () => {
    const noDensityDynamic: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      steps: densityModel.steps
    };

    const result = solveCoreDynamic(noDensityDynamic);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.message).toContain("Dynamic solve requires material density.");
  });

  test("preview dynamic solver requires explicit preview call", () => {
    const preview = solveCorePreviewDynamic(singleTetStaticFixture, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });
    const directPreview = solvePreviewSdofTet4Cpu(singleTetStaticFixture, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(preview.ok).toBe(true);
    expect(directPreview.ok).toBe(true);
    if (!preview.ok || !directPreview.ok) return;
    expect(preview.result.provenance?.resultSource).toBe("computed_preview");
    expect(preview.diagnostics.solver).toBe("opencae-core-preview-sdof");
    expect(directPreview.diagnostics.solver).toBe("opencae-core-preview-sdof");
  });

  test("production packages contain no CalculiX execution path", () => {
    const offenders = sourceFiles(repoRoot)
      .filter((file) => /(?:packages\/[^/]+\/src|services\/[^/]+\/src)\//.test(file))
      .filter((file) => /(?:CalculiX|\bccx\b|\.frd\b|\.inp\b|\.dat\b)/.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const path = resolve(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
