import { describe, expect, test } from "vitest";
import type { Constraint, Load } from "@opencae/schema";
import { nextLoadLabel, nextSupportLabel, supportDisplayLabel } from "./supportLabels";

const support = (id: string, type: Constraint["type"], label?: string): Constraint => ({ id, type, selectionRef: "face", parameters: label ? { label } : {}, status: "complete" });
const load = (id: string, label?: string): Load => ({ id, type: "force", selectionRef: "face", parameters: { value: 1, ...(label ? { label } : {}) }, status: "complete" });

describe("stable entry labels (2026-09 review F2)", () => {
  test("prefers the label stored at creation over the ordinal", () => {
    expect(supportDisplayLabel(support("a", "fixed", "FS 2"), 1)).toBe("FS 2");
    expect(supportDisplayLabel(support("a", "fixed"), 3)).toBe("FS 3");
    expect(supportDisplayLabel(support("a", "prescribed_temperature"), 1)).toBe("PD 1");
  });

  test("never reuses a label that is already on the study, even after deletions", () => {
    expect(nextSupportLabel([support("a", "fixed", "FS 1"), support("c", "fixed", "FS 3")], "fixed")).toBe("FS 4");
    expect(nextSupportLabel([support("a", "fixed")], "fixed")).toBe("FS 2");
    expect(nextSupportLabel([support("a", "fixed", "FS 1")], "prescribed_temperature")).toBe("PD 1");
    expect(nextLoadLabel([load("a", "L1"), load("b", "L5")])).toBe("L6");
    expect(nextLoadLabel([load("a")])).toBe("L2");
    expect(nextLoadLabel([])).toBe("L1");
  });
});
