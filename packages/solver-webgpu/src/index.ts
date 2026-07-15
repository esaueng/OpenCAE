export type { WebGPUCapability, WebGPUCapabilityOptions } from "./capability";
export { detectWebGPUCapability } from "./capability";
export {
  automaticTetSolverBackend,
  buildTet4DofAdjacency,
  buildTet4ElementData,
  CPU_TET_DOF_THRESHOLD,
  MAX_WEBGPU_TET4_DOFS,
  WEBGPU_TET4_AUTOMATIC_ENABLED,
  solveTet4MatrixFreeWebGpu,
  tet4MatrixFreeInternalForce,
  tet4MatrixFreeMatVec
} from "./matrix-free";
export type { MatrixFreeCgOptions, MatrixFreeCgResult, Tet4MatrixFreeData } from "./matrix-free";
export { solveStaticTet4ModelWebGpu } from "./static-tet4";
export type { StaticTet4WebGpuOptions, StaticTet4WebGpuResult } from "./static-tet4";
