/**
 * OpenCAE UI Copy
 * Drop in at: apps/opencae-web/src/copy/strings.ts
 *
 * Single source of truth for user-facing text. Import from components —
 * never inline strings in JSX. This centralizes tone, makes i18n feasible
 * later, and enforces consistency (sentence case, direct imperatives).
 *
 * Tone guide:
 *   - Sentence case always
 *   - Imperative for primary actions ("Run simulation")
 *   - Direct 2nd-person for guidance ("Choose where...")
 *   - Plain English in user-facing logs, engineering register in solver logs
 */

export const COPY = {
  // ─── Brand ──────────────────────────────────────────────
  brand: {
    name: 'OpenCAE',
    tagline: 'open structural simulation',
    version: 'v0.1.0-mvp',
    mode: 'local mode',
  },

  // ─── Start screen ───────────────────────────────────────
  start: {
    primaryCta: 'Load sample project',
    primarySubtitle: 'Bracket demo · full workflow preview',
    newProject: 'Create new project',
    openProject: 'Open local project',
    shortcuts: { new: 'N', open: 'O' },
    caption:
      'OpenCAE helps you test how parts respond to forces. ' +
      'Start with the sample project to see a complete example.',
    footerLeft: './data/artifacts · SQLite · in-memory jobs',
    footerRight: 'docs · examples · github',
  },

  // ─── Top bar ────────────────────────────────────────────
  topbar: {
    runBtn: 'Run simulation',
    runBtnRunning: 'Running…',
    localPill: 'local',
    tooltips: {
      undo: 'Undo',
      redo: 'Redo',
      settings: 'Settings',
    },
  },

  // ─── Step bar ───────────────────────────────────────────
  steps: {
    header: 'workflow',
    labels: {
      model: 'Model',
      material: 'Material',
      supports: 'Supports',
      loads: 'Loads',
      mesh: 'Mesh',
      run: 'Run',
      results: 'Results',
    },
    footer: {
      study: { key: 'study', value: 'static' },
      units: { key: 'units', value: 'SI · mm' },
      backend: { key: 'backend', value: 'mock' },
    },
  },

  // ─── Viewer overlays ────────────────────────────────────
  viewer: {
    viewModes: { model: 'Model', mesh: 'Mesh', result: 'Result' },
    legend: {
      stress: { title: 'Von Mises stress', unit: 'MPa' },
      displacement: { title: 'Total displacement', unit: 'mm' },
      safetyFactor: { title: 'Safety factor', unit: '' },
      maxLabel: 'max',
    },
    fitTooltip: 'Fit to view',
    viewCubeDefault: 'TOP',
  },

  // ─── Context panel — per step ───────────────────────────
  panels: {
    model: {
      eyebrow: 'Step 1 of 7',
      title: 'Model',
      guidance:
        'Inspect the 3D part. Orbit with left-drag, pan with right-drag, zoom with scroll.',
      sampleLabel: 'Sample model',
      fitView: 'Fit view',
      toggleMesh: 'Toggle mesh',
      preconfigured: 'Preconfigured',
    },

    material: {
      eyebrow: 'Step 2 of 7',
      title: 'Material',
      guidance: 'Choose what the part is made of.',
      librarySelect: 'Material library',
      apply: (sampleName: string) => `Apply to ${sampleName.toLowerCase()}`,
      assigned: 'Assigned',
    },

    supports: {
      eyebrow: 'Step 3 of 7',
      title: 'Supports',
      guidance: 'Choose where the part is held fixed. Select a face, then click add.',
      addFixedBtn: 'Add fixed support',
      appliedSection: 'Applied',
      helper: 'Fixed supports prevent any motion of the selected face.',
    },

    loads: {
      eyebrow: 'Step 4 of 7',
      title: 'Loads',
      guidance: 'Choose where force or pressure is applied. Select a face, then add a load.',
      typeLabel: 'Load type',
      magnitudeLabel: 'Magnitude',
      directionLabel: 'Direction',
      addBtn: 'Add load',
      appliedSection: 'Applied',
    },

    mesh: {
      eyebrow: 'Step 5 of 7',
      title: 'Mesh',
      guidance:
        'The mesh breaks the model into small pieces so OpenCAE can calculate results.',
      presetLabel: 'Quality preset',
      generateBtn: 'Generate mesh',
      summarySection: 'Mesh summary',
      helperDefault: 'Medium creates a good balance between accuracy and speed.',
      helperSummary: (size: number) =>
        `Mesh type: 2nd-order tetrahedra · element size ≈ ${size} mm`,
    },

    run: {
      eyebrow: 'Step 6 of 7',
      title: 'Run',
      guidance: 'Run the simulation to estimate stress and displacement.',
      readinessSection: 'Readiness',
      checklist: {
        material: 'Material assigned',
        supports: 'Support added',
        loads: 'Load added',
        mesh: 'Mesh generated',
      },
      runBtn: 'Run simulation',
      runningBtn: 'Running…',
      solverSection: 'Solver',
      solverInfo: {
        backend: 'Backend',
        backendValue: 'local-heuristic-surface',
        version: 'Version',
        versionValue: '0.1.0',
        runner: 'Runner',
        runnerValue: 'local-in-memory',
      },
    },

    results: {
      eyebrow: 'Step 7 of 7',
      title: 'Results',
      guidance: 'View stress and displacement directly on the 3D model.',
      fieldLabel: 'Result field',
      fieldOptions: {
        stress: 'Stress',
        displacement: 'Displacement',
        safetyFactor: 'Safety factor',
      },
      summarySection: 'Summary',
      metrics: {
        maxStress: 'Max stress',
        maxDisp: 'Max displacement',
        safety: 'Safety factor',
        reaction: 'Reaction force',
      },
      helper: 'Red areas have higher stress. Blue areas have lower stress.',
      displaySection: 'Display',
      undeformed: 'Undeformed',
      deformed: 'Deformed ×10',
      emptyState: 'Run the simulation first to see results here.',
      emptyCta: 'Go to run',
    },
  },

  // ─── Status bar ─────────────────────────────────────────
  statusbar: {
    tabs: {
      status: 'Status',
      tips: 'Tips',
      logs: 'Logs',
      diagnostics: 'Diagnostics',
    },
    states: {
      ready: 'Ready',
      simulating: 'Simulating',
      resultsReady: 'Results ready',
      warning: 'Needs attention',
    },
    keys: {
      project: 'project',
      study: 'study',
      mesh: 'mesh',
      solver: 'solver',
      mockBackend: 'local solver',
    },
    values: {
      meshNone: 'Not generated',
      meshReady: 'Ready',
      solverIdle: 'Idle',
      solverRunning: 'Running',
      solverComplete: 'Complete',
    },
  },

  // ─── User-facing log messages (plain language) ──────────
  logs: {
    sampleLoaded: 'Sample project loaded.',
    projectOpened: (name: string) => `Project "${name}" opened in local mode.`,
    sampleSwitched: (name: string) => `Sample switched to "${name}".`,
    materialAssigned: (name: string) => `Material assigned: ${name}`,
    supportAdded: (face: string) => `Fixed support added on ${face}`,
    loadAdded: (type: string, value: number, unit: string, face: string) =>
      `${type} of ${value} ${unit} added on ${face}`,
    meshStarting: (preset: string) => `Starting mesh generation · preset=${preset}`,
    meshGenerated: (nodes: number, elements: number) =>
      `Mesh generated: ${nodes.toLocaleString()} nodes, ${elements.toLocaleString()} tetra elements`,
  },

  // ─── Solver log messages (engineering register) ─────────
  // Paired with progress percentages for the streaming run flow
  solverLog: [
    { pct: 0,   level: 'info' as const, msg: 'Local static solver started' },
    { pct: 12,  level: 'info' as const, msg: 'Assembling global stiffness matrix' },
    { pct: 28,  level: 'info' as const, msg: 'Assembly complete · 42,381 DOFs' },
    { pct: 45,  level: 'info' as const, msg: 'Applying boundary conditions' },
    { pct: 62,  level: 'info' as const, msg: 'Solving K·u = f · conjugate gradient' },
    { pct: 82,  level: 'info' as const, msg: 'Computing element stresses' },
    { pct: 95,  level: 'info' as const, msg: 'Post-processing results' },
    { pct: 100, level: 'ok'   as const, msg: 'Local static solve complete' },
  ],

  // ─── Selection indicator (viewer top-left glass chip) ───
  selection: {
    bracketDefault: (bodies: number, faces: number) => `Bracket · ${bodies} body · ${faces} faces`,
    generic: (name: string, bodies: number, faces: number) =>
      `${name} · ${bodies} body · ${faces} faces`,
  },
};

// ─── Material library ──────────────────────────────────────
// Kept here because the values appear in UI; if this grows past
// a handful of entries, move into libs/opencae-materials.

export const MATERIALS = {
  'Aluminum 6061': {
    youngsModulus: '68,900',
    youngsModulusUnit: 'MPa',
    poissonRatio: '0.33',
    density: '2,700',
    densityUnit: 'kg/m³',
    yieldStrength: '276',
    yieldStrengthUnit: 'MPa',
  },
  'Steel': {
    youngsModulus: '210,000',
    youngsModulusUnit: 'MPa',
    poissonRatio: '0.30',
    density: '7,850',
    densityUnit: 'kg/m³',
    yieldStrength: '250',
    yieldStrengthUnit: 'MPa',
  },
  'ABS Plastic': {
    youngsModulus: '2,100',
    youngsModulusUnit: 'MPa',
    poissonRatio: '0.37',
    density: '1,050',
    densityUnit: 'kg/m³',
    yieldStrength: '41',
    yieldStrengthUnit: 'MPa',
  },
} as const;

// ─── Mesh presets ──────────────────────────────────────────

export const MESH_PRESETS = {
  Coarse: { nodes: 6_412,   elements: 3_812,   quality: 0.42, size: 4.0, warnings: 0 },
  Medium: { nodes: 42_381,  elements: 26_944,  quality: 0.58, size: 2.0, warnings: 0 },
  Fine:   { nodes: 131_204, elements: 88_702,  quality: 0.71, size: 1.0, warnings: 2 },
} as const;
