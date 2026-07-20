import type { OpenCAEModelJson } from "@opencae/core";
import type { ResultField } from "@opencae/schema";
import { describe, expect, test } from "vitest";
import type { SolverSurfaceMesh } from "../projectFile";
import {
  buildSelectedResultExport,
  SELECTED_RESULT_EXPORT_CHUNK_CHARACTERS,
  selectedCanonicalResultFields,
  selectedResultExportFilename,
  type SelectedResultExportInput
} from "./selectedResultExport";

const model: Pick<OpenCAEModelJson, "schemaVersion" | "nodes" | "elementBlocks" | "coordinateSystem"> = {
  schemaVersion: "0.4.0",
  nodes: { coordinates: [
    0, 0, 0,
    10, 0, 0,
    0, 10, 0,
    0, 0, 10,
    10, 10, 10
  ] },
  elementBlocks: [{
    name: "solid",
    type: "Tet4",
    material: "steel",
    connectivity: [0, 1, 2, 3, 1, 2, 3, 4]
  }],
  coordinateSystem: { solverUnits: "mm-N-s-MPa", renderCoordinateSpace: "solver" }
};

const surfaceMesh: SolverSurfaceMesh = {
  id: "solver-surface",
  nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
  triangles: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
  coordinateSpace: "solver",
  source: "opencae_core_volume_mesh",
  nodeMap: [0, 1, 2, 3],
  volumeNodeCount: 5
};

const displacement: ResultField = {
  id: "displacement-surface",
  runId: "run-1",
  variantId: "case-a",
  type: "displacement",
  location: "node",
  values: [0, 1, 2, 3],
  vectors: [[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3]],
  min: 0,
  max: 3,
  units: "mm",
  surfaceMeshRef: "solver-surface",
  frameIndex: 2,
  timeSeconds: 0.02
};

const elementStress: ResultField = {
  id: "stress-element",
  runId: "run-1",
  variantId: "case-a",
  type: "stress",
  component: "von_mises",
  location: "element",
  values: [100, 200],
  tensorValues: [100, 10, 5, 1, 2, 3, 200, 20, 10, 2, 4, 6],
  min: 100,
  max: 200,
  units: "MPa",
  frameIndex: 2,
  timeSeconds: 0.02
};

function input(overrides: Partial<SelectedResultExportInput> = {}): SelectedResultExportInput {
  return {
    projectName: "Wing / Rev B",
    projectSchemaVersion: "0.7.0",
    analysisType: "dynamic_structural",
    variant: { id: "case-a", name: "Load Case A" },
    state: { kind: "dynamic_frame", frameIndex: 2, timeSeconds: 0.02 },
    model,
    surfaceMesh,
    fields: [
      displacement,
      elementStress,
      { ...displacement, id: "other-frame", frameIndex: 1 },
      { ...displacement, id: "other-variant", variantId: "case-b" }
    ],
    ...overrides
  };
}

function text(file: ReturnType<typeof buildSelectedResultExport>): string {
  return file.parts.map((part) => String(part)).join("");
}

function numericDataArray(xml: string, name: string): number[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<DataArray[^>]*Name="${escaped}"[^>]*>([\\s\\S]*?)<\\/DataArray>`));
  if (!match) throw new Error(`Missing VTU DataArray ${name}`);
  return match[1]!.trim().split(/\s+/).map(Number);
}

describe("selected-state raw result export", () => {
  test("selects only the active variant and dynamic frame", () => {
    expect(selectedCanonicalResultFields(input()).map((field) => field.id)).toEqual([
      "displacement-surface",
      "stress-element"
    ]);
  });

  test("selects canonical static fields and one modal mode without exporting visualization phases", () => {
    const staticField = { ...displacement, id: "static", frameIndex: undefined, timeSeconds: undefined };
    const staticFrameZero = { ...elementStress, id: "static-zero", frameIndex: 0, timeSeconds: undefined };
    expect(selectedCanonicalResultFields(input({ state: { kind: "static" }, fields: [staticField, staticFrameZero, displacement] })).map((field) => field.id)).toEqual([
      "static",
      "static-zero"
    ]);

    const modeOne = { ...displacement, id: "mode-1", type: "mode_shape" as const, frameIndex: undefined, timeSeconds: undefined, modeIndex: 1, frequencyHz: 81.5 };
    const modeTwo = { ...modeOne, id: "mode-2", modeIndex: 2, frequencyHz: 220 };
    const modal = buildSelectedResultExport(input({
      analysisType: "modal_analysis",
      state: { kind: "modal_mode", modeIndex: 2, frequencyHz: 220 },
      fields: [modeOne, modeTwo]
    }), "vtu");
    const vtu = text(modal);
    const metadata = JSON.parse(new TextDecoder().decode(Uint8Array.from(numericDataArray(vtu, "OpenCAE.Metadata.UTF8")))) as Record<string, unknown>;
    expect(modal.selectedFields.map((field) => field.id)).toEqual(["mode-2"]);
    expect(metadata).toMatchObject({ state_kind: "modal_mode", mode_index: "2", frequency_hz: "220" });
  });

  test("writes re-readable CSV metadata, canonical topology, components, and units", () => {
    const csv = text(buildSelectedResultExport(input(), "csv"));
    const lines = csv.trim().split("\n");
    expect(lines).toContain("# selection_scope,selected state only");
    expect(lines).toContain("# coordinate_system,right-handed Z-up");
    expect(lines).toContain("# length_units,mm");
    expect(lines).toContain("# frame_index,2");
    expect(lines).toContain("# time_seconds,0.02");

    const headerIndex = lines.findIndex((line) => line.startsWith("entity_kind,"));
    const headers = lines[headerIndex]!.split(",");
    const displacementX = headers.indexOf("field:displacement-surface|type=displacement|location=node|component=x|units=mm");
    const stressScalar = headers.indexOf("field:stress-element|type=stress|location=element|component=von_mises|units=MPa");
    const nodeTwo = lines[headerIndex + 2]!.split(",");
    const elementTwo = lines[headerIndex + 5 + 2]!.split(",");
    expect(nodeTwo.slice(0, 8)).toEqual(["node", "2", "2", "", "", "10", "0", "0"]);
    expect(Number(nodeTwo[displacementX])).toBe(1);
    expect(elementTwo.slice(0, 5)).toEqual(["element", "2", "solid:2", "Tet4", "2 3 4 5"]);
    expect(Number(elementTwo[stressScalar])).toBe(200);
  });

  test("writes a canonical VTU volume grid and maps surface-node fields without inventing interior values", () => {
    const vtu = text(buildSelectedResultExport(input(), "vtu"));
    const metadata = JSON.parse(new TextDecoder().decode(Uint8Array.from(numericDataArray(vtu, "OpenCAE.Metadata.UTF8")))) as Record<string, unknown>;
    expect(vtu).toContain('<Piece NumberOfPoints="5" NumberOfCells="2">');
    expect(metadata).toMatchObject({
      opencae_export_schema_version: "1.0.0",
      analysis_type: "dynamic_structural",
      coordinate_system: "right-handed Z-up",
      length_units: "mm",
      variant_id: "case-a",
      state_kind: "dynamic_frame",
      frame_index: "2",
      time_seconds: "0.02"
    });
    expect(metadata.fields).toContainEqual(expect.objectContaining({ id: "stress-element", location: "element", component: "von_mises", units: "MPa" }));
    expect(numericDataArray(vtu, "connectivity")).toEqual([0, 1, 2, 3, 1, 2, 3, 4]);
    expect(numericDataArray(vtu, "offsets")).toEqual([4, 8]);
    expect(numericDataArray(vtu, "types")).toEqual([10, 10]);
    expect(numericDataArray(vtu, "OpenCAE.NodeId")).toEqual([1, 2, 3, 4, 5]);
    expect(numericDataArray(vtu, "OpenCAE.ElementId")).toEqual([1, 2]);
    expect(numericDataArray(vtu, "displacement-surface")).toEqual([0, 1, 2, 3, Number.NaN]);
    expect(numericDataArray(vtu, "displacement-surface.vector")).toEqual([
      0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3,
      Number.NaN, Number.NaN, Number.NaN
    ]);
    expect(numericDataArray(vtu, "stress-element")).toEqual([100, 200]);
    expect(numericDataArray(vtu, "stress-element.tensor")).toEqual(elementStress.tensorValues);
  });

  test("preserves VTK quadratic-tetra node order and cell type for Tet10 meshes", () => {
    const tet10Model = {
      ...model,
      nodes: { coordinates: [
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
        0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0,
        0, 0, 0.5, 0.5, 0, 0.5, 0, 0.5, 0.5
      ] },
      elementBlocks: [{ name: "quadratic", type: "Tet10" as const, material: "steel", connectivity: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }]
    };
    const tet10Surface = {
      ...surfaceMesh,
      nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number, number, number][],
      nodeMap: [0, 1, 2, 3],
      volumeNodeCount: 10
    };
    const stress = { ...elementStress, values: [123], tensorValues: undefined };
    const vtu = text(buildSelectedResultExport(input({ model: tet10Model, surfaceMesh: tet10Surface, fields: [stress] }), "vtu"));
    expect(numericDataArray(vtu, "connectivity")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(numericDataArray(vtu, "offsets")).toEqual([10]);
    expect(numericDataArray(vtu, "types")).toEqual([24]);
  });

  test("uses selected-state and canonical-unit identity in filenames", () => {
    expect(selectedResultExportFilename(input(), "vtu")).toBe(
      "wing-rev-b-dynamic-structural-load-case-a-frame-2-canonical-mm.vtu"
    );
  });

  test("refuses stale topology and requests that exceed the browser-memory budget", () => {
    const staleSurface = { ...surfaceMesh, nodes: surfaceMesh.nodes.map((node) => [...node] as [number, number, number]) };
    staleSurface.nodes[1]![0] = 11;
    expect(() => buildSelectedResultExport(input({ surfaceMesh: staleSurface }), "csv")).toThrow(/does not match the canonical volume mesh/i);
    expect(() => buildSelectedResultExport(input(), "vtu", 1)).toThrow(/exceeding the 0.0 MB export limit/i);
  });

  test("keeps generated output in bounded chunks", () => {
    const nodeCount = 12_000;
    const largeModel = {
      ...model,
      nodes: { coordinates: Array.from({ length: nodeCount * 3 }, (_value, index) => index < 12 ? model.nodes.coordinates[index]! : index / 1000) }
    };
    const volumeField: ResultField = {
      ...displacement,
      id: "volume-displacement",
      surfaceMeshRef: undefined,
      values: Array.from({ length: nodeCount }, (_value, index) => index / 100),
      vectors: undefined
    };
    const largeSurface = { ...surfaceMesh, volumeNodeCount: nodeCount };
    const csv = buildSelectedResultExport(input({ model: largeModel, surfaceMesh: largeSurface, fields: [volumeField] }), "csv");
    expect(csv.parts.length).toBeGreaterThan(1);
    expect(csv.parts.every((part) => String(part).length <= SELECTED_RESULT_EXPORT_CHUNK_CHARACTERS)).toBe(true);
  });
});
