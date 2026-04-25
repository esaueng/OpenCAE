import type { DisplayFace } from "@opencae/schema";

export type SampleModelKind = "blank" | "bracket" | "plate" | "cantilever" | "uploaded";
export type ModelHitPoint = { x: number; y: number; z: number };

const BRACKET_DEPTH = 1.1;
const BRACKET_HOLES = [
  { id: "face-upright-hole", center: [-1.2, 1.48] as [number, number], radius: 0.17 },
  { id: "face-base-left", center: [0.24, 0] as [number, number], radius: 0.13 },
  { id: "face-base-left", center: [1.2, 0] as [number, number], radius: 0.13 }
];

export function faceForModelHit(kind: SampleModelKind, faces: DisplayFace[], point: ModelHitPoint): DisplayFace | null {
  if (!faces.length || kind === "blank") return null;
  if (kind === "bracket") return bracketFaceForHit(faces, point) ?? nearestFace(faces, point);
  return nearestFace(faces, point);
}

function bracketFaceForHit(faces: DisplayFace[], point: ModelHitPoint): DisplayFace | null {
  const frontDepth = BRACKET_DEPTH / 2;
  if (Math.abs(point.z - frontDepth) < 0.18) {
    for (const hole of BRACKET_HOLES) {
      if (distance2d(point.x, point.y, hole.center[0], hole.center[1]) <= hole.radius * 1.65) {
        return faces.find((face) => face.id === hole.id) ?? null;
      }
    }
    if (point.y > 0.32 && point.x < -0.66) return faces.find((face) => face.id === "face-upright-front") ?? null;
    if (point.y < -0.14) return faces.find((face) => face.id === "face-base-front") ?? null;
  }
  if (point.y > 2.3) return faces.find((face) => face.id === "face-load-top") ?? null;
  if (point.y > 0.16 && point.y < 0.34) return faces.find((face) => face.id === "face-base-bottom") ?? null;
  if (point.x < -1.48) return faces.find((face) => face.id === "face-upright-left") ?? null;
  if (point.x > -0.86 && point.x < -0.68 && point.y > 0.3) return faces.find((face) => face.id === "face-upright-right") ?? null;
  return null;
}

function nearestFace(faces: DisplayFace[], point: ModelHitPoint): DisplayFace | null {
  let bestFace: DisplayFace | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const face of faces) {
    const distance = distance3d(point, face.center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestFace = face;
    }
  }
  return bestFace;
}

function distance2d(x: number, y: number, cx: number, cy: number) {
  return Math.hypot(x - cx, y - cy);
}

function distance3d(point: ModelHitPoint, center: [number, number, number]) {
  return Math.hypot(point.x - center[0], point.y - center[1], point.z - center[2]);
}
