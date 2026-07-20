import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import {
  boundedStructuralMaxDofs,
  DEFAULT_STRUCTURAL_MAX_DOFS,
  structuralDofCount,
  structuralDofLimitError
} from "../src";

describe("structural DOF limits", () => {
  test("owns one 150k product ceiling that callers may only lower", () => {
    expect(DEFAULT_STRUCTURAL_MAX_DOFS).toBe(150_000);
    expect(boundedStructuralMaxDofs(undefined)).toBe(150_000);
    expect(boundedStructuralMaxDofs(250_000)).toBe(150_000);
    expect(boundedStructuralMaxDofs(12_345.9)).toBe(12_345);
  });

  test("counts three translation DOFs per structural node", () => {
    expect(structuralDofCount(singleTetStaticFixture)).toBe(12);
  });

  test("returns the shared typed error only when the cap is exceeded", () => {
    expect(structuralDofLimitError(12, 12)).toBeUndefined();
    expect(structuralDofLimitError(12, 3)).toEqual({
      code: "max-dofs-exceeded",
      message: "Model has 12 DOFs, which exceeds maxDofs 3."
    });
  });
});
