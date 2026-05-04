export type UnitSystem = "SI" | "US";

export interface ModelDimensions {
  x: number;
  y: number;
  z: number;
  units: "mm";
}

export type Triangle = [[number, number, number], [number, number, number], [number, number, number]];

export function formatEngineeringValue(value: number, units: string): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${units}`.trim();
}

export function stlDimensionsFromBase64(contentBase64?: string): ModelDimensions | undefined {
  if (!contentBase64) return undefined;
  return stlDimensionsFromBytes(base64ToBytes(contentBase64));
}

export function stlDimensionsFromBytes(bytes: Uint8Array): ModelDimensions | undefined {
  const bounds = isExactBinaryStl(bytes) ? binaryStlBounds(bytes) : asciiStlBounds(bytes);
  if (!bounds) return undefined;
  const size = bounds.max.map((max, index) => max - bounds.min[index]!) as [number, number, number];
  if (!size.every((value) => Number.isFinite(value) && value > 0)) return undefined;
  return {
    x: roundDimension(size[0]),
    y: roundDimension(size[2]),
    z: roundDimension(size[1]),
    units: "mm"
  };
}

export function stlVolumeM3FromBase64(contentBase64?: string): number | undefined {
  if (!contentBase64) return undefined;
  return stlVolumeM3FromBytes(base64ToBytes(contentBase64));
}

export function stlVolumeM3FromBytes(bytes: Uint8Array): number | undefined {
  const triangles = isExactBinaryStl(bytes) ? binaryStlTriangles(bytes) : asciiStlTriangles(bytes);
  if (!triangles.length) return undefined;
  return meshVolumeM3FromTriangles(triangles);
}

export function meshVolumeM3FromTriangles(triangles: Triangle[]): number | undefined {
  if (!triangles.length) return undefined;
  let volumeMm3 = 0;
  for (const [a, b, c] of triangles) {
    volumeMm3 += dot(a, cross(b, c)) / 6;
  }
  const volume = Math.abs(volumeMm3) / 1_000_000_000;
  return Number.isFinite(volume) && volume > 0 ? volume : undefined;
}

function binaryStlBounds(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const triangleOffset = 84 + triangleIndex * 50 + 12;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = view.getFloat32(triangleOffset + vertexIndex * 12 + axis * 4, true);
        if (!Number.isFinite(value)) return undefined;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
  }
  return { min, max };
}

function binaryStlTriangles(bytes: Uint8Array): Triangle[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  const triangles: Triangle[] = [];
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const triangleOffset = 84 + triangleIndex * 50 + 12;
    const triangle: Triangle = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const vertex = triangle[vertexIndex]!;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = view.getFloat32(triangleOffset + vertexIndex * 12 + axis * 4, true);
        if (!Number.isFinite(value)) return [];
        vertex[axis] = value;
      }
    }
    triangles.push(triangle);
  }
  return triangles;
}

function asciiStlBounds(bytes: Uint8Array) {
  const vertices = asciiStlVertices(bytes);
  if (!vertices.length) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertex[axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return { min, max };
}

function asciiStlTriangles(bytes: Uint8Array): Triangle[] {
  const vertices = asciiStlVertices(bytes);
  const triangles: Triangle[] = [];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    triangles.push([vertices[index]!, vertices[index + 1]!, vertices[index + 2]!]);
  }
  return triangles;
}

function asciiStlVertices(bytes: Uint8Array): Array<[number, number, number]> {
  const text = new TextDecoder().decode(bytes);
  const vertices: Array<[number, number, number]> = [];
  for (const line of text.split("\n")) {
    const vertex = asciiStlVertexFromLine(line);
    if (vertex === "invalid") return [];
    if (vertex) vertices.push(vertex);
  }
  return vertices;
}

function asciiStlVertexFromLine(line: string): [number, number, number] | "invalid" | undefined {
  const tokens = whitespaceTokens(line);
  if (tokens[0]?.toLowerCase() !== "vertex") return undefined;
  if (tokens.length < 4) return "invalid";
  const vertex = [Number(tokens[1]), Number(tokens[2]), Number(tokens[3])] as [number, number, number];
  return vertex.every((value) => Number.isFinite(value)) ? vertex : "invalid";
}

function whitespaceTokens(value: string): string[] {
  const tokens: string[] = [];
  let start: number | undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (isWhitespace(value[index]!)) {
      if (start !== undefined) {
        tokens.push(value.slice(start, index));
        start = undefined;
      }
    } else if (start === undefined) {
      start = index;
    }
  }
  if (start !== undefined) tokens.push(value.slice(start));
  return tokens;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f";
}

function dot(a: [number, number, number], b: [number, number, number]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function isExactBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  return 84 + triangles * 50 === bytes.byteLength;
}

function base64ToBytes(value: string): Uint8Array {
  const bufferCtor = (globalThis as { Buffer?: { from: (value: string, encoding: "base64") => Uint8Array } }).Buffer;
  if (bufferCtor) return new Uint8Array(bufferCtor.from(value, "base64"));
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function roundDimension(value: number) {
  return Math.round(value * 10) / 10;
}
