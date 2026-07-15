export const MAX_WEBGPU_TET4_DOFS = 500_000;
export const CPU_TET_DOF_THRESHOLD = 150_000;
/**
 * The operator is available for explicit experiments, but automatic product
 * routing stays disabled until CG vectors and reductions remain GPU-resident
 * and end-to-end browser benchmarks establish a safe release ceiling.
 */
export const WEBGPU_TET4_AUTOMATIC_ENABLED = false;

export type Tet4MatrixFreeData = {
  dofs: number;
  connectivity: Uint32Array;
  /** Per element: 12 shape gradients, volume, Lame lambda, shear mu. */
  elementData: Float32Array;
  rowPtr: Uint32Array;
  adjacencyElements: Uint32Array;
  adjacencyLocalRows: Uint32Array;
  diagonal: Float32Array;
  constrained: Uint32Array;
};

export type MatrixFreeCgOptions = {
  tolerance?: number;
  maxIterations?: number;
  onProgress?: (iteration: number, relativeResidual: number) => void;
  shouldCancel?: () => boolean;
  navigator?: unknown;
};

export type MatrixFreeCgResult =
  | { ok: true; solution: Float32Array; iterations: number; relativeResidual: number; backend: "webgpu-matrix-free-tet4" }
  | { ok: false; error: { code: string; message: string }; iterations: number; relativeResidual: number };

export function automaticTetSolverBackend(input: { elementType: "Tet4" | "Tet10"; dofs: number; webGpuAvailable: boolean }): "cpu" | "webgpu" | "unsupported" {
  if (input.dofs <= CPU_TET_DOF_THRESHOLD) return "cpu";
  if (WEBGPU_TET4_AUTOMATIC_ENABLED && input.elementType === "Tet4" && input.webGpuAvailable && input.dofs <= MAX_WEBGPU_TET4_DOFS) return "webgpu";
  return "unsupported";
}

export function buildTet4DofAdjacency(connectivity: Uint32Array, dofs: number): Pick<Tet4MatrixFreeData, "rowPtr" | "adjacencyElements" | "adjacencyLocalRows"> {
  if (connectivity.length % 4 !== 0) throw new Error("Tet4 connectivity length must be divisible by four.");
  const counts = new Uint32Array(dofs);
  const elementCount = connectivity.length / 4;
  for (let element = 0; element < elementCount; element += 1) for (let local = 0; local < 12; local += 1) {
    const dof = connectivity[element * 4 + Math.floor(local / 3)] * 3 + local % 3;
    if (dof >= dofs) throw new Error("Tet4 connectivity references a DOF outside the system.");
    counts[dof] += 1;
  }
  const rowPtr = new Uint32Array(dofs + 1);
  for (let row = 0; row < dofs; row += 1) rowPtr[row + 1] = rowPtr[row] + counts[row];
  const cursor = rowPtr.slice(0, dofs);
  const adjacencyElements = new Uint32Array(rowPtr[dofs]);
  const adjacencyLocalRows = new Uint32Array(rowPtr[dofs]);
  for (let element = 0; element < elementCount; element += 1) for (let local = 0; local < 12; local += 1) {
    const dof = connectivity[element * 4 + Math.floor(local / 3)] * 3 + local % 3;
    const slot = cursor[dof]++;
    adjacencyElements[slot] = element;
    adjacencyLocalRows[slot] = local;
  }
  return { rowPtr, adjacencyElements, adjacencyLocalRows };
}

export function buildTet4ElementData(input: {
  coordinates: Float64Array | Float32Array;
  connectivity: Uint32Array;
  youngModulus: Float64Array | Float32Array;
  poissonRatio: Float64Array | Float32Array;
}): { elementData: Float32Array; diagonal: Float32Array } {
  const elementCount = input.connectivity.length / 4;
  if (input.youngModulus.length !== elementCount || input.poissonRatio.length !== elementCount) throw new Error("Tet4 material arrays must contain one value per element.");
  const elementData = new Float32Array(elementCount * 15);
  let maxNode = 0;
  for (const node of input.connectivity) maxNode = Math.max(maxNode, node);
  const dofs = maxNode * 3 + 3;
  const diagonal = new Float32Array(dofs);
  for (let element = 0; element < elementCount; element += 1) {
    const geometry = tet4Geometry(input.coordinates, input.connectivity.subarray(element * 4, element * 4 + 4));
    const young = input.youngModulus[element], poisson = input.poissonRatio[element];
    const lambda = young * poisson / ((1 + poisson) * (1 - 2 * poisson));
    const mu = young / (2 * (1 + poisson));
    const offset = element * 15;
    elementData.set(geometry.gradients, offset);
    elementData[offset + 12] = geometry.volume;
    elementData[offset + 13] = lambda;
    elementData[offset + 14] = mu;
    for (let local = 0; local < 12; local += 1) {
      const basis = new Float32Array(12);
      basis[local] = 1;
      const force = elementInternalForce(elementData.subarray(offset, offset + 15), basis);
      const dof = input.connectivity[element * 4 + Math.floor(local / 3)] * 3 + local % 3;
      diagonal[dof] += force[local];
    }
  }
  return { elementData, diagonal };
}

export function tet4MatrixFreeMatVec(data: Tet4MatrixFreeData, vector: Float32Array): Float32Array {
  const output = new Float32Array(data.dofs);
  for (let row = 0; row < data.dofs; row += 1) {
    if (data.constrained[row]) { output[row] = vector[row]; continue; }
    let value = 0;
    for (let slot = data.rowPtr[row]; slot < data.rowPtr[row + 1]; slot += 1) {
      const element = data.adjacencyElements[slot], localRow = data.adjacencyLocalRows[slot];
      const local = new Float32Array(12);
      for (let col = 0; col < 12; col += 1) {
        const dof = data.connectivity[element * 4 + Math.floor(col / 3)] * 3 + col % 3;
        local[col] = data.constrained[dof] ? 0 : vector[dof];
      }
      value += elementInternalForce(data.elementData.subarray(element * 15, element * 15 + 15), local)[localRow];
    }
    output[row] = value;
  }
  return output;
}

/** Physical K*u before Dirichlet row/column replacement, used for reactions. */
export function tet4MatrixFreeInternalForce(data: Tet4MatrixFreeData, vector: Float32Array): Float32Array {
  return tet4MatrixFreeMatVec({ ...data, constrained: new Uint32Array(data.dofs) }, vector);
}

export async function solveTet4MatrixFreeWebGpu(data: Tet4MatrixFreeData, rhs: Float32Array, options: MatrixFreeCgOptions = {}): Promise<MatrixFreeCgResult> {
  if (data.dofs > MAX_WEBGPU_TET4_DOFS) return failure("max-dofs-exceeded", `WebGPU Tet4 solve is limited to ${MAX_WEBGPU_TET4_DOFS.toLocaleString()} DOFs.`, 0, Infinity);
  if (rhs.length !== data.dofs) return failure("invalid-rhs", "Matrix-free RHS length does not match DOFs.", 0, Infinity);
  const operator = await createWebGpuOperator(data, options.navigator);
  if (!operator.ok) return failure(operator.error.code, operator.error.message, 0, Infinity);
  const tolerance = options.tolerance ?? 1e-6;
  const maxIterations = options.maxIterations ?? Math.min(20_000, Math.max(200, data.dofs));
  const x = new Float32Array(data.dofs);
  const r = Float32Array.from(rhs);
  const z = new Float32Array(data.dofs);
  const p = new Float32Array(data.dofs);
  for (let index = 0; index < data.dofs; index += 1) {
    const d = data.constrained[index] ? 1 : data.diagonal[index];
    z[index] = Math.abs(d) > 1e-20 ? r[index] / d : r[index];
    p[index] = z[index];
  }
  const rhsNorm = Math.max(Math.sqrt(dot(rhs, rhs)), 1);
  let rz = dot(r, z);
  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (options.shouldCancel?.()) return failure("cancelled", "WebGPU solve cancelled.", iteration - 1, Math.sqrt(dot(r, r)) / rhsNorm);
      const ap = await operator.multiply(p);
      const denominator = dot(p, ap);
      if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-30) return failure("singular-system", "WebGPU matrix-free CG encountered a singular or indefinite system.", iteration, Math.sqrt(dot(r, r)) / rhsNorm);
      const alpha = rz / denominator;
      for (let index = 0; index < data.dofs; index += 1) { x[index] += alpha * p[index]; r[index] -= alpha * ap[index]; }
      const relativeResidual = Math.sqrt(dot(r, r)) / rhsNorm;
      if (iteration % 25 === 0) options.onProgress?.(iteration, relativeResidual);
      if (relativeResidual <= tolerance) return { ok: true, solution: x, iterations: iteration, relativeResidual, backend: "webgpu-matrix-free-tet4" };
      for (let index = 0; index < data.dofs; index += 1) {
        const d = data.constrained[index] ? 1 : data.diagonal[index];
        z[index] = Math.abs(d) > 1e-20 ? r[index] / d : r[index];
      }
      const nextRz = dot(r, z), beta = nextRz / rz;
      for (let index = 0; index < data.dofs; index += 1) p[index] = z[index] + beta * p[index];
      rz = nextRz;
    }
  } finally {
    operator.destroy();
  }
  return failure("cg-not-converged", "WebGPU matrix-free CG did not converge within maxIterations.", maxIterations, Math.sqrt(dot(r, r)) / rhsNorm);
}

async function createWebGpuOperator(data: Tet4MatrixFreeData, navigatorOverride: unknown): Promise<{ ok: true; multiply: (x: Float32Array) => Promise<Float32Array>; destroy: () => void } | { ok: false; error: { code: string; message: string } }> {
  const navigatorLike = (navigatorOverride ?? globalThis.navigator) as { gpu?: { requestAdapter: () => Promise<any> } } | undefined;
  const adapter = await navigatorLike?.gpu?.requestAdapter?.();
  if (!adapter) return { ok: false, error: { code: "webgpu-unavailable", message: "A WebGPU adapter is required for the matrix-free Tet4 backend." } };
  const device: any = await adapter.requestDevice();
  const usage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
  const buffers: any[] = [];
  const make = (array: ArrayBufferView, flags = usage.STORAGE | usage.COPY_DST) => {
    const buffer = device.createBuffer({ size: Math.max(4, (array.byteLength + 3) & ~3), usage: flags });
    device.queue.writeBuffer(buffer, 0, array.buffer, array.byteOffset, array.byteLength); buffers.push(buffer); return buffer;
  };
  const x = make(new Float32Array(data.dofs));
  const y = make(new Float32Array(data.dofs), usage.STORAGE | usage.COPY_SRC);
  const read = device.createBuffer({ size: data.dofs * 4, usage: usage.MAP_READ | usage.COPY_DST }); buffers.push(read);
  const entries = [x, y, make(data.rowPtr), make(data.adjacencyElements), make(data.adjacencyLocalRows), make(data.connectivity), make(data.elementData), make(data.constrained)]
    .map((buffer, binding) => ({ binding, resource: { buffer } }));
  const module = device.createShaderModule({ code: MATVEC_WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  return {
    ok: true,
    async multiply(vector: Float32Array) {
      device.queue.writeBuffer(x, 0, vector.buffer, vector.byteOffset, vector.byteLength);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(Math.ceil(data.dofs / 128)); pass.end();
      encoder.copyBufferToBuffer(y, 0, read, 0, data.dofs * 4); device.queue.submit([encoder.finish()]);
      await read.mapAsync(1); const result = new Float32Array(read.getMappedRange().slice(0)); read.unmap(); return result;
    },
    destroy() { for (const buffer of buffers) buffer.destroy(); device.destroy?.(); }
  };
}

const MATVEC_WGSL = `
@group(0) @binding(0) var<storage,read> x:array<f32>;
@group(0) @binding(1) var<storage,read_write> y:array<f32>;
@group(0) @binding(2) var<storage,read> rowPtr:array<u32>;
@group(0) @binding(3) var<storage,read> adjElement:array<u32>;
@group(0) @binding(4) var<storage,read> adjLocalRow:array<u32>;
@group(0) @binding(5) var<storage,read> connectivity:array<u32>;
@group(0) @binding(6) var<storage,read> elementData:array<f32>;
@group(0) @binding(7) var<storage,read> constrained:array<u32>;
@compute @workgroup_size(128) fn main(@builtin(global_invocation_id) id:vec3<u32>){let row=id.x;if(row>=arrayLength(&y)){return;}if(constrained[row]!=0u){y[row]=x[row];return;}var total=0.0;for(var slot=rowPtr[row];slot<rowPtr[row+1u];slot++){let e=adjElement[slot];let lr=adjLocalRow[slot];let base=e*15u;var exx=0.0;var eyy=0.0;var ezz=0.0;var gxy=0.0;var gyz=0.0;var gxz=0.0;for(var n=0u;n<4u;n++){let node=connectivity[e*4u+n];let ux=select(x[node*3u],0.0,constrained[node*3u]!=0u);let uy=select(x[node*3u+1u],0.0,constrained[node*3u+1u]!=0u);let uz=select(x[node*3u+2u],0.0,constrained[node*3u+2u]!=0u);let gx=elementData[base+n*3u];let gy=elementData[base+n*3u+1u];let gz=elementData[base+n*3u+2u];exx+=gx*ux;eyy+=gy*uy;ezz+=gz*uz;gxy+=gy*ux+gx*uy;gyz+=gz*uy+gy*uz;gxz+=gz*ux+gx*uz;}let vol=elementData[base+12u];let lam=elementData[base+13u];let mu=elementData[base+14u];let tr=exx+eyy+ezz;let sxx=lam*tr+2.0*mu*exx;let syy=lam*tr+2.0*mu*eyy;let szz=lam*tr+2.0*mu*ezz;let txy=mu*gxy;let tyz=mu*gyz;let txz=mu*gxz;let n=lr/3u;let component=lr%3u;let gx=elementData[base+n*3u];let gy=elementData[base+n*3u+1u];let gz=elementData[base+n*3u+2u];if(component==0u){total+=vol*(gx*sxx+gy*txy+gz*txz);}else if(component==1u){total+=vol*(gy*syy+gx*txy+gz*tyz);}else{total+=vol*(gz*szz+gy*tyz+gx*txz);}}y[row]=total;}`;

function tet4Geometry(coordinates: Float64Array | Float32Array, nodes: Uint32Array): { gradients: Float32Array; volume: number } {
  const a = point(coordinates, nodes[0]), b = point(coordinates, nodes[1]), c = point(coordinates, nodes[2]), d = point(coordinates, nodes[3]);
  const j = [b[0]-a[0],c[0]-a[0],d[0]-a[0],b[1]-a[1],c[1]-a[1],d[1]-a[1],b[2]-a[2],c[2]-a[2],d[2]-a[2]];
  const determinant = det3(j); if (!(determinant > 1e-20)) throw new Error("Tet4 element must have positive finite volume.");
  const inv = invert3(j, determinant), reference = [[-1,-1,-1],[1,0,0],[0,1,0],[0,0,1]], gradients = new Float32Array(12);
  for(let n=0;n<4;n++){const r=reference[n];gradients[n*3]=inv[0]*r[0]+inv[3]*r[1]+inv[6]*r[2];gradients[n*3+1]=inv[1]*r[0]+inv[4]*r[1]+inv[7]*r[2];gradients[n*3+2]=inv[2]*r[0]+inv[5]*r[1]+inv[8]*r[2];}
  return { gradients, volume: determinant / 6 };
}
function elementInternalForce(data: Float32Array, u: Float32Array): Float32Array {let exx=0,eyy=0,ezz=0,gxy=0,gyz=0,gxz=0;for(let n=0;n<4;n++){const gx=data[n*3],gy=data[n*3+1],gz=data[n*3+2],ux=u[n*3],uy=u[n*3+1],uz=u[n*3+2];exx+=gx*ux;eyy+=gy*uy;ezz+=gz*uz;gxy+=gy*ux+gx*uy;gyz+=gz*uy+gy*uz;gxz+=gz*ux+gx*uz;}const vol=data[12],lambda=data[13],mu=data[14],tr=exx+eyy+ezz,sxx=lambda*tr+2*mu*exx,syy=lambda*tr+2*mu*eyy,szz=lambda*tr+2*mu*ezz,txy=mu*gxy,tyz=mu*gyz,txz=mu*gxz,out=new Float32Array(12);for(let n=0;n<4;n++){const gx=data[n*3],gy=data[n*3+1],gz=data[n*3+2];out[n*3]=vol*(gx*sxx+gy*txy+gz*txz);out[n*3+1]=vol*(gy*syy+gx*txy+gz*tyz);out[n*3+2]=vol*(gz*szz+gy*tyz+gx*txz);}return out;}
function point(c: Float64Array | Float32Array,n:number):[number,number,number]{return[c[n*3],c[n*3+1],c[n*3+2]];} function det3(m:number[]):number{return m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);} function invert3(m:number[],d:number):number[]{return[(m[4]*m[8]-m[5]*m[7])/d,(m[2]*m[7]-m[1]*m[8])/d,(m[1]*m[5]-m[2]*m[4])/d,(m[5]*m[6]-m[3]*m[8])/d,(m[0]*m[8]-m[2]*m[6])/d,(m[2]*m[3]-m[0]*m[5])/d,(m[3]*m[7]-m[4]*m[6])/d,(m[1]*m[6]-m[0]*m[7])/d,(m[0]*m[4]-m[1]*m[3])/d];} function dot(a:Float32Array,b:Float32Array):number{let v=0;for(let i=0;i<a.length;i++)v+=a[i]*b[i];return v;} function failure(code:string,message:string,iterations:number,relativeResidual:number):MatrixFreeCgResult{return{ok:false,error:{code,message},iterations,relativeResidual};}
