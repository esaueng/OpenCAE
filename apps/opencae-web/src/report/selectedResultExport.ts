import type { OpenCAEModelJson } from "@opencae/core";
import type { ResultField } from "@opencae/schema";
import type { SolverSurfaceMesh } from "../projectFile";

export const SELECTED_RESULT_EXPORT_SCHEMA_VERSION = "1.0.0";
export const SELECTED_RESULT_EXPORT_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;
export const SELECTED_RESULT_EXPORT_CHUNK_CHARACTERS = 256 * 1024;

export type SelectedResultState =
  | { kind: "static" }
  | { kind: "dynamic_frame"; frameIndex: number; timeSeconds?: number }
  | { kind: "modal_mode"; modeIndex: number; frequencyHz?: number }
  | { kind: "harmonic_frequency"; frequencyHz: number };

export interface SelectedResultExportInput {
  projectName: string;
  projectSchemaVersion: string;
  analysisType: string;
  variant?: { id: string; name: string };
  state: SelectedResultState;
  model: Pick<OpenCAEModelJson, "schemaVersion" | "nodes" | "elementBlocks" | "coordinateSystem">;
  surfaceMesh: SolverSurfaceMesh;
  fields: ResultField[];
}

export type SelectedResultExportFormat = "csv" | "vtu";

export interface SelectedResultExportFile {
  parts: BlobPart[];
  mimeType: string;
  extension: ".csv" | ".vtu";
  selectedFields: ResultField[];
  estimatedPeakBytes: number;
}

type VolumeCell = {
  id: number;
  blockName: string;
  localId: number;
  type: "Tet4" | "Tet10";
  connectivity: number[];
};

type ExportContext = {
  input: SelectedResultExportInput;
  fields: ResultField[];
  nodeCount: number;
  cells: VolumeCell[];
  lengthUnits: "m" | "mm";
  surfaceNodeByVolumeNode: Map<number, number>;
};

type CsvColumn = {
  header: string;
  nodeValue?: (volumeNode: number) => string;
  cellValue?: (cell: VolumeCell) => string;
  surfaceTriangleValue?: (surfaceTriangle: number) => string;
};

export function buildSelectedResultExport(
  input: SelectedResultExportInput,
  format: SelectedResultExportFormat,
  memoryBudgetBytes = SELECTED_RESULT_EXPORT_MEMORY_BUDGET_BYTES
): SelectedResultExportFile {
  const context = exportContext(input);
  const estimatedPeakBytes = estimateSelectedResultExportPeakBytes(context, format);
  if (estimatedPeakBytes > memoryBudgetBytes) {
    throw new Error(
      `The selected-state ${format.toUpperCase()} export is estimated to need ${formatBytes(estimatedPeakBytes)} of browser memory, exceeding the ${formatBytes(memoryBudgetBytes)} export limit. Reduce mesh size or export from a desktop postprocessor.`
    );
  }
  const parts = format === "csv" ? buildCsvParts(context) : buildVtuParts(context);
  return {
    parts,
    mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/vnd.vtk.vtu+xml;charset=utf-8",
    extension: format === "csv" ? ".csv" : ".vtu",
    selectedFields: context.fields,
    estimatedPeakBytes
  };
}

export function selectedResultExportFilename(
  input: Pick<SelectedResultExportInput, "projectName" | "analysisType" | "variant" | "state" | "model">,
  format: SelectedResultExportFormat
): string {
  const state = stateFilenamePart(input.state);
  const variant = input.variant?.name || input.variant?.id || "default";
  const lengthUnits = lengthUnitsForModel(input.model);
  return [input.projectName, input.analysisType, variant, state, `canonical-${lengthUnits}`]
    .map(filenamePart)
    .filter(Boolean)
    .join("-") + `.${format}`;
}

export function selectedCanonicalResultFields(input: Pick<SelectedResultExportInput, "fields" | "state" | "variant">): ResultField[] {
  return input.fields.filter((field) => {
    if (input.variant?.id && field.variantId && field.variantId !== input.variant.id) return false;
    if (input.state.kind === "static") {
      return field.modeIndex === undefined && (field.frameIndex === undefined || field.frameIndex === 0);
    }
    if (input.state.kind === "dynamic_frame") return field.frameIndex === input.state.frameIndex;
    if (input.state.kind === "modal_mode") return field.modeIndex === input.state.modeIndex;
    return field.frequencyHz !== undefined && nearlyEqual(field.frequencyHz, input.state.frequencyHz);
  });
}

function exportContext(input: SelectedResultExportInput): ExportContext {
  const coordinates = input.model.nodes.coordinates;
  if (coordinates.length === 0 || coordinates.length % 3 !== 0 || coordinates.some((value) => !Number.isFinite(value))) {
    throw new Error("Result export requires finite canonical volume-node coordinates.");
  }
  const nodeCount = coordinates.length / 3;
  const cells = volumeCells(input.model.elementBlocks, nodeCount);
  if (!cells.length) throw new Error("Result export requires canonical volume-element connectivity.");
  const fields = selectedCanonicalResultFields(input);
  if (!fields.length) throw new Error("No canonical result fields match the selected result state.");
  const surfaceNodeByVolumeNode = validateSurfaceTopology(input.surfaceMesh, coordinates, nodeCount);
  validateFields(fields, input.surfaceMesh, nodeCount, cells.length);
  return { input, fields, nodeCount, cells, lengthUnits: lengthUnitsForModel(input.model), surfaceNodeByVolumeNode };
}

function volumeCells(elementBlocks: SelectedResultExportInput["model"]["elementBlocks"], nodeCount: number): VolumeCell[] {
  const cells: VolumeCell[] = [];
  for (const block of elementBlocks) {
    const nodesPerCell = block.type === "Tet4" ? 4 : 10;
    if (block.connectivity.length % nodesPerCell !== 0) {
      throw new Error(`Element block ${block.name} has incomplete ${block.type} connectivity.`);
    }
    for (let offset = 0; offset < block.connectivity.length; offset += nodesPerCell) {
      const connectivity = block.connectivity.slice(offset, offset + nodesPerCell);
      if (connectivity.some((node) => !Number.isInteger(node) || node < 0 || node >= nodeCount)) {
        throw new Error(`Element block ${block.name} references an invalid node.`);
      }
      cells.push({
        id: cells.length + 1,
        blockName: block.name,
        localId: offset / nodesPerCell + 1,
        type: block.type,
        connectivity
      });
    }
  }
  return cells;
}

function validateSurfaceTopology(
  surfaceMesh: SolverSurfaceMesh,
  coordinates: number[],
  nodeCount: number
): Map<number, number> {
  if (!surfaceMesh.nodes.length || !surfaceMesh.triangles.length) throw new Error("Result export requires the solver surface mesh.");
  if (!surfaceMesh.nodeMap || surfaceMesh.nodeMap.length !== surfaceMesh.nodes.length) {
    throw new Error("The result surface lacks its canonical volume-node map; rerun the analysis before exporting raw data.");
  }
  if (surfaceMesh.volumeNodeCount !== undefined && surfaceMesh.volumeNodeCount !== nodeCount) {
    throw new Error("The active result and canonical volume mesh have different node counts; rerun the analysis before exporting.");
  }
  const surfaceNodeByVolumeNode = new Map<number, number>();
  surfaceMesh.nodeMap.forEach((volumeNode, surfaceNode) => {
    if (!Number.isInteger(volumeNode) || volumeNode < 0 || volumeNode >= nodeCount || surfaceNodeByVolumeNode.has(volumeNode)) {
      throw new Error("The result surface contains an invalid canonical volume-node map.");
    }
    const point = surfaceMesh.nodes[surfaceNode];
    if (!point || point.some((value) => !Number.isFinite(value))) throw new Error("The result surface contains a non-finite node coordinate.");
    for (let axis = 0; axis < 3; axis += 1) {
      const canonical = coordinates[volumeNode * 3 + axis] ?? Number.NaN;
      if (!nearlyEqual(point[axis], canonical)) {
        throw new Error("The active result surface does not match the canonical volume mesh; rerun the analysis before exporting.");
      }
    }
    surfaceNodeByVolumeNode.set(volumeNode, surfaceNode);
  });
  for (const triangle of surfaceMesh.triangles) {
    if (triangle.some((node) => !Number.isInteger(node) || node < 0 || node >= surfaceMesh.nodes.length)) {
      throw new Error("The result surface contains invalid triangle connectivity.");
    }
  }
  return surfaceNodeByVolumeNode;
}

function validateFields(fields: ResultField[], surfaceMesh: SolverSurfaceMesh, nodeCount: number, cellCount: number): void {
  for (const field of fields) {
    const expected = field.location === "node"
      ? field.surfaceMeshRef === surfaceMesh.id ? surfaceMesh.nodes.length : nodeCount
      : field.location === "element" ? cellCount : surfaceMesh.triangles.length;
    if (field.location === "node" && field.surfaceMeshRef && field.surfaceMeshRef !== surfaceMesh.id) {
      throw new Error(`Field ${field.id} references a different solver surface mesh.`);
    }
    if (field.values.length !== expected) {
      throw new Error(`Field ${field.id} has ${field.values.length} values; ${expected} are required for its ${field.location} location.`);
    }
    if (field.values.some((value) => !Number.isFinite(value))) throw new Error(`Field ${field.id} contains a non-finite scalar value.`);
    if (field.vectors && (field.vectors.length !== expected || field.vectors.some((vector) => vector.some((value) => !Number.isFinite(value))))) {
      throw new Error(`Field ${field.id} has invalid vector components.`);
    }
    if (field.tensorValues && (field.tensorValues.length !== expected * 6 || field.tensorValues.some((value) => !Number.isFinite(value)))) {
      throw new Error(`Field ${field.id} has invalid symmetric tensor components.`);
    }
  }
}

function estimateSelectedResultExportPeakBytes(context: ExportContext, format: SelectedResultExportFormat): number {
  let numericValues = context.nodeCount * 3 + context.cells.reduce((sum, cell) => sum + cell.connectivity.length, 0);
  let outputRows = context.nodeCount + context.cells.length;
  for (const field of context.fields) {
    const tupleCount = field.location === "node" ? context.nodeCount : field.location === "element" ? context.cells.length : context.input.surfaceMesh.triangles.length;
    numericValues += tupleCount * (1 + (field.vectors ? 3 : 0) + (field.tensorValues ? 6 : 0));
    if (field.location === "face") outputRows += context.input.surfaceMesh.triangles.length;
  }
  const textBytes = format === "csv"
    ? numericValues * 28 + outputRows * (80 + context.fields.length * 4) + 16_384
    : numericValues * 28 + (context.nodeCount + context.cells.length) * 8 + 32_768;
  // Building string chunks and then a Blob briefly retains both representations.
  return Math.ceil(textBytes * 2.5);
}

function buildCsvParts(context: ExportContext): BlobPart[] {
  const writer = new ChunkedTextWriter();
  const metadata = exportMetadata(context);
  writer.write("# OpenCAE selected-state raw result export\n");
  for (const [key, value] of metadata) writer.write(`# ${csvCell(key)},${csvCell(value)}\n`);
  const columns = csvColumns(context);
  writer.write(columns.map((column) => csvCell(column.header)).join(",") + "\n");
  const coordinates = context.input.model.nodes.coordinates;
  for (let node = 0; node < context.nodeCount; node += 1) {
    writer.write(csvRow(columns, "node", node + 1, "", "", [
      numberText(coordinates[node * 3]),
      numberText(coordinates[node * 3 + 1]),
      numberText(coordinates[node * 3 + 2])
    ], (column) => column.nodeValue?.(node) ?? ""));
  }
  for (const cell of context.cells) {
    writer.write(csvRow(
      columns,
      "element",
      cell.id,
      cell.type,
      cell.connectivity.map((node) => node + 1).join(" "),
      ["", "", ""],
      (column) => column.cellValue?.(cell) ?? "",
      `${cell.blockName}:${cell.localId}`
    ));
  }
  const faceFields = context.fields.filter((field) => field.location === "face");
  if (faceFields.length) {
    context.input.surfaceMesh.triangles.forEach((triangle, triangleIndex) => {
      writer.write(csvRow(
        columns,
        "surface_triangle",
        triangleIndex + 1,
        "Tri3",
        triangle.map((surfaceNode) => (context.input.surfaceMesh.nodeMap?.[surfaceNode] ?? -1) + 1).join(" "),
        ["", "", ""],
        (column) => column.surfaceTriangleValue?.(triangleIndex) ?? ""
      ));
    });
  }
  return writer.finish();
}

function csvColumns(context: ExportContext): CsvColumn[] {
  const columns: CsvColumn[] = [
    { header: "entity_kind" },
    { header: "entity_id" },
    { header: "stable_source_id" },
    { header: "element_type" },
    { header: "connectivity_node_ids" },
    { header: `x [${context.lengthUnits}]` },
    { header: `y [${context.lengthUnits}]` },
    { header: `z [${context.lengthUnits}]` }
  ];
  for (const field of context.fields) {
    const scalarHeader = fieldColumnHeader(field, field.component ?? "scalar");
    columns.push(fieldCsvColumn(context, field, scalarHeader, (index) => field.values[index]));
    if (field.vectors) {
      (["x", "y", "z"] as const).forEach((component, axis) => {
        columns.push(fieldCsvColumn(context, field, fieldColumnHeader(field, component), (index) => field.vectors?.[index]?.[axis]));
      });
    }
    if (field.tensorValues) {
      (["xx", "yy", "zz", "xy", "yz", "xz"] as const).forEach((component, tensorComponent) => {
        columns.push(fieldCsvColumn(context, field, fieldColumnHeader(field, component), (index) => field.tensorValues?.[index * 6 + tensorComponent]));
      });
    }
  }
  return columns;
}

function fieldCsvColumn(
  context: ExportContext,
  field: ResultField,
  header: string,
  valueAt: (index: number) => number | undefined
): CsvColumn {
  const value = (index: number | undefined) => index === undefined ? "" : optionalNumberText(valueAt(index));
  if (field.location === "node") {
    return {
      header,
      nodeValue: (volumeNode) => value(field.surfaceMeshRef === context.input.surfaceMesh.id
        ? context.surfaceNodeByVolumeNode.get(volumeNode)
        : volumeNode)
    };
  }
  if (field.location === "element") return { header, cellValue: (cell) => value(cell.id - 1) };
  return { header, surfaceTriangleValue: (triangle) => value(triangle) };
}

function csvRow(
  columns: CsvColumn[],
  kind: string,
  id: number,
  elementType: string,
  connectivity: string,
  coordinates: [string, string, string],
  fieldValue: (column: CsvColumn) => string,
  stableSourceId = String(id)
): string {
  const fixed = [kind, String(id), stableSourceId, elementType, connectivity, ...coordinates];
  return fixed.concat(columns.slice(fixed.length).map(fieldValue)).map(csvCell).join(",") + "\n";
}

function buildVtuParts(context: ExportContext): BlobPart[] {
  if (context.fields.some((field) => field.location === "face")) {
    throw new Error("VTU export cannot place face fields on the canonical volume grid without recomputing them. Export CSV for this selected state.");
  }
  const writer = new ChunkedTextWriter();
  writer.write('<?xml version="1.0"?>\n');
  writer.write('<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt64">\n');
  writer.write("  <UnstructuredGrid>\n");
  writer.write("    <FieldData>\n");
  const metadataJson = JSON.stringify({
    ...Object.fromEntries(exportMetadata(context)),
    fields: context.fields.map((field) => ({
      id: field.id,
      type: field.type,
      location: field.location,
      component: field.component ?? "scalar",
      units: field.units,
      ...(field.surfaceMeshRef ? { support: "solver_surface_nodes", surface_mesh_ref: field.surfaceMeshRef } : {}),
      ...(field.vectors ? { vector_components: ["x", "y", "z"] } : {}),
      ...(field.tensorValues ? { tensor_components: ["xx", "yy", "zz", "xy", "yz", "xz"] } : {})
    }))
  });
  writeNumericDataArray(writer, "UInt8", "OpenCAE.Metadata.UTF8", 1, new TextEncoder().encode(metadataJson), 6);
  writer.write("    </FieldData>\n");
  writer.write(`    <Piece NumberOfPoints="${context.nodeCount}" NumberOfCells="${context.cells.length}">\n`);
  writer.write("      <Points>\n");
  writeNumericDataArray(writer, "Float64", "Points", 3, context.input.model.nodes.coordinates, 8);
  writer.write("      </Points>\n");
  writer.write("      <Cells>\n");
  writeNumericDataArray(writer, "Int64", "connectivity", 1, cellConnectivityValues(context.cells), 8);
  writeNumericDataArray(writer, "Int64", "offsets", 1, cellOffsetValues(context.cells), 8);
  writeNumericDataArray(writer, "UInt8", "types", 1, context.cells.map((cell) => cell.type === "Tet4" ? 10 : 24), 8);
  writer.write("      </Cells>\n");
  writer.write("      <PointData>\n");
  writeNumericDataArray(writer, "Int64", "OpenCAE.NodeId", 1, integerRange(1, context.nodeCount), 8);
  for (const field of context.fields.filter((candidate) => candidate.location === "node")) writeVtuField(writer, context, field, "point");
  writer.write("      </PointData>\n");
  writer.write("      <CellData>\n");
  writeNumericDataArray(writer, "Int64", "OpenCAE.ElementId", 1, context.cells.map((cell) => cell.id), 8);
  for (const field of context.fields.filter((candidate) => candidate.location === "element")) writeVtuField(writer, context, field, "cell");
  writer.write("      </CellData>\n");
  writer.write("    </Piece>\n  </UnstructuredGrid>\n</VTKFile>\n");
  return writer.finish();
}

function writeVtuField(writer: ChunkedTextWriter, context: ExportContext, field: ResultField, target: "point" | "cell"): void {
  const tupleCount = target === "point" ? context.nodeCount : context.cells.length;
  const scalarValues = expandedFieldValues(context, field, 1, tupleCount, (index) => field.values[index]);
  writeNumericDataArray(writer, "Float64", field.id, 1, scalarValues, 8);
  if (field.vectors) {
    writeNumericDataArray(writer, "Float64", `${field.id}.vector`, 3, expandedFieldValues(context, field, 3, tupleCount, (index, component) => field.vectors?.[index]?.[component]), 8);
  }
  if (field.tensorValues) {
    writeNumericDataArray(writer, "Float64", `${field.id}.tensor`, 6, expandedFieldValues(context, field, 6, tupleCount, (index, component) => field.tensorValues?.[index * 6 + component]), 8);
  }
}

function expandedFieldValues(
  context: ExportContext,
  field: ResultField,
  components: number,
  tupleCount: number,
  valueAt: (index: number, component: number) => number | undefined
): Iterable<number> {
  const isSurfaceField = field.location === "node" && field.surfaceMeshRef === context.input.surfaceMesh.id;
  return (function* values() {
    for (let tuple = 0; tuple < tupleCount; tuple += 1) {
      const sourceTuple = isSurfaceField ? context.surfaceNodeByVolumeNode.get(tuple) : tuple;
      for (let component = 0; component < components; component += 1) {
        yield sourceTuple === undefined ? Number.NaN : valueAt(sourceTuple, component) ?? Number.NaN;
      }
    }
  })();
}

function* cellConnectivityValues(cells: readonly VolumeCell[]): Iterable<number> {
  for (const cell of cells) yield* cell.connectivity;
}

function* cellOffsetValues(cells: readonly VolumeCell[]): Iterable<number> {
  let offset = 0;
  for (const cell of cells) {
    offset += cell.connectivity.length;
    yield offset;
  }
}

function* integerRange(first: number, count: number): Iterable<number> {
  for (let index = 0; index < count; index += 1) yield first + index;
}

function exportMetadata(context: ExportContext): Array<[string, string]> {
  const { input } = context;
  const state = stateMetadata(input.state);
  return [
    ["opencae_export_schema_version", SELECTED_RESULT_EXPORT_SCHEMA_VERSION],
    ["project_schema_version", input.projectSchemaVersion],
    ["core_model_schema_version", input.model.schemaVersion],
    ["analysis_type", input.analysisType],
    ["coordinate_system", "right-handed Z-up"],
    ["length_units", context.lengthUnits],
    ["value_basis", "canonical result contract"],
    ["selection_scope", "selected state only"],
    ["variant_id", input.variant?.id ?? "default"],
    ["variant_name", input.variant?.name ?? "Default"],
    ...state,
    ["node_count", String(context.nodeCount)],
    ["element_count", String(context.cells.length)],
    ["surface_triangle_count", String(input.surfaceMesh.triangles.length)]
  ];
}

function stateMetadata(state: SelectedResultState): Array<[string, string]> {
  if (state.kind === "static") return [["state_kind", "static"]];
  if (state.kind === "dynamic_frame") return [
    ["state_kind", "dynamic_frame"],
    ["frame_index", String(state.frameIndex)],
    ["time_seconds", state.timeSeconds === undefined ? "unknown" : numberText(state.timeSeconds)]
  ];
  if (state.kind === "modal_mode") return [
    ["state_kind", "modal_mode"],
    ["mode_index", String(state.modeIndex)],
    ["frequency_hz", state.frequencyHz === undefined ? "unknown" : numberText(state.frequencyHz)]
  ];
  return [["state_kind", "harmonic_frequency"], ["frequency_hz", numberText(state.frequencyHz)]];
}

function writeNumericDataArray(
  writer: ChunkedTextWriter,
  type: "Float64" | "Int64" | "UInt8",
  name: string,
  components: number,
  values: Iterable<number>,
  indent: number
): void {
  const pad = " ".repeat(indent);
  writer.write(`${pad}<DataArray type="${type}" Name="${xmlAttribute(name)}"${components > 1 ? ` NumberOfComponents="${components}"` : ""} format="ascii">\n${pad}  `);
  let count = 0;
  for (const value of values) {
    writer.write(`${count ? " " : ""}${numberText(value)}`);
    count += 1;
    if (count % 12 === 0) writer.write(`\n${pad}  `);
  }
  writer.write(`\n${pad}</DataArray>\n`);
}

class ChunkedTextWriter {
  private current = "";
  private readonly parts: string[] = [];

  write(text: string): void {
    let remaining = text;
    while (remaining.length) {
      const capacity = SELECTED_RESULT_EXPORT_CHUNK_CHARACTERS - this.current.length;
      this.current += remaining.slice(0, capacity);
      remaining = remaining.slice(capacity);
      if (this.current.length >= SELECTED_RESULT_EXPORT_CHUNK_CHARACTERS) this.flush();
    }
  }

  finish(): BlobPart[] {
    this.flush();
    return this.parts;
  }

  private flush(): void {
    if (!this.current) return;
    this.parts.push(this.current);
    this.current = "";
  }
}

function fieldColumnHeader(field: ResultField, component: string): string {
  return `field:${field.id}|type=${field.type}|location=${field.location}|component=${component}|units=${field.units}`;
}

function stateFilenamePart(state: SelectedResultState): string {
  if (state.kind === "static") return "static";
  if (state.kind === "dynamic_frame") return `frame-${state.frameIndex}`;
  if (state.kind === "modal_mode") return `mode-${state.modeIndex}`;
  return `frequency-${Number(state.frequencyHz.toPrecision(8))}-hz`;
}

function lengthUnitsForModel(model: Pick<OpenCAEModelJson, "coordinateSystem">): "m" | "mm" {
  return model.coordinateSystem?.solverUnits === "mm-N-s-MPa" ? "mm" : "m";
}

function filenamePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function numberText(value: number | undefined): string {
  if (value === undefined) return "";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) throw new Error("Result export encountered an infinite numeric value.");
  return Object.is(value, -0) ? "0" : value.toString();
}

function optionalNumberText(value: number | undefined): string {
  return value === undefined ? "" : numberText(value);
}

function nearlyEqual(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) <= 64 * Number.EPSILON * scale;
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
