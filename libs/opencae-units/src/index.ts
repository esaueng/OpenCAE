export type UnitSystem = "SI" | "US";

export interface ModelDimensions {
  x: number;
  y: number;
  z: number;
  units: "mm";
}

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
  const text = new TextDecoder().decode(bytes);
  const vertexPattern = /^\s*vertex\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/gim;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let match: RegExpExecArray | null;
  let vertexCount = 0;
  while ((match = vertexPattern.exec(text))) {
    vertexCount += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(match[axis + 1]);
      if (!Number.isFinite(value)) return undefined;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return vertexCount ? { min, max } : undefined;
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
