export type LinearElasticMaterialInput = {
  youngModulus: number;
  poissonRatio: number;
};

export function computeLinearElasticDMatrix(material: LinearElasticMaterialInput): Float64Array {
  const { youngModulus, poissonRatio } = material;
  const lambda =
    (youngModulus * poissonRatio) / ((1 + poissonRatio) * (1 - 2 * poissonRatio));
  const mu = youngModulus / (2 * (1 + poissonRatio));
  const d = new Float64Array(36);

  d[0] = lambda + 2 * mu;
  d[1] = lambda;
  d[2] = lambda;
  d[6] = lambda;
  d[7] = lambda + 2 * mu;
  d[8] = lambda;
  d[12] = lambda;
  d[13] = lambda;
  d[14] = lambda + 2 * mu;
  d[21] = mu;
  d[28] = mu;
  d[35] = mu;

  return d;
}
