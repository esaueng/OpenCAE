// Multi-body STEP conditioning (fuseImportedStepVolumes): a file exported as
// several touching or overlapping solids must mesh as ONE conformal part, not
// as per-volume tetrahedra the solver later rejects as disconnected
// components. Also pins the honest diagnosis for gmsh/TetGen's raw
// "PLC Error: A segment and a facet intersect" boundary-recovery failure.
import { describe, expect, it } from "vitest";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import { generateDisjointBarsStep, generateOverlappingTBarStep, generateTouchingTBarStep } from "./stepFixtures";
import { diagnoseStepMeshFailure, meshStepToMshV2, StepGeometryError } from "./wasmMesher";

describe("multi-body STEP fusion", () => {
  it("fuses two overlapping solids into one meshable part", { timeout: 300_000 }, async () => {
    const step = await generateOverlappingTBarStep();
    const result = await meshStepToMshV2(step, { elementOrder: 1, meshSizeMm: 8 });
    expect(result.multiBodyFusion).toEqual({ inputVolumeCount: 2, fusedVolumeCount: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.elements.length).toBeGreaterThan(0);
    expect(artifact.metadata.connectedComponentCount).toBe(1);
  });

  it("fuses two exactly-touching solids into one connected mesh", { timeout: 300_000 }, async () => {
    const step = await generateTouchingTBarStep();
    const result = await meshStepToMshV2(step, { elementOrder: 1, meshSizeMm: 8 });
    expect(result.multiBodyFusion).toEqual({ inputVolumeCount: 2, fusedVolumeCount: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(1);
  });

  it("honors an explicit pairwise fuse group while preserving part identity", { timeout: 300_000 }, async () => {
    const step = await generateTouchingTBarStep();
    const result = await meshStepToMshV2(step, {
      elementOrder: 1,
      meshSizeMm: 8,
      preservePartIdentity: true,
      fuseBodyGroups: [[
        { min: [0, -10, 0], max: [160, 10, 10] },
        { min: [-10, -30, 0], max: [0, 30, 10] }
      ]]
    });
    expect(result.multiBodyFusion).toEqual({ inputVolumeCount: 2, fusedVolumeCount: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(1);
  });

  it("leaves genuinely disjoint bodies un-fused with no fusion report", { timeout: 300_000 }, async () => {
    const step = await generateDisjointBarsStep();
    const result = await meshStepToMshV2(step, { elementOrder: 1, meshSizeMm: 8 });
    expect(result.multiBodyFusion).toBeUndefined();
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(2);
  });
});

describe("diagnoseStepMeshFailure", () => {
  it("translates TetGen PLC boundary-recovery failures into an honest geometry diagnosis", () => {
    const raw = new Error("gmshModelMeshGenerate: PLC Error:  A segment and a facet intersect at point (12.3, 4.5, 6.7).");
    const diagnosed = diagnoseStepMeshFailure(raw);
    expect(diagnosed).toBeInstanceOf(StepGeometryError);
    expect(diagnosed.message).toContain("surfaces pass through each other");
    expect(diagnosed.message).toContain("overlapping solid bodies or a self-intersecting boolean");
    // Sewing advice is wrong for a closed-but-self-intersecting shell.
    expect(diagnosed.message).not.toContain("Fix open surfaces");
    // The raw mesher wording stays available for diagnosis.
    expect(diagnosed.message).toContain("PLC Error");
  });

  it("keeps the existing open-surfaces action for non-intersection failures", () => {
    const raw = new StepGeometryError("The STEP import contains surfaces but no closed solid volume.");
    const diagnosed = diagnoseStepMeshFailure(raw);
    expect(diagnosed.message).toContain("Fix open surfaces");
  });

  it("passes unrelated errors through unchanged", () => {
    const raw = new Error("memory access out of bounds");
    expect(diagnoseStepMeshFailure(raw)).toBe(raw);
  });
});
