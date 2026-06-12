/**
 * Minimal ISO 10303-21 (STEP Part 21) writer for AP214 analytic B-rep solids.
 *
 * Every solid this writer emits is exact analytic geometry (PLANE,
 * CYLINDRICAL_SURFACE, TOROIDAL_SURFACE) inside MANIFOLD_SOLID_BREP /
 * ADVANCED_BREP_SHAPE_REPRESENTATION entities. Nothing is tessellated, so
 * downstream CAD tools (Shapr3D, Fusion, FreeCAD, SolidWorks) import smooth,
 * editable solids instead of faceted approximations.
 */

export type Vec3 = readonly [number, number, number];

/** Formats a finite number as a STEP real, which always carries a decimal point. */
export function formatStepReal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("STEP reals must be finite numbers.");
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const text = String(normalized);
  const [mantissa = "0", exponent] = text.split(/[eE]/);
  const withPoint = mantissa.includes(".") ? mantissa : `${mantissa}.`;
  return exponent === undefined ? withPoint : `${withPoint}E${exponent}`;
}

/** Escapes a string for a STEP literal: apostrophes and backslashes are doubled. */
export function escapeStepString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function formatVec3(vector: Vec3): string {
  return `(${formatStepReal(vector[0])},${formatStepReal(vector[1])},${formatStepReal(vector[2])})`;
}

/**
 * Appends STEP entity instances and hands back their ids so callers can wire
 * up the entity graph. Ids are sequential starting at #1.
 */
export class StepWriter {
  private readonly definitions: string[] = [];

  /** Registers `#id=<definition>;` and returns the assigned id. */
  add(definition: string): number {
    const id = this.definitions.length + 1;
    this.definitions.push(`#${id}=${definition};`);
    return id;
  }

  get entityCount(): number {
    return this.definitions.length;
  }

  dataSection(): string {
    return this.definitions.join("\n");
  }

  cartesianPoint(point: Vec3): number {
    return this.add(`CARTESIAN_POINT('',${formatVec3(point)})`);
  }

  direction(direction: Vec3): number {
    return this.add(`DIRECTION('',${formatVec3(direction)})`);
  }

  axis2Placement3d(location: Vec3, axis: Vec3, refDirection: Vec3): number {
    const locationId = this.cartesianPoint(location);
    const axisId = this.direction(axis);
    const refDirectionId = this.direction(refDirection);
    return this.add(`AXIS2_PLACEMENT_3D('',#${locationId},#${axisId},#${refDirectionId})`);
  }

  vertexPoint(point: Vec3): number {
    const pointId = this.cartesianPoint(point);
    return this.add(`VERTEX_POINT('',#${pointId})`);
  }

  circle(placementId: number, radius: number): number {
    return this.add(`CIRCLE('',#${placementId},${formatStepReal(radius)})`);
  }

  line(point: Vec3, direction: Vec3): number {
    const pointId = this.cartesianPoint(point);
    const directionId = this.direction(direction);
    const vectorId = this.add(`VECTOR('',#${directionId},1.)`);
    return this.add(`LINE('',#${pointId},#${vectorId})`);
  }

  edgeCurve(startVertexId: number, endVertexId: number, curveId: number): number {
    return this.add(`EDGE_CURVE('',#${startVertexId},#${endVertexId},#${curveId},.T.)`);
  }

  orientedEdge(edgeId: number, sameSense: boolean): number {
    return this.add(`ORIENTED_EDGE('',*,*,#${edgeId},${sameSense ? ".T." : ".F."})`);
  }

  edgeLoop(orientedEdgeIds: readonly number[]): number {
    return this.add(`EDGE_LOOP('',(${orientedEdgeIds.map((id) => `#${id}`).join(",")}))`);
  }

  faceOuterBound(loopId: number): number {
    return this.add(`FACE_OUTER_BOUND('',#${loopId},.T.)`);
  }

  faceBound(loopId: number): number {
    return this.add(`FACE_BOUND('',#${loopId},.T.)`);
  }

  advancedFace(boundIds: readonly number[], surfaceId: number, sameSense: boolean): number {
    return this.add(`ADVANCED_FACE('',(${boundIds.map((id) => `#${id}`).join(",")}),#${surfaceId},${sameSense ? ".T." : ".F."})`);
  }

  closedShell(faceIds: readonly number[]): number {
    return this.add(`CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(",")}))`);
  }

  manifoldSolidBrep(name: string, shellId: number): number {
    return this.add(`MANIFOLD_SOLID_BREP('${escapeStepString(name)}',#${shellId})`);
  }
}

export interface StepDocumentOptions {
  /** PRODUCT name shown by CAD packages in the model tree. */
  partName: string;
  /** Filename recorded in the FILE_NAME header entry. */
  filename: string;
  /** Optional FILE_DESCRIPTION text. */
  description?: string;
  /** Timestamp recorded in the header; defaults to now. */
  createdAt?: Date;
  /** Emits MANIFOLD_SOLID_BREP entities and returns their ids. */
  buildSolids: (writer: StepWriter) => readonly number[];
}

/**
 * Assembles a complete AP214 STEP file around the solids produced by
 * `buildSolids`. Lengths are millimetres, angles radians.
 */
export function buildStepDocument(options: StepDocumentOptions): string {
  const writer = new StepWriter();
  const partName = escapeStepString(options.partName);

  const applicationContextId = writer.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  writer.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${applicationContextId})`);
  const productContextId = writer.add(`PRODUCT_CONTEXT('',#${applicationContextId},'mechanical')`);
  const productId = writer.add(`PRODUCT('${partName}','${partName}','',(#${productContextId}))`);
  const formationId = writer.add(`PRODUCT_DEFINITION_FORMATION('','',#${productId})`);
  const definitionContextId = writer.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${applicationContextId},'design')`);
  const productDefinitionId = writer.add(`PRODUCT_DEFINITION('design','',#${formationId},#${definitionContextId})`);
  const productShapeId = writer.add(`PRODUCT_DEFINITION_SHAPE('','',#${productDefinitionId})`);

  const solidIds = options.buildSolids(writer);
  if (solidIds.length === 0) {
    throw new Error("A STEP document needs at least one solid.");
  }

  const originPlacementId = writer.axis2Placement3d([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const lengthUnitId = writer.add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )");
  const angleUnitId = writer.add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )");
  const solidAngleUnitId = writer.add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )");
  const uncertaintyId = writer.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lengthUnitId},'distance_accuracy_value','confusion accuracy')`
  );
  const contextId = writer.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertaintyId})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnitId},#${angleUnitId},#${solidAngleUnitId})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )`
  );
  const representationItems = [originPlacementId, ...solidIds].map((id) => `#${id}`).join(",");
  const shapeRepresentationId = writer.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('${partName}',(${representationItems}),#${contextId})`);
  writer.add(`SHAPE_DEFINITION_REPRESENTATION(#${productShapeId},#${shapeRepresentationId})`);
  writer.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${productId}))`);

  const timestamp = (options.createdAt ?? new Date()).toISOString().slice(0, 19);
  const description = escapeStepString(options.description ?? `OpenCAE parametric part: ${options.partName}`);
  return [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('${description}'),'2;1');`,
    `FILE_NAME('${escapeStepString(options.filename)}','${timestamp}',('OpenCAE'),('Esau Engineering'),'OpenCAE STEP writer','OpenCAE','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    writer.dataSection(),
    "ENDSEC;",
    "END-ISO-10303-21;",
    ""
  ].join("\n");
}
