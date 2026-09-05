import { describe, expect, test } from "vitest";
import { studyTypeSwitchConsequence } from "./studyTypeSwitch";

const constraint = { id: "c1" } as never;
const load = { id: "l1" } as never;

describe("studyTypeSwitchConsequence", () => {
  test("structural to thermal names the supports and loads it clears", () => {
    expect(studyTypeSwitchConsequence({ type: "static_stress", constraints: [constraint, constraint], loads: [load] }, "steady_state_thermal"))
      .toEqual({ supports: 2, loads: 1, message: "Switching to Thermal clears 2 supports and 1 load." });
  });

  test("thermal to structural calls the constraints thermal boundaries", () => {
    expect(studyTypeSwitchConsequence({ type: "steady_state_thermal", constraints: [constraint], loads: [] }, "static_stress")?.message)
      .toBe("Switching to Static clears 1 thermal boundary.");
  });

  test("switches among structural types lose nothing, so there is no warning", () => {
    const study = { type: "static_stress" as const, constraints: [constraint], loads: [load] };
    expect(studyTypeSwitchConsequence(study, "dynamic_structural")).toBeNull();
    expect(studyTypeSwitchConsequence(study, "modal_analysis")).toBeNull();
    expect(studyTypeSwitchConsequence(study, "static_stress")).toBeNull();
  });

  test("an empty setup has nothing to warn about", () => {
    expect(studyTypeSwitchConsequence({ type: "static_stress", constraints: [], loads: [] }, "steady_state_thermal")).toBeNull();
  });
});
