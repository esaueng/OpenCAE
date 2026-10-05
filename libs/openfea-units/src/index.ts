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
  if (isExactBinaryStl(bytes)) return binaryStlVolumeM3(bytes);
  const vertices = asciiStlVertices(bytes);
  return meshVolumeM3FromTriangleSource(Math.floor(vertices.length / 3), (index) => {
    const offset = index * 3;
    const a = vertices[offset];
    const b = vertices[offset + 1];
    const c = vertices[offset + 2];
    return a && b && c ? [a, b, c] : undefined;
  });
}

export function meshVolumeM3FromTriangles(triangles: Triangle[]): number | undefined {
  return meshVolumeM3FromTriangleSource(triangles.length, (index) => triangles[index]);
}

export function meshVolumeM3FromTriangleSource(triangleCount: number, triangleAt: (index: number) => Triangle | undefined): number | undefined {
  if (!Number.isSafeInteger(triangleCount) || triangleCount <= 0) return undefined;
  let volumeMm3 = 0;
  for (let index = 0; index < triangleCount; index += 1) {
    const triangle = triangleAt(index);
    if (!triangle) return undefined;
    const [a, b, c] = triangle;
    volumeMm3 += dot(a, cross(b, c)) / 6;
  }
  const volume = Math.abs(volumeMm3) / 1_000_000_000;
  return Number.isFinite(volume) && volume > 0 ? volume : undefined;
}

function binaryStlVolumeM3(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  return meshVolumeM3FromTriangleSource(triangleCount, (triangleIndex) => {
    const triangleOffset = 84 + triangleIndex * 50 + 12;
    const triangle: Triangle = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = view.getFloat32(triangleOffset + vertexIndex * 12 + axis * 4, true);
        if (!Number.isFinite(value)) return undefined;
        triangle[vertexIndex]![axis] = value;
      }
    }
    return triangle;
  });
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

function asciiStlVertices(bytes: Uint8Array): Array<[number, number, number]> {
  const text = new TextDecoder().decode(bytes);
  const vertices: Array<[number, number, number]> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("vertex ")) continue;
    const parts = splitAsciiWhitespace(trimmed);
    if (parts.length !== 4) return [];
    const vertex = [Number(parts[1]), Number(parts[2]), Number(parts[3])] as [number, number, number];
    if (!vertex.every((value) => Number.isFinite(value))) return [];
    vertices.push(vertex);
  }
  return vertices;
}

function splitAsciiWhitespace(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const char of value) {
    if (char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
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
