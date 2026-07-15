import type { NormalizedOpenCAEModel } from "@opencae/core";
import { collectTetCoordinates } from "./element";
import { computeTet10Volume } from "./element-tet10";
import { computeTet4Geometry } from "./geometry";
import { collectElementCoordinates, elementNodeCountForBlock } from "./solver";

export function recoverNodalVonMisesFromElements(
  model: NormalizedOpenCAEModel,
  elementVonMises: ArrayLike<number>
): Float64Array {
  const nodalSum = new Float64Array(model.counts.nodes);
  const nodalWeight = new Float64Array(model.counts.nodes);
  let elementIndex = 0;

  for (const block of model.elementBlocks) {
    const nodesPerElement = elementNodeCountForBlock(block);
    if (nodesPerElement === undefined) continue;

    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += nodesPerElement) {
      let weight = 1;
      if (block.type === "Tet4") {
        const geometry = computeTet4Geometry(collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset));
        if (geometry.ok) weight = geometry.volume;
      } else {
        const volume = computeTet10Volume(
          collectElementCoordinates(model.nodes.coordinates, block.connectivity, elementOffset, nodesPerElement)
        );
        if (volume.ok) weight = volume.volume;
      }
      const value = elementVonMises[elementIndex] ?? 0;

      for (let localNode = 0; localNode < nodesPerElement; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        nodalSum[node] += value * weight;
        nodalWeight[node] += weight;
      }
      elementIndex += 1;
    }
  }

  const nodalVonMises = new Float64Array(model.counts.nodes);
  for (let node = 0; node < nodalVonMises.length; node += 1) {
    nodalVonMises[node] = nodalWeight[node] > 0 ? nodalSum[node] / nodalWeight[node] : 0;
  }
  return nodalVonMises;
}

/**
 * Volume-weight a six-component element stress tensor onto mesh nodes. The
 * component order is [xx, yy, zz, xy, yz, xz], matching the constitutive and
 * von Mises recovery paths. Components are averaged before any nonlinear
 * principal-stress measure is evaluated.
 */
export function recoverNodalStressTensorsFromElements(
  model: NormalizedOpenCAEModel,
  elementStress: ArrayLike<number>
): Float64Array {
  const componentCount = 6;
  const nodalSum = new Float64Array(model.counts.nodes * componentCount);
  const nodalWeight = new Float64Array(model.counts.nodes);
  let elementIndex = 0;

  for (const block of model.elementBlocks) {
    const nodesPerElement = elementNodeCountForBlock(block);
    if (nodesPerElement === undefined) continue;
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += nodesPerElement) {
      let weight = 1;
      if (block.type === "Tet4") {
        const geometry = computeTet4Geometry(collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset));
        if (geometry.ok) weight = geometry.volume;
      } else {
        const volume = computeTet10Volume(
          collectElementCoordinates(model.nodes.coordinates, block.connectivity, elementOffset, nodesPerElement)
        );
        if (volume.ok) weight = volume.volume;
      }
      for (let localNode = 0; localNode < nodesPerElement; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        nodalWeight[node] += weight;
        for (let component = 0; component < componentCount; component += 1) {
          nodalSum[node * componentCount + component] += (elementStress[elementIndex * componentCount + component] ?? 0) * weight;
        }
      }
      elementIndex += 1;
    }
  }

  for (let node = 0; node < model.counts.nodes; node += 1) {
    const weight = nodalWeight[node];
    if (!(weight > 0)) continue;
    for (let component = 0; component < componentCount; component += 1) {
      nodalSum[node * componentCount + component] /= weight;
    }
  }
  return nodalSum;
}
