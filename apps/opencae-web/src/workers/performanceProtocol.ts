import type { AnalysisMesh, ResultField, ResultSummary, Study } from "@opencae/schema";
import type { PreparedPlaybackFrameCache } from "../resultPlaybackCache";

export interface LocalSolveResult {
  summary: ResultSummary;
  fields: ResultField[];
}

export interface EncodedBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface DecodedStlGeometry {
  positions: Float32Array;
  normals: Float32Array;
  volumeM3?: number;
}

export interface ImportedStepPreview {
  dimensions: {
    x: number;
    y: number;
    z: number;
    units: "mm";
  };
  normalizedBounds: EncodedBounds;
  meshCount: number;
}

export type PerformanceWorkerPayloads = {
  solveLocalStudy: {
    runId: string;
    study: Study;
    analysisMesh?: AnalysisMesh;
  };
  prepareResultFrame: {
    fields: ResultField[];
    framePosition: number;
  };
  preparePlaybackFrames: {
    fields: ResultField[];
    frameIndexes: number[];
    playbackFps: number;
    budgetBytes: number;
    cacheKey?: string;
  };
  decodeStl: {
    buffer: ArrayBuffer;
  };
  importStep: {
    contentBase64: string;
    color: string;
  };
};

export type PerformanceWorkerResults = {
  solveLocalStudy: LocalSolveResult;
  prepareResultFrame: { fields: ResultField[] };
  preparePlaybackFrames: PreparedPlaybackFrameCache;
  decodeStl: DecodedStlGeometry;
  importStep: ImportedStepPreview;
};

export type PerformanceWorkerOperation = keyof PerformanceWorkerPayloads;

export type PerformanceWorkerRequest<Operation extends PerformanceWorkerOperation = PerformanceWorkerOperation> = {
  [Key in PerformanceWorkerOperation]: {
    id: string;
    operation: Key;
    payload: PerformanceWorkerPayloads[Key];
  };
}[Operation];

export interface PerformanceWorkerError {
  name: string;
  message: string;
  stack?: string;
}

export type PerformanceWorkerSuccess<Operation extends PerformanceWorkerOperation = PerformanceWorkerOperation> = {
  [Key in PerformanceWorkerOperation]: {
    id: string;
    operation: Key;
    ok: true;
    result: PerformanceWorkerResults[Key];
  };
}[Operation];

export type PerformanceWorkerFailure<Operation extends PerformanceWorkerOperation = PerformanceWorkerOperation> = {
  id: string;
  operation: Operation;
  ok: false;
  error: PerformanceWorkerError;
};

export type PerformanceWorkerResponse<Operation extends PerformanceWorkerOperation = PerformanceWorkerOperation> =
  | PerformanceWorkerSuccess<Operation>
  | PerformanceWorkerFailure<Operation>;

let requestCounter = 0;

export function createPerformanceWorkerRequest<Operation extends PerformanceWorkerOperation>(
  operation: Operation,
  payload: PerformanceWorkerPayloads[Operation]
): PerformanceWorkerRequest<Operation> {
  requestCounter += 1;
  const uniquePart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${requestCounter.toString(36)}`;
  return {
    id: `perf-${uniquePart}`,
    operation,
    payload
  } as PerformanceWorkerRequest<Operation>;
}

export function isPerformanceWorkerSuccess(value: unknown): value is PerformanceWorkerSuccess {
  return isRecord(value) && value.ok === true && typeof value.id === "string" && typeof value.operation === "string" && "result" in value;
}

export function isPerformanceWorkerFailure(value: unknown): value is PerformanceWorkerFailure {
  return isRecord(value) && value.ok === false && typeof value.id === "string" && typeof value.operation === "string" && isRecord(value.error) && typeof value.error.message === "string";
}

export function normalizePerformanceWorkerError(error: unknown): PerformanceWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Worker operation failed.",
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : "Worker operation failed."
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
