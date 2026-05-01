import { describe, expect, test } from "vitest";
import type { DisplayModel } from "@opencae/schema";
import * as THREE from "three";
import {
  baseModelRotationRadians,
  formatModelOrientation,
  modelDirectionToViewerSpace,
  modelRotationRadians,
  modelToViewerMatrix,
  rotateDisplayModel,
  viewerDirectionToModelSpace,
  viewerNormalToModelSpace,
  viewerPointToModelSpace
} from "./modelOrientation";

const baseModel: DisplayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 1,
  faces: []
};

const uploadedModel: DisplayModel = {
  ...baseModel,
  id: "display-uploaded",
  nativeCad: {
    format: "step",
    filename: "part.step"
  }
};

describe("model orientation", () => {
  test("rotates a display model by quarter turns without mutating the source", () => {
    const rotatedX = rotateDisplayModel(baseModel, "x");
    const rotatedY = rotateDisplayModel(rotatedX, "y");

    expect(baseModel.orientation).toBeUndefined();
    expect(rotatedX.orientation).toEqual({ x: 90, y: 0, z: 0 });
    expect(rotatedY.orientation).toEqual({ x: 90, y: 90, z: 0 });
  });

  test("wraps model orientation at full turns", () => {
    const model = { ...baseModel, orientation: { x: 270, y: 0, z: 0 } } satisfies DisplayModel;

    expect(rotateDisplayModel(model, "x").orientation).toEqual({ x: 0, y: 0, z: 0 });
    expect(rotateDisplayModel(model, "z", -90).orientation).toEqual({ x: 270, y: 0, z: 270 });
  });

  test("converts saved orientation to radians for the 3D viewer", () => {
    const model = { ...baseModel, orientation: { x: 90, y: 180, z: 270 } } satisfies DisplayModel;

    expect(modelRotationRadians(model)).toEqual([Math.PI / 2, Math.PI, (Math.PI * 3) / 2]);
    expect(formatModelOrientation(model)).toBe("X 90 deg / Y 180 deg / Z 270 deg");
  });

  test("applies legacy base rotation only to sample models", () => {
    expect(baseModelRotationRadians(baseModel)).toEqual([Math.PI / 2, 0, 0]);
    expect(baseModelRotationRadians(uploadedModel)).toEqual([0, 0, 0]);
  });

  test("preserves uploaded model points and normals in source axes", () => {
    expect(viewerPointToModelSpace(new THREE.Vector3(1, 2, 3), uploadedModel).toArray()).toEqual([1, 2, 3]);
    expect(viewerNormalToModelSpace(new THREE.Vector3(0, 0, 1), uploadedModel).toArray()).toEqual([0, 0, 1]);
  });

  test("keeps legacy sample point and normal conversion", () => {
    const point = viewerPointToModelSpace(new THREE.Vector3(1, 2, 3), baseModel);
    const normal = viewerNormalToModelSpace(new THREE.Vector3(0, 0, 1), baseModel);

    expect(point.x).toBeCloseTo(1);
    expect(point.y).toBeCloseTo(3);
    expect(point.z).toBeCloseTo(-2);
    expect(normal.x).toBeCloseTo(0);
    expect(normal.y).toBeCloseTo(1);
    expect(normal.z).toBeCloseTo(0);
  });

  test("converts viewer global load directions into legacy sample model space", () => {
    const savedDirection = viewerDirectionToModelSpace(new THREE.Vector3(0, 0, -1), baseModel);
    const viewerDirection = modelDirectionToViewerSpace(savedDirection, baseModel);

    expect(savedDirection.x).toBeCloseTo(0);
    expect(savedDirection.y).toBeCloseTo(-1);
    expect(savedDirection.z).toBeCloseTo(0);
    expect(viewerDirection.x).toBeCloseTo(0);
    expect(viewerDirection.y).toBeCloseTo(0);
    expect(viewerDirection.z).toBeCloseTo(-1);
  });

  test("combines user orientation outside the model base transform", () => {
    const model = { ...uploadedModel, orientation: { x: 0, y: 0, z: 90 } } satisfies DisplayModel;
    const transformed = new THREE.Vector3(1, 0, 0).applyMatrix4(modelToViewerMatrix(model));

    expect(transformed.x).toBeCloseTo(0);
    expect(transformed.y).toBeCloseTo(1);
    expect(transformed.z).toBeCloseTo(0);
  });
});
