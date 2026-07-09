import { connectedComponents, validateModelJson } from "@opencae/core";
import { describe, expect, test } from "vitest";
import {
  bracketActualMeshFixture,
  invalidConnectivityFixture,
  singleTetStaticFixture,
  twoTetStaticFixture
} from "../src";

describe("Phase 1 fixtures", () => {
  test("single-tet-static is valid", () => {
    expect(validateModelJson(singleTetStaticFixture).ok).toBe(true);
  });

  test("two-tet-static is valid", () => {
    expect(validateModelJson(twoTetStaticFixture).ok).toBe(true);
  });

  test("invalid-connectivity is invalid", () => {
    const report = validateModelJson(invalidConnectivityFixture);

    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid-connectivity-length",
        "duplicate-tet-node",
        "node-index-out-of-range"
      ])
    );
  });

  test("bracket-actual-mesh is a valid connected v0.2 fixture with real surface sets", () => {
    const report = validateModelJson(bracketActualMeshFixture);
    const components = connectedComponents(bracketActualMeshFixture);

    expect(report.ok).toBe(true);
    expect(bracketActualMeshFixture.schemaVersion).toBe("0.2.0");
    expect(components.componentCount).toBe(1);
    expect(bracketActualMeshFixture.surfaceSets?.map((set) => set.name)).toEqual(
      expect.arrayContaining(["base_mount", "upright_load", "hole_wall", "gusset_skin"])
    );
  });
});
