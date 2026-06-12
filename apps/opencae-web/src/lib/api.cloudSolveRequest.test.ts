import { describe, expect, test } from "vitest";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/db/sample-data";
import type { Study } from "@opencae/schema";
import { cloudGeometrySourceForStudy } from "../workers/opencaeCoreSolve";
import { geometryWithMeshPreset, studyForCoreCloudGeometrySolve } from "./api";

const bracketStudy = bracketDemoProject.studies[0]! as Study;

describe("OpenCAE Core Cloud solve request preparation", () => {
  test("remaps stored sample load directions into the solver global frame", () => {
    const prepared = studyForCoreCloudGeometrySolve(bracketStudy, bracketDisplayModel);

    // Seeded "Global -Z" load is stored viewer-down [0, -1, 0]; the cloud
    // container meshes the bracket Z-up, so it must receive [0, 0, -1].
    expect(bracketStudy.loads[0]!.parameters.direction).toEqual([0, -1, 0]);
    expect(prepared.loads[0]!.parameters.direction).toEqual([0, 0, -1]);
  });

  test("does not mutate the source study", () => {
    const direction = bracketStudy.loads[0]!.parameters.direction;
    studyForCoreCloudGeometrySolve(bracketStudy, bracketDisplayModel);
    expect(bracketStudy.loads[0]!.parameters.direction).toBe(direction);
  });

  test("applies the study mesh preset to procedural cloud geometry", () => {
    const geometry = cloudGeometrySourceForStudy(bracketStudy, bracketDisplayModel);
    expect(geometry).not.toBeNull();

    const medium = geometryWithMeshPreset(geometry!, bracketStudy);
    expect((medium.descriptor as { meshSize?: number }).meshSize).toBe(12);

    const fineStudy = { ...bracketStudy, meshSettings: { ...bracketStudy.meshSettings, preset: "fine" as const } };
    const fine = geometryWithMeshPreset(geometry!, fineStudy);
    expect((fine.descriptor as { meshSize?: number }).meshSize).toBe(8);

    const coarseStudy = { ...bracketStudy, meshSettings: { ...bracketStudy.meshSettings, preset: "coarse" as const } };
    expect((geometryWithMeshPreset(geometry!, coarseStudy).descriptor as { meshSize?: number }).meshSize).toBe(18);
  });
});
