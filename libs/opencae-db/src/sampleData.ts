import type { DisplayModel, Material, Project, ResultField, ResultSummary } from "@opencae/schema";

const now = "2026-04-24T12:00:00.000Z";

export const bracketDemoMaterial: Material = {
  id: "mat-aluminum-6061",
  name: "Aluminum 6061",
  youngsModulus: 68900000000,
  poissonRatio: 0.33,
  density: 2700,
  yieldStrength: 276000000
};

export const bracketDisplayModel: DisplayModel = {
  id: "display-bracket-demo",
  name: "Bracket demo body",
  bodyCount: 1,
  dimensions: { x: 120, y: 88, z: 34, units: "mm" },
  faces: [
    { id: "face-base-left", label: "Base mounting holes", color: "#4da3ff", center: [0.65, 0.02, 0.58], normal: [0, 0, 1], stressValue: 36 },
    { id: "face-load-top", label: "Top load face", color: "#f59e0b", center: [-1.18, 2.53, 0], normal: [0, 1, 0], stressValue: 142 },
    { id: "face-web-front", label: "Brace face", color: "#22c55e", center: [-0.38, 0.86, 0.42], normal: [0, 0, 1], stressValue: 96 },
    { id: "face-base-bottom", label: "Base top face", color: "#8b949e", center: [0.45, 0.24, 0], normal: [0, 1, 0], stressValue: 54 }
  ]
};

export const bracketResultSummary: ResultSummary = {
  maxStress: 142,
  maxStressUnits: "MPa",
  maxDisplacement: 0.184,
  maxDisplacementUnits: "mm",
  safetyFactor: 1.8,
  reactionForce: 500,
  reactionForceUnits: "N"
};

export const bracketResultFields: ResultField[] = [
  {
    id: "field-stress-bracket",
    runId: "run-bracket-demo-seeded",
    type: "stress",
    location: "face",
    values: [36, 142, 96, 54],
    min: 28,
    max: 142,
    units: "MPa"
  },
  {
    id: "field-displacement-bracket",
    runId: "run-bracket-demo-seeded",
    type: "displacement",
    location: "face",
    values: [0.012, 0.184, 0.116, 0.041],
    min: 0,
    max: 0.184,
    units: "mm"
  },
  {
    id: "field-safety-factor-bracket",
    runId: "run-bracket-demo-seeded",
    type: "safety_factor",
    location: "face",
    values: [7.6, 1.8, 2.8, 5.1],
    min: 1.8,
    max: 7.6,
    units: ""
  }
];

export const bracketDemoProject: Project = {
  id: "project-bracket-demo",
  name: "Bracket Demo",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [
    {
      id: "geom-bracket-demo",
      projectId: "project-bracket-demo",
      filename: "bracket-demo.step",
      localPath: "examples/bracket-demo/bracket-demo.step",
      artifactKey: "project-bracket-demo/geometry/bracket-display.json",
      status: "ready",
      metadata: {
        displayModelRef: "project-bracket-demo/geometry/bracket-display.json",
        bodyCount: 1,
        faceCount: 4
      }
    }
  ],
  studies: [
    {
      id: "study-bracket-static",
      projectId: "project-bracket-demo",
      name: "Static Stress",
      type: "static_stress",
      geometryScope: [{ bodyId: "body-bracket", entityType: "body", entityId: "body-bracket", label: "Bracket" }],
      materialAssignments: [
        {
          id: "assign-aluminum",
          materialId: "mat-aluminum-6061",
          selectionRef: "selection-body-bracket",
          status: "complete"
        }
      ],
      namedSelections: [
        {
          id: "selection-body-bracket",
          name: "Bracket body",
          entityType: "body",
          geometryRefs: [{ bodyId: "body-bracket", entityType: "body", entityId: "body-bracket", label: "Bracket" }],
          fingerprint: "body-bracket-v1"
        },
        {
          id: "selection-fixed-face",
          name: "Fixed base mounting holes",
          entityType: "face",
          geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: "face-base-left", label: "Base mounting holes" }],
          fingerprint: "face-base-left-v1"
        },
        {
          id: "selection-load-face",
          name: "Top load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: "face-load-top", label: "Top load face" }],
          fingerprint: "face-load-top-v1"
        },
        {
          id: "selection-web-face",
          name: "Brace face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: "face-web-front", label: "Brace face" }],
          fingerprint: "face-web-front-v1"
        },
        {
          id: "selection-base-face",
          name: "Base top face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: "face-base-bottom", label: "Base top face" }],
          fingerprint: "face-base-bottom-v1"
        }
      ],
      contacts: [],
      constraints: [
        {
          id: "constraint-fixed-mount",
          type: "fixed",
          selectionRef: "selection-fixed-face",
          parameters: {},
          status: "complete"
        }
      ],
      loads: [
        {
          id: "load-downward-force",
          type: "force",
          selectionRef: "selection-load-face",
          parameters: { value: 500, units: "N", direction: [0, -1, 0] },
          status: "complete"
        }
      ],
      meshSettings: {
        preset: "medium",
        status: "complete",
        meshRef: "project-bracket-demo/mesh/mesh-summary.json",
        summary: {
          nodes: 42381,
          elements: 26944,
          warnings: ["Small feature simplified for the mock mesh."]
        }
      },
      solverSettings: {
        analysisType: "linear_static",
        smallDisplacement: true
      },
      validation: [],
      runs: [
        {
          id: "run-bracket-demo-seeded",
          studyId: "study-bracket-static",
          status: "complete",
          jobId: "job-bracket-demo-seeded",
          meshRef: "project-bracket-demo/mesh/mesh-summary.json",
          resultRef: "project-bracket-demo/results/results.json",
          reportRef: "project-bracket-demo/reports/report.html",
          solverBackend: "local-mock",
          solverVersion: "0.1.0",
          startedAt: now,
          finishedAt: now,
          diagnostics: []
        }
      ]
    }
  ],
  createdAt: now,
  updatedAt: now
};
