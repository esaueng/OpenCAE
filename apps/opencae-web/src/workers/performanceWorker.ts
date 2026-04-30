import { createResultFrameCache } from "../resultFields";
import { preparePlaybackFrames, preparedPlaybackTransferables, type PreparedPlaybackFrameCache } from "../resultPlaybackCache";
import { normalizedStlGeometryFromBuffer } from "../stlPreview";
import { stepPreviewFromBase64 } from "../stepPreview";
import { fallbackSolveLocalStudy } from "./localSolve";
import {
  normalizePerformanceWorkerError,
  type DecodedStlGeometry,
  type PerformanceWorkerRequest,
  type PerformanceWorkerResponse
} from "./performanceProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<PerformanceWorkerRequest>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

async function handleRequest(request: PerformanceWorkerRequest): Promise<void> {
  try {
    const result = await runOperation(request);
    const response = {
      id: request.id,
      operation: request.operation,
      ok: true,
      result
    } as PerformanceWorkerResponse;
    workerScope.postMessage(response, transferablesFor(result));
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      operation: request.operation,
      ok: false,
      error: normalizePerformanceWorkerError(error)
    } satisfies PerformanceWorkerResponse);
  }
}

async function runOperation(request: PerformanceWorkerRequest) {
  if (request.operation === "solveLocalStudy") {
    return fallbackSolveLocalStudy(request.payload);
  }
  if (request.operation === "prepareResultFrame") {
    return {
      fields: createResultFrameCache(request.payload.fields).fieldsForFramePosition(request.payload.framePosition)
    };
  }
  if (request.operation === "preparePlaybackFrames") {
    return preparePlaybackFrames(request.payload);
  }
  if (request.operation === "decodeStl") {
    const geometry = normalizedStlGeometryFromBuffer(request.payload.buffer);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    if (!positions || !normals) throw new Error("STL file did not contain renderable geometry.");
    const decoded: DecodedStlGeometry = {
      positions: attributeToFloat32Array(positions),
      normals: attributeToFloat32Array(normals),
      ...(typeof geometry.userData.opencaeVolumeM3 === "number" ? { volumeM3: geometry.userData.opencaeVolumeM3 } : {})
    };
    geometry.dispose();
    return decoded;
  }
  const preview = await stepPreviewFromBase64(request.payload.contentBase64, request.payload.color, { includeEdges: false, shareMaterials: true });
  return {
    dimensions: preview.dimensions,
    normalizedBounds: {
      min: preview.normalizedBounds.min.toArray() as [number, number, number],
      max: preview.normalizedBounds.max.toArray() as [number, number, number]
    },
    meshCount: preview.object.children.length
  };
}

function attributeToFloat32Array(attribute: { array: ArrayLike<number> }): Float32Array {
  return attribute.array instanceof Float32Array ? attribute.array : new Float32Array(Array.from(attribute.array));
}

function transferablesFor(result: unknown): Transferable[] {
  if (isPreparedPlaybackFrameCache(result)) return preparedPlaybackTransferables(result);
  if (!isDecodedStlGeometry(result)) return [];
  return [result.positions.buffer, result.normals.buffer];
}

function isPreparedPlaybackFrameCache(value: unknown): value is PreparedPlaybackFrameCache {
  return typeof value === "object" && value !== null && "frames" in value && "actualBytes" in value;
}

function isDecodedStlGeometry(value: unknown): value is DecodedStlGeometry {
  return typeof value === "object" && value !== null && "positions" in value && "normals" in value;
}
