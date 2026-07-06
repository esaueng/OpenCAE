import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Characterization tests for the golden OpenCAE Core Cloud solve fixtures in
 * src/testdata/core-cloud-golden/. The fixtures freeze the deployed runner's exact
 * request/response contract (recorded by scripts/record-core-cloud-golden.mts against
 * a runner built from the pinned production opencae-core ref). These assertions are
 * the executable spec the local solve pipeline must satisfy to replace the cloud
 * runner: they check contract invariants of the recorded payloads, they do NOT
 * re-solve anything.
 */

const FIXTURE_DIR = resolve(__dirname, "../testdata/core-cloud-golden");
const PINNED_CORE_REF = readFileSync(resolve(__dirname, "../../../../services/opencae-core-cloud/OPENCAE_CORE_REF"), "utf8").trim();
const EXPECTED_RUNNER_VERSION = "0.1.6";

const STATIC_CASES = ["cantilever-static", "beam-static", "bracket-static"] as const;
const DYNAMIC_CASES = ["cantilever-dynamic", "beam-dynamic"] as const;
const ALL_CASES = [...STATIC_CASES, ...DYNAMIC_CASES] as const;

/** Response fields present in every static solve, with their frozen units/location. */
const STATIC_FIELD_CONTRACT: Record<string, { units: string; location: "node" | "element" }> = {
  "displacement-surface": { units: "mm", location: "node" },
  "stress-surface": { units: "MPa", location: "node" },
  "stress-von-mises-element": { units: "MPa", location: "element" },
  "safety-factor": { units: "ratio", location: "element" },
  "safety-factor-surface": { units: "ratio", location: "node" }
};

/** Per-frame response fields present in every dynamic solve. */
const DYNAMIC_FRAME_FIELD_CONTRACT: Record<string, { units: string; location: "node" | "element" }> = {
  "displacement-surface": { units: "mm", location: "node" },
  velocity: { units: "mm/s", location: "node" },
  acceleration: { units: "mm/s^2", location: "node" },
  "stress-surface": { units: "MPa", location: "node" },
  "stress-von-mises-element": { units: "MPa", location: "element" },
  "safety-factor": { units: "ratio", location: "element" },
  "safety-factor-surface": { units: "ratio", location: "node" }
};

interface GoldenField {
  id: string;
  location: "node" | "element";
  units: string;
  values: number[];
  vectors?: number[][];
  frameIndex?: number;
  timeSeconds?: number;
  surfaceMeshRef?: string;
}

interface GoldenFixture {
  meta: { coreRef: string; runnerVersion: string; coreVersion: string; recordedAt: string; case: string };
  request: {
    runId: string;
    analysisType: "static_stress" | "dynamic_structural";
    solverSettings: { backend: string };
    resultSettings: { provenance: { kind: string; solver: string; resultSource: string; meshSource: string } };
  };
  response: {
    summary: {
      maxStress: number;
      maxStressUnits: string;
      maxDisplacement: number;
      maxDisplacementUnits: string;
      reactionForce: number;
      reactionForceUnits: string;
      safetyFactor: number;
      provenance: Record<string, unknown>;
      transient?: { frameCount: number; startTime: number; endTime: number; outputInterval: number };
    };
    provenance: {
      kind: string;
      solver: string;
      resultSource: string;
      meshSource: string;
      units: string;
      coreVersion: string;
      solverCpuVersion: string;
      runnerVersion: string;
    };
    fields: GoldenField[];
    surfaceMesh: {
      id: string;
      coordinateSpace: string;
      source: string;
      nodes: [number, number, number][];
      triangles: [number, number, number][];
      nodeMap: number[];
      volumeNodeCount: number;
    };
  };
}

function loadFixture(name: string): GoldenFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as GoldenFixture;
}

const fixtures = new Map(ALL_CASES.map((name) => [name, loadFixture(name)] as const));

describe.each(ALL_CASES)("core cloud golden fixture %s", (name) => {
  const fixture = fixtures.get(name)!;
  const { request, response } = fixture;

  test("was recorded from the pinned production runner", () => {
    expect(fixture.meta.case).toBe(name);
    expect(fixture.meta.coreRef).toBe(PINNED_CORE_REF);
    expect(fixture.meta.runnerVersion).toBe(EXPECTED_RUNNER_VERSION);
  });

  test("request targets the cloud backend with computed FEA provenance", () => {
    expect(request.runId).toBe(`run-golden-${name}`);
    expect(request.analysisType).toBe(name.endsWith("-dynamic") ? "dynamic_structural" : "static_stress");
    expect(request.solverSettings.backend).toBe("opencae_core_cloud");
    expect(request.resultSettings.provenance.kind).toBe("opencae_core_fea");
    expect(request.resultSettings.provenance.solver).toBe("opencae-core-cloud");
    expect(request.resultSettings.provenance.resultSource).toBe("computed");
    expect(request.resultSettings.provenance.meshSource).toBe("actual_volume_mesh");
  });

  test("response provenance is a computed cloud FEA solve in mm-N-s-MPa units", () => {
    expect(response.provenance.kind).toBe("opencae_core_fea");
    expect(response.provenance.solver).toBe("opencae-core-cloud");
    expect(response.provenance.resultSource).toBe("computed");
    expect(response.provenance.meshSource).toBe(name === "bracket-static" ? "actual_volume_mesh" : "structured_block_core");
    expect(response.provenance.units).toBe("mm-N-s-MPa");
    expect(response.provenance.runnerVersion).toBe(EXPECTED_RUNNER_VERSION);
    expect(response.provenance.coreVersion).toBe(fixture.meta.coreVersion);
    // The summary carries the identical provenance stamp.
    expect(response.summary.provenance).toEqual(response.provenance);
  });

  test("summary reports MPa/mm/N with finite positive extrema", () => {
    expect(response.summary.maxStressUnits).toBe("MPa");
    expect(response.summary.maxDisplacementUnits).toBe("mm");
    expect(response.summary.reactionForceUnits).toBe("N");
    expect(Number.isFinite(response.summary.maxStress)).toBe(true);
    expect(response.summary.maxStress).toBeGreaterThan(0);
    expect(Number.isFinite(response.summary.maxDisplacement)).toBe(true);
    expect(response.summary.maxDisplacement).toBeGreaterThan(0);
    expect(Number.isFinite(response.summary.safetyFactor)).toBe(true);
    expect(response.summary.safetyFactor).toBeGreaterThan(0);
  });

  test("surface mesh is a solver-space triangle surface of the volume mesh", () => {
    const mesh = response.surfaceMesh;
    expect(mesh.id).toBe("solver-surface");
    expect(mesh.coordinateSpace).toBe("solver");
    expect(mesh.source).toBe("opencae_core_volume_mesh");
    expect(mesh.nodes.length).toBeGreaterThan(0);
    expect(mesh.triangles.length).toBeGreaterThan(0);
    expect(mesh.nodeMap.length).toBe(mesh.nodes.length);
    expect(mesh.volumeNodeCount).toBeGreaterThanOrEqual(mesh.nodes.length);
    for (const node of mesh.nodes) expect(node.length).toBe(3);
    for (const triangle of mesh.triangles) {
      expect(triangle.length).toBe(3);
      for (const index of triangle) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(mesh.nodes.length);
      }
    }
  });

  test("every node-located field aligns with the surface mesh node count", () => {
    const nodeCount = response.surfaceMesh.nodes.length;
    const nodeFields = response.fields.filter((field) => field.location === "node");
    expect(nodeFields.length).toBeGreaterThan(0);
    for (const field of nodeFields) {
      expect(field.values.length, field.id).toBe(nodeCount);
      if (field.vectors) expect(field.vectors.length, field.id).toBe(nodeCount);
      expect(field.surfaceMeshRef, field.id).toBe("solver-surface");
    }
  });

  test("element-located fields are non-empty and share one element count", () => {
    const elementFields = response.fields.filter((field) => field.location === "element");
    expect(elementFields.length).toBeGreaterThan(0);
    const elementCount = elementFields[0]!.values.length;
    expect(elementCount).toBeGreaterThan(0);
    for (const field of elementFields) expect(field.values.length, field.id).toBe(elementCount);
  });
});

describe.each(STATIC_CASES)("static golden fixture %s", (name) => {
  const { response } = fixtures.get(name)!;

  test("exposes exactly the frozen static field ids with frozen units and locations", () => {
    expect(response.fields.map((field) => field.id).sort()).toEqual(Object.keys(STATIC_FIELD_CONTRACT).sort());
    for (const field of response.fields) {
      const contract = STATIC_FIELD_CONTRACT[field.id]!;
      expect(field.units, field.id).toBe(contract.units);
      expect(field.location, field.id).toBe(contract.location);
    }
  });
});

describe.each(DYNAMIC_CASES)("dynamic golden fixture %s", (name) => {
  const { response } = fixtures.get(name)!;
  const transient = response.summary.transient!;

  test("declares a transient summary consistent with the recorded frames", () => {
    expect(transient).toBeDefined();
    expect(transient.frameCount).toBeGreaterThan(1);
    const frameIndexes = new Set(response.fields.map((field) => field.frameIndex));
    expect(frameIndexes.size).toBe(transient.frameCount);
  });

  test("every frame carries the full frozen dynamic field set", () => {
    const suffixes = Object.keys(DYNAMIC_FRAME_FIELD_CONTRACT);
    for (let frame = 0; frame < transient.frameCount; frame += 1) {
      for (const suffix of suffixes) {
        const id = `frame-${frame}-${suffix}`;
        const field = response.fields.find((candidate) => candidate.id === id);
        expect(field, id).toBeDefined();
        expect(field!.units, id).toBe(DYNAMIC_FRAME_FIELD_CONTRACT[suffix]!.units);
        expect(field!.location, id).toBe(DYNAMIC_FRAME_FIELD_CONTRACT[suffix]!.location);
        expect(field!.frameIndex, id).toBe(frame);
      }
    }
    expect(response.fields.length).toBe(transient.frameCount * suffixes.length);
  });

  test("frameIndex and timeSeconds sequences are monotonic and aligned", () => {
    const timeByFrame = new Map<number, number>();
    for (const field of response.fields) {
      expect(field.frameIndex, field.id).toBeTypeOf("number");
      expect(field.timeSeconds, field.id).toBeTypeOf("number");
      const recorded = timeByFrame.get(field.frameIndex!);
      if (recorded === undefined) {
        timeByFrame.set(field.frameIndex!, field.timeSeconds!);
      } else {
        // Every field within one frame shares the frame timestamp.
        expect(field.timeSeconds, field.id).toBe(recorded);
      }
    }
    const frames = [...timeByFrame.keys()].sort((a, b) => a - b);
    expect(frames).toEqual(frames.map((_, position) => position));
    expect(timeByFrame.get(0)).toBe(transient.startTime);
    let previousTime = Number.NEGATIVE_INFINITY;
    for (const frame of frames) {
      const time = timeByFrame.get(frame)!;
      expect(time, `frame ${frame}`).toBeGreaterThan(previousTime);
      previousTime = time;
    }
    expect(previousTime).toBeCloseTo(transient.endTime, 10);
  });
});
