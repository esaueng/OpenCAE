import { describe, expect, test } from "vitest";
import { validateStudy } from "@opencae/study-core";
import type { Study } from "@opencae/schema";
import { readinessForStudy } from "./runReadiness";

const readyStaticStudy: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Fixture body" }],
  materialAssignments: [{ id: "assign-1", materialId: "mat-steel", selectionRef: "selection-body", status: "complete" }],
  namedSelections: [
    { id: "selection-face", name: "Top face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-top", label: "Top face" }], fingerprint: "face-top" },
    { id: "selection-fixed", name: "Base face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-base", label: "Base face" }], fingerprint: "face-base" }
  ],
  contacts: [],
  constraints: [{ id: "support-1", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
  loads: [{
    id: "load-1",
    type: "force",
    selectionRef: "selection-face",
    parameters: { value: 500, units: "N", direction: [0, -1, 0] },
    status: "complete"
  }],
  meshSettings: { preset: "medium", status: "complete" },
  solverSettings: {},
  validation: [],
  runs: []
};

function itemFor(study: Study | null, label: string) {
  return readinessForStudy(study).find((item) => item.label === label);
}

describe("run readiness", () => {
  test("a fully configured study is ready to run", () => {
    const readiness = readinessForStudy(readyStaticStudy);
    expect(readiness.every((item) => item.done)).toBe(true);
    expect(readiness.map((item) => item.label)).toEqual(["Material assigned", "Support added", "Load added", "Mesh generated"]);
  });

  test("a negative load magnitude keeps the run gate closed", () => {
    // The reported defect: readiness checked that a load *existed*, so a -1 N
    // load read as "Load added" and Run started, only for the solver to refuse
    // it. The validator always knew better; nothing asked it.
    const study: Study = { ...readyStaticStudy, loads: [{ ...readyStaticStudy.loads[0]!, parameters: { ...readyStaticStudy.loads[0]!.parameters, value: -1 } }] };
    const load = itemFor(study, "Load added");
    expect(load?.done).toBe(false);
    expect(load?.blockers.join(" ")).toContain("positive finite magnitude");
  });

  test("a zero or non-finite load magnitude keeps the run gate closed", () => {
    for (const value of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const study: Study = { ...readyStaticStudy, loads: [{ ...readyStaticStudy.loads[0]!, parameters: { ...readyStaticStudy.loads[0]!.parameters, value } }] };
      expect(itemFor(study, "Load added")?.done).toBe(false);
    }
  });

  test("nothing is ready without an open study", () => {
    expect(readinessForStudy(null).every((item) => item.done)).toBe(false);
  });

  test("every validator diagnostic reaches a readiness row", () => {
    // A rule the grouping does not recognize must still block the run. If this
    // fails, a new diagnostic was added without a home and the gate would let
    // through exactly what it was written to catch.
    const brokenStudy: Study = {
      ...readyStaticStudy,
      materialAssignments: [],
      constraints: [],
      loads: [],
      meshSettings: { preset: "medium", status: "not_started" }
    };
    const readiness = readinessForStudy(brokenStudy);
    const reported = readiness.flatMap((item) => item.blockers);
    for (const diagnostic of validateStudy(brokenStudy)) {
      expect(reported).toContain(diagnostic.message);
    }
    expect(readiness.some((item) => item.label === "Study valid")).toBe(false);
  });

  test("modal analysis has no load row and gates on mode count", () => {
    const modalStudy = {
      ...readyStaticStudy,
      type: "modal_analysis",
      loads: [],
      solverSettings: { modeCount: 42 }
    } as unknown as Study;
    const readiness = readinessForStudy(modalStudy);
    expect(readiness.some((item) => item.label === "Load added")).toBe(false);
    expect(readiness.find((item) => item.label === "Run settings valid")?.done).toBe(false);
  });

  test("a dynamic study with free motion needs no support, but still needs a valid time range", () => {
    const base = {
      ...readyStaticStudy,
      type: "dynamic_structural",
      constraints: [],
      solverSettings: { allowFreeMotion: true, startTime: 0, endTime: 0.1, timeStep: 0.005, outputInterval: 0.01, dampingRatio: 0 }
    } as unknown as Study;
    expect(readinessForStudy(base).find((item) => item.label === "Support added")?.done).toBe(true);

    const badTimeRange = { ...base, solverSettings: { ...(base.solverSettings as object), endTime: -1 } } as unknown as Study;
    expect(readinessForStudy(badTimeRange).find((item) => item.label === "Run settings valid")?.done).toBe(false);
  });

  test("a thermal study needs a prescribed temperature and accepts signed heat flux", () => {
    // Negative inward surface flux is cooling, not an error — routing thermal
    // studies through the structural validator would have refused it.
    const thermalStudy = {
      ...readyStaticStudy,
      type: "steady_state_thermal",
      constraints: [{ id: "support-1", type: "prescribed_temperature", selectionRef: "selection-fixed", parameters: { value: 20 }, status: "complete" }],
      loads: [{ id: "load-1", type: "heat_flux", selectionRef: "selection-face", parameters: { value: -500, units: "W/m²" }, status: "complete" }]
    } as unknown as Study;
    expect(readinessForStudy(thermalStudy).every((item) => item.done)).toBe(true);

    const noPrescribedTemperature = { ...thermalStudy, constraints: [] } as unknown as Study;
    expect(readinessForStudy(noPrescribedTemperature).find((item) => item.label === "Support added")?.done).toBe(false);

    const zeroFlux = { ...thermalStudy, loads: [{ ...(thermalStudy.loads[0] as object), parameters: { value: 0, units: "W/m²" } }] } as unknown as Study;
    expect(readinessForStudy(zeroFlux).find((item) => item.label === "Load added")?.done).toBe(false);
  });
});
