import { describe, expect, test } from "vitest";
import {
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  assembleNodalLoadVector,
  connectedComponents,
  elementNodeCount,
  normalizeModelJson,
  solverSurfaceMeshFromModel,
  validateCoreResult,
  validateModelJson
} from "../src";
import { createSingleTetModel } from "./fixtures";

describe("@opencae/core public API", () => {
  test("exports schema constants and core utilities", () => {
    expect(OPENCAE_MODEL_SCHEMA).toBe("opencae.model");
    expect(OPENCAE_MODEL_SCHEMA_VERSION).toBe("0.2.0");
    expect(typeof validateModelJson).toBe("function");
    expect(typeof normalizeModelJson).toBe("function");
    expect(typeof elementNodeCount).toBe("function");
    expect(typeof connectedComponents).toBe("function");
    expect(typeof assembleNodalLoadVector).toBe("function");
    expect(typeof solverSurfaceMeshFromModel).toBe("function");
    expect(typeof validateCoreResult).toBe("function");
  });

  test("normalizes a v0.1 model and exposes a solver surface mesh", () => {
    const normalized = normalizeModelJson(createSingleTetModel());

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.model.schemaVersion).toBe("0.2.0");
    expect(solverSurfaceMeshFromModel(normalized.model).triangles.length).toBe(4);
  });
});
