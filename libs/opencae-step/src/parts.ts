/**
 * Parametric part catalog.
 *
 * Each part turns a handful of millimetre dimensions into a STEP file built
 * from exact analytic solids, so the exported geometry stays smooth and
 * dimension-editable in any downstream CAD package.
 */

import { addBoxSolid, addCylinderSolid, addTorusSolid } from "./brep";
import { buildStepDocument, type StepWriter } from "./writer";

export type ParametricPartId = "coat-hook" | "cylinder" | "ring" | "plate";

export interface ParametricPartParameter {
  key: string;
  label: string;
  description: string;
  defaultMm: number;
  minMm: number;
  maxMm: number;
}

export interface ParametricPartDefinition {
  id: ParametricPartId;
  label: string;
  /** One-line description shown next to the part picker. */
  summary: string;
  /** Names of the solid bodies the part exports. */
  bodyNames: readonly string[];
  parameters: readonly ParametricPartParameter[];
}

const RING_PARAMETERS: readonly ParametricPartParameter[] = [
  {
    key: "ringOuterDiameter",
    label: "Ring outer diameter",
    description: "Overall diameter of the ring, measured across the outside of the tube.",
    defaultMm: 64,
    minMm: 4,
    maxMm: 500
  },
  {
    key: "ringTubeDiameter",
    label: "Ring tube diameter",
    description: "Diameter of the ring's round cross-section.",
    defaultMm: 16,
    minMm: 1,
    maxMm: 120
  }
];

export const PARAMETRIC_PARTS: readonly ParametricPartDefinition[] = [
  {
    id: "coat-hook",
    label: "Support-free coat hook",
    summary: "A ring resting on the build plate with a cylindrical boss through its centre. Two analytic bodies sized to overlap.",
    bodyNames: ["Ring", "Boss"],
    parameters: [
      ...RING_PARAMETERS,
      {
        key: "bossDiameter",
        label: "Boss diameter",
        description: "Diameter of the centre cylinder. Keep it larger than the ring's centre hole so the bodies fuse when printed.",
        defaultMm: 34,
        minMm: 1,
        maxMm: 300
      },
      {
        key: "bossHeight",
        label: "Boss height",
        description: "Height of the centre cylinder above the build plate.",
        defaultMm: 36,
        minMm: 1,
        maxMm: 500
      }
    ]
  },
  {
    id: "cylinder",
    label: "Cylinder",
    summary: "A solid cylinder standing on the build plate.",
    bodyNames: ["Cylinder"],
    parameters: [
      {
        key: "diameter",
        label: "Diameter",
        description: "Cylinder diameter.",
        defaultMm: 34,
        minMm: 0.5,
        maxMm: 500
      },
      {
        key: "height",
        label: "Height",
        description: "Cylinder height.",
        defaultMm: 36,
        minMm: 0.5,
        maxMm: 500
      }
    ]
  },
  {
    id: "ring",
    label: "Ring",
    summary: "A solid torus resting on the build plate.",
    bodyNames: ["Ring"],
    parameters: RING_PARAMETERS
  },
  {
    id: "plate",
    label: "Plate",
    summary: "A rectangular plate centred on the origin.",
    bodyNames: ["Plate"],
    parameters: [
      {
        key: "width",
        label: "Width",
        description: "Plate size along X.",
        defaultMm: 120,
        minMm: 1,
        maxMm: 1000
      },
      {
        key: "depth",
        label: "Depth",
        description: "Plate size along Y.",
        defaultMm: 80,
        minMm: 1,
        maxMm: 1000
      },
      {
        key: "thickness",
        label: "Thickness",
        description: "Plate size along Z.",
        defaultMm: 8,
        minMm: 0.4,
        maxMm: 200
      }
    ]
  }
];

export function parametricPartFor(partId: ParametricPartId): ParametricPartDefinition {
  const part = PARAMETRIC_PARTS.find((candidate) => candidate.id === partId);
  if (!part) {
    throw new Error(`Unknown parametric part "${partId}".`);
  }
  return part;
}

export function defaultPartParameters(partId: ParametricPartId): Record<string, number> {
  return Object.fromEntries(parametricPartFor(partId).parameters.map((parameter) => [parameter.key, parameter.defaultMm]));
}

/** Returns human-readable problems with the given dimensions; empty when valid. */
export function validatePartParameters(partId: ParametricPartId, values: Record<string, number>): string[] {
  const part = parametricPartFor(partId);
  const problems: string[] = [];
  for (const parameter of part.parameters) {
    const value = values[parameter.key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`Enter a value for ${parameter.label.toLowerCase()}.`);
      continue;
    }
    if (value < parameter.minMm || value > parameter.maxMm) {
      problems.push(`${parameter.label} must be between ${parameter.minMm} mm and ${parameter.maxMm} mm.`);
    }
  }
  const outer = values.ringOuterDiameter;
  const tube = values.ringTubeDiameter;
  if (
    (partId === "ring" || partId === "coat-hook") &&
    typeof outer === "number" &&
    typeof tube === "number" &&
    Number.isFinite(outer) &&
    Number.isFinite(tube) &&
    tube * 2 >= outer
  ) {
    problems.push("Ring tube diameter must be less than half the outer diameter so the ring keeps a centre hole.");
  }
  return problems;
}

/** Reads a validated dimension; throws if absent so callers stay total. */
function dimension(values: Record<string, number>, key: string): number {
  const value = values[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing dimension "${key}".`);
  }
  return value;
}

export interface ParametricPartStepFile {
  filename: string;
  partName: string;
  stepText: string;
  bodyCount: number;
}

export interface BuildParametricPartOptions {
  /** Header timestamp; defaults to now. */
  createdAt?: Date;
}

/**
 * Builds the STEP file for a part. Throws when the dimensions fail
 * `validatePartParameters`.
 */
export function buildParametricPartStep(
  partId: ParametricPartId,
  values: Record<string, number> = defaultPartParameters(partId),
  options: BuildParametricPartOptions = {}
): ParametricPartStepFile {
  const problems = validatePartParameters(partId, values);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }
  const part = parametricPartFor(partId);
  const filename = partStepFilename(partId, values);
  const stepText = buildStepDocument({
    partName: part.label,
    filename,
    description: `OpenCAE parametric part: ${part.label}`,
    createdAt: options.createdAt,
    buildSolids: (writer) => buildSolidsForPart(partId, values, writer)
  });
  return { filename, partName: part.label, stepText, bodyCount: part.bodyNames.length };
}

export function partStepFilename(partId: ParametricPartId, values: Record<string, number>): string {
  const mm = (key: string) => formatMmForFilename(dimension(values, key));
  switch (partId) {
    case "coat-hook":
      return `support-free-coat-hook-${mm("ringOuterDiameter")}x${mm("bossHeight")}mm.step`;
    case "cylinder":
      return `cylinder-${mm("diameter")}x${mm("height")}mm.step`;
    case "ring":
      return `ring-${mm("ringOuterDiameter")}x${mm("ringTubeDiameter")}mm.step`;
    case "plate":
      return `plate-${mm("width")}x${mm("depth")}x${mm("thickness")}mm.step`;
  }
}

function buildSolidsForPart(partId: ParametricPartId, values: Record<string, number>, writer: StepWriter): number[] {
  switch (partId) {
    case "coat-hook": {
      const tubeRadius = dimension(values, "ringTubeDiameter") / 2;
      return [
        addTorusSolid(writer, {
          name: "Ring",
          center: [0, 0, tubeRadius],
          majorRadius: (dimension(values, "ringOuterDiameter") - dimension(values, "ringTubeDiameter")) / 2,
          minorRadius: tubeRadius
        }),
        addCylinderSolid(writer, {
          name: "Boss",
          baseCenter: [0, 0, 0],
          radius: dimension(values, "bossDiameter") / 2,
          height: dimension(values, "bossHeight")
        })
      ];
    }
    case "cylinder":
      return [
        addCylinderSolid(writer, {
          name: "Cylinder",
          baseCenter: [0, 0, 0],
          radius: dimension(values, "diameter") / 2,
          height: dimension(values, "height")
        })
      ];
    case "ring": {
      const tubeRadius = dimension(values, "ringTubeDiameter") / 2;
      return [
        addTorusSolid(writer, {
          name: "Ring",
          center: [0, 0, tubeRadius],
          majorRadius: (dimension(values, "ringOuterDiameter") - dimension(values, "ringTubeDiameter")) / 2,
          minorRadius: tubeRadius
        })
      ];
    }
    case "plate":
      return [
        addBoxSolid(writer, {
          name: "Plate",
          corner: [-dimension(values, "width") / 2, -dimension(values, "depth") / 2, 0],
          size: [dimension(values, "width"), dimension(values, "depth"), dimension(values, "thickness")]
        })
      ];
  }
}

function formatMmForFilename(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}
