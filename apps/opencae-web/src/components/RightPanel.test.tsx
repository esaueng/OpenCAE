import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { bracketDisplayModel } from "@opencae/db/sample-data";
import type { DisplayModel, Project, ResultField, ResultSummary, Study } from "@opencae/schema";
import { editableNumberCommitValue, playbackPeakMarkerPercent, RightPanel, rangeProgressPercent } from "./RightPanel";
import type { StepId } from "./StepBar";
import type { StepGeometryMetadata } from "../lib/api";

const project: Project = {
  id: "project-1",
  name: "Payload project",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const displayModel: DisplayModel = {
  id: "display-uploaded",
  name: "Fixture imported body",
  bodyCount: 1,
  faces: [{ id: "face-top", label: "Top face", color: "#4da3ff", center: [0, 0, 0], normal: [0, 0, 1], stressValue: 0 }]
};

const study: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Fixture body" }],
  materialAssignments: [],
  namedSelections: [{
    id: "selection-top",
    name: "Top face",
    entityType: "face",
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: "face-top", label: "Top face" }],
    fingerprint: "face-top"
  }],
  contacts: [],
  constraints: [],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
};

const resultSummary: ResultSummary = {
  maxStress: 0,
  maxStressUnits: "MPa",
  maxDisplacement: 0,
  maxDisplacementUnits: "mm",
  safetyFactor: 0,
  reactionForce: 0,
  reactionForceUnits: "N"
};

function renderPanel(activeStep: StepId, overrides: Partial<Parameters<typeof RightPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <RightPanel
      activeStep={activeStep}
      project={project}
      displayModel={displayModel}
      study={study}
      selectedFace={null}
      viewMode="model"
      resultMode="stress"
      showDeformed={false}
      showDimensions={false}
      stressExaggeration={1}
      resultSummary={resultSummary}
      runProgress={0}
      runTiming={null}
      sampleModel="bracket"
      sampleAnalysisType="static_stress"
      draftLoadType="force"
      draftLoadValue={500}
      draftLoadDirection="-Z"
      selectedLoadPoint={null}
      selectedPayloadObject={null}
      onFitView={vi.fn()}
      onRotateModel={vi.fn()}
      onResetModelOrientation={vi.fn()}
      onLoadSample={vi.fn()}
      onUploadModel={vi.fn()}
      onSampleModelChange={vi.fn()}
      onSampleAnalysisTypeChange={vi.fn()}
      onViewModeChange={vi.fn()}
      onResultModeChange={vi.fn()}
      onToggleDeformed={vi.fn()}
      onToggleDimensions={vi.fn()}
      onStressExaggerationChange={vi.fn()}
      onAssignMaterial={vi.fn()}
      onAddSupport={vi.fn()}
      onUpdateSupport={vi.fn()}
      onRemoveSupport={vi.fn()}
      onDraftLoadTypeChange={vi.fn()}
      onDraftLoadValueChange={vi.fn()}
      onDraftLoadDirectionChange={vi.fn()}
      onAddLoad={vi.fn()}
      onUpdateLoad={vi.fn()}
      onPreviewLoadEdit={vi.fn()}
      onRemoveLoad={vi.fn()}
      onGenerateMesh={vi.fn()}
      onCancelMesh={vi.fn()}
      onRunSimulation={vi.fn()}
      onCancelSimulation={vi.fn()}
      canRunSimulation={false}
      missingRunItems={[]}
      resultPlaybackPlaying={false}
      resultPlaybackFps={12}
      resultPlaybackReverseLoop={false}
      onResultPlaybackToggle={vi.fn()}
      onResultPlaybackFpsChange={vi.fn()}
      onResultPlaybackReverseLoopChange={vi.fn()}
      onStepSelect={vi.fn()}
      {...overrides}
    />
  );
}

function uploadedStepProject(status: StepGeometryMetadata["status"], message?: string): Project {
  return {
    ...project,
    geometryFiles: [{
      id: "geom-upload",
      projectId: project.id,
      filename: "fixture.step",
      localPath: "uploads/fixture.step",
      artifactKey: "project-1/geometry/uploaded-display.json",
      status: "ready",
      metadata: {
        source: "local-upload",
        stepGeometry: { status, message }
      }
    }]
  };
}

describe("RightPanel payload mass controls", () => {
  test("offers the opposite face normal as a load direction", () => {
    const markup = renderPanel("loads");

    expect(markup).toContain('<option value="Opposite normal">Opposite face normal</option>');
  });

  test("maps range slider values to a full visual fill at the maximum", () => {
    expect(rangeProgressPercent(1, 1, 4)).toBe(0);
    expect(rangeProgressPercent(2.5, 1, 4)).toBe(50);
    expect(rangeProgressPercent(4, 1, 4)).toBe(100);
    expect(rangeProgressPercent(5, 1, 4)).toBe(100);
  });

  test("sets the result exaggeration slider fill to the current value", () => {
    const markup = renderPanel("results", { stressExaggeration: 4 });

    expect(markup).toContain("--range-progress:100%");
  });

  test("shows result provenance labels in result metadata", () => {
    const coreHtml = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        provenance: { kind: "opencae_core_fea", solver: "opencae-core-cloud", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" }
      }
    });

    expect(coreHtml).toContain("OpenCAE Core Cloud");
    expect(coreHtml).not.toContain("Core solver version");
    expect(coreHtml).not.toContain("Core model schema version");
    expect(coreHtml).toContain("Mesh source");
    expect(coreHtml).toContain("Actual volume mesh");
    expect(coreHtml).toContain("Solver method");
    expect(coreHtml).toContain("sparse_static");
    expect(coreHtml).toContain("Runner");
    expect(coreHtml).toContain("cloud container");
    expect(coreHtml).not.toContain("Local fallback");
  });

  test("uses the concise local result label and places legend labels at their matching ends", () => {
    const html = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          runnerVersion: "browser-0.2.0",
          meshSource: "actual_volume_mesh",
          resultSource: "computed",
          units: "mm-N-s-MPa"
        }
      }
    });

    expect(html).toContain("Local (in-browser)");
    expect(html).not.toContain("OpenCAE Core Local (in-browser)");
    expect(html).toContain('<div class="legend"><small>Low</small><span></span><small>High</small></div>');
  });

  test("renders a missing-unit diagnostic instead of undefined result units", () => {
    const html = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        maxStress: 39,
        maxStressUnits: undefined,
        maxDisplacement: 0.5,
        maxDisplacementUnits: undefined,
        reactionForce: 500,
        reactionForceUnits: undefined
      } as unknown as ResultSummary,
      resultFields: [{
        id: "field-stress",
        runId: "run-missing-units",
        type: "stress",
        location: "element",
        values: [39],
        min: 39,
        max: 39,
        units: undefined
      } as unknown as ResultField]
    });

    expect(html).toContain("Unit missing");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Max total load");
  });

  test("shows legacy cloud results as read-only historical provenance", () => {
    const html = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        provenance: { kind: "opencae_core_fea", solver: ["cloudflare-fea", "calculix"].join("-"), solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" }
      }
    });

    expect(html).toContain("Legacy backend result");
    expect(html).toContain("This result is historical and read-only. Re-run with OpenCAE Core Cloud for production results.");
  });

  test("blocks preview deformation and reverse-check capacity for complex geometry", () => {
    const html = renderPanel("results", {
      displayModel: bracketDisplayModel,
      showDeformed: true,
      study: {
        ...study,
        loads: [{ id: "load-1", type: "force", selectionRef: "selection-top", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }]
      },
      resultSummary: {
        ...resultSummary,
        reactionForce: 0,
        provenance: { kind: "local_estimate", solver: "opencae-core-preview-sdof", solverVersion: "0.1.0", meshSource: "structured_block_proxy", resultSource: "computed_preview", units: "mm-N-s-MPa" }
      },
      resultFields: [{
        id: "field-displacement",
        runId: "run-preview",
        type: "displacement",
        location: "node",
        values: [0, 0.1],
        min: 0,
        max: 0.1,
        units: "mm",
        provenance: { kind: "local_estimate", solver: "opencae-core-preview-sdof", solverVersion: "0.1.0", meshSource: "structured_block_proxy", resultSource: "computed_preview", units: "mm-N-s-MPa" }
      }]
    });

    expect(html).toContain("OpenCAE Core Preview");
    expect(html).toContain("OpenCAE Core Preview mesh does not match this geometry; deformed shape disabled.");
    expect(html).toContain("Reaction force unavailable or invalid for this result.");
    expect(html).toContain('type="checkbox" disabled=""');
    expect(html).not.toContain("Max total load");
  });

  test("shows the run progress percentage inside the progress bar", () => {
    const markup = renderPanel("run", { runProgress: 88 });

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="88"');
    expect(markup).toContain('<strong class="progress-label">88%</strong>');
    expect(markup).not.toContain('<div class="info-row"><span>Progress</span><strong>88%</strong></div>');
  });

  test("does not show an assigned material before one is applied", () => {
    const html = renderPanel("material", { study: { ...study, materialAssignments: [] } });

    expect(html).toContain("No material assigned");
    expect(html).not.toContain("bracket · all bodies");
  });

  test("turns the run simulation button into the only stop action while running", () => {
    const markup = renderPanel("run", { runProgress: 42 });

    expect(markup).toContain('aria-label="Stop simulation"');
    expect(markup).toContain("Stop simulation");
    expect(markup).not.toContain("Run simulation");
    expect(markup).not.toContain("Stop processing");
  });

  test("shows the estimated simulation calculation time while running", () => {
    const markup = renderPanel("run", {
      runProgress: 42,
      runTiming: { elapsedMs: 1800, estimatedDurationMs: 6200, estimatedRemainingMs: 4400 }
    });

    expect(markup).toContain("Time remaining");
    expect(markup).toContain("About 4s remaining");
    expect(markup).toContain("Elapsed");
    expect(markup).toContain("2s");
  });

  test("does not show the selected face as a persistent right-panel banner", () => {
    const markup = renderPanel("results", { selectedFace: displayModel.faces[0] ?? null });

    expect(markup).not.toContain("Face selected:");
    expect(markup).not.toContain("selection-readout");
  });

  test("places every step title and step number on the same header row", () => {
    const steps: Array<{ id: StepId; title: string; step: number }> = [
      { id: "model", title: "Model", step: 1 },
      { id: "material", title: "Material", step: 2 },
      { id: "supports", title: "Supports", step: 3 },
      { id: "loads", title: "Loads", step: 4 },
      { id: "mesh", title: "Mesh", step: 5 },
      { id: "run", title: "Run", step: 6 },
      { id: "results", title: "Results", step: 7 }
    ];

    for (const item of steps) {
      const html = renderPanel(item.id);
      expect(html).toContain(`<div class="panel-title-row"><h2>${item.title}</h2><div class="panel-eyebrow">Step ${item.step} of 7</div></div>`);
    }
  });

  test("does not expose report generation from the results panel", () => {
    const html = renderPanel("results");

    expect(html).not.toContain("Generate report");
    expect(html).not.toContain("Report");
  });

  test("hides large contextual tips until the help trigger is opened", () => {
    const modelHtml = renderPanel("model", {
      project: {
        ...project,
        geometryFiles: [{
          id: "geom-sample",
          projectId: project.id,
          filename: "bracket-demo.step",
          localPath: "examples/bracket-demo/bracket-demo.step",
          artifactKey: "project-1/geometry/bracket-display.json",
          status: "ready",
          metadata: { source: "sample", sampleModel: "bracket" }
        }]
      }
    });
    const supportsHtml = renderPanel("supports");
    const loadsHtml = renderPanel("loads");

    expect(modelHtml).not.toContain("<strong>Overall dimensions</strong>");
    expect(modelHtml).not.toContain("Shows the model bounding size");
    expect(supportsHtml).not.toContain("<strong>Support placement</strong>");
    expect(supportsHtml).not.toContain("Select the actual model face");
    expect(loadsHtml).not.toContain("<strong>Load placement</strong>");
    expect(loadsHtml).not.toContain("Click the exact point for force");
    expect(`${modelHtml}${supportsHtml}${loadsHtml}`).toContain('aria-label="Overall dimensions help"');
    expect(`${modelHtml}${supportsHtml}${loadsHtml}`).toContain('aria-label="Support placement help"');
    expect(`${modelHtml}${supportsHtml}${loadsHtml}`).toContain('aria-label="Load placement help"');
  });

  test("renders sample analysis selection for sample projects", () => {
    const html = renderPanel("model", {
      project: {
        ...project,
        geometryFiles: [{
          id: "geom-sample",
          projectId: project.id,
          filename: "bracket-demo.step",
          localPath: "examples/bracket-demo/bracket-demo.step",
          artifactKey: "project-1/geometry/bracket-display.json",
          status: "ready",
          metadata: { source: "sample", sampleModel: "bracket", sampleAnalysisType: "dynamic_structural" }
        }]
      },
      sampleAnalysisType: "dynamic_structural"
    });

    expect(html).toContain("Analysis type");
    expect(html).toContain("Bracket Demo");
    expect(html).toContain("Beam Demo");
    expect(html).toContain("Cantilever Demo");
    expect(html).toContain("Static");
    expect(html).toContain("Dynamic");
    expect(html).toContain("Load dynamic sample");
    expect(html).toContain("Dynamic Structural");
  });

  test("renders dynamic run settings only for dynamic structural studies", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };

    const dynamicHtml = renderPanel("run", { study: dynamicStudy });
    expect(dynamicHtml).toContain("Start time");
    expect(dynamicHtml).toContain("End time");
    expect(dynamicHtml).toContain("Output interval");
    expect(dynamicHtml).toContain("Load profile");
    expect(dynamicHtml).toContain("Ramp to full load");
    expect(dynamicHtml).toContain("Step load");
    expect(dynamicHtml).toContain("Quasi-static ramp");
    expect(dynamicHtml).toContain("Sinusoidal");
    expect(dynamicHtml).toContain("Ramp: load starts at 0 and reaches full value at end time.");
    expect(dynamicHtml).toContain("Estimated frames");
    expect(renderPanel("run")).not.toContain("Start time");
  });

  test("offers an analysis-type switch on the run panel reflecting the study type", () => {
    const staticHtml = renderPanel("run");
    expect(staticHtml).toContain('aria-label="Analysis type"');
    expect(staticHtml).toMatch(/aria-pressed="true"[^>]*>Static</);
    expect(staticHtml).toMatch(/aria-pressed="false"[^>]*>Dynamic</);

    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic Structural",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const dynamicHtml = renderPanel("run", { study: dynamicStudy });
    expect(dynamicHtml).toMatch(/aria-pressed="true"[^>]*>Dynamic</);
    expect(dynamicHtml).toMatch(/aria-pressed="false"[^>]*>Static</);
  });

  test("renders selected dynamic load profile helper text", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "quasi_static"
      }
    };

    const dynamicHtml = renderPanel("run", { study: dynamicStudy });

    expect(dynamicHtml).toContain("Quasi-static ramp: slow ramp profile intended to reduce inertial effects.");
  });

  test("keeps partial dynamic number edits from committing a coerced zero", () => {
    expect(editableNumberCommitValue("0.00", 0.0001)).toBeNull();
    expect(editableNumberCommitValue("", 0.0001)).toBeNull();
    expect(editableNumberCommitValue("0.001", 0.0001)).toBe(0.001);
    expect(editableNumberCommitValue("0.0", 0)).toBe(0);
  });

  test("renders OpenCAE Core backend and fidelity controls for simulation runs", () => {
    const detailedStudy: Study = {
      ...study,
      solverSettings: { backend: "opencae_core_local", fidelity: "ultra" }
    };

    const runHtml = renderPanel("run", { study: detailedStudy });
    const meshHtml = renderPanel("mesh", { study: { ...detailedStudy, meshSettings: { preset: "ultra", status: "complete", summary: { nodes: 182400, elements: 119808, warnings: [], analysisSampleCount: 45000, quality: "ultra" } } } });

    expect(runHtml).toContain("Simulation settings");
    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml).toContain("Fidelity");
    expect(meshHtml).toContain("Ultra");
    expect(meshHtml).toContain("Analysis samples");
    expect(meshHtml).toContain("45,000");
  });

  test("offers no backend picker: the solver is local, informationally stated (B5)", () => {
    const runHtml = renderPanel("run", {
      study: {
        ...study,
        solverSettings: { backend: "opencae_core_local", fidelity: "standard" }
      }
    });

    // The cloud path is retired and every run executes in the browser, so a
    // backend select would be routing theater; the lower diagnostics state it once.
    expect(runHtml).not.toContain("solver-backend");
    expect(runHtml).not.toContain("Auto — runs locally in your browser");
    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml.match(/Local \(in-browser\)/g)).toHaveLength(1);
    expect(runHtml).not.toContain("Local fallback");
    expect(runHtml).not.toContain("OpenCAE Core Cloud");
  });

  test("shows the local solver row for an omitted solver backend", () => {
    const runHtml = renderPanel("run", {
      study: {
        ...study,
        solverSettings: {}
      }
    });

    expect(runHtml).not.toContain("solver-backend");
    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml.match(/Local \(in-browser\)/g)).toHaveLength(1);
    expect(runHtml).toContain("local core worker");
    expect(runHtml).not.toContain("OpenCAE Core Cloud");
    expect(runHtml).not.toContain("legacy backend");
  });

  test("states the local browser solver for eligible studies", () => {
    const eligibleDisplayModel: DisplayModel = {
      id: "display-cantilever",
      name: "cantilever demo body",
      bodyCount: 1,
      dimensions: { x: 180, y: 24, z: 24, units: "mm" },
      faces: [
        { id: "face-fixed", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], stressValue: 0 },
        { id: "face-load", label: "Free end load face", color: "#f59e0b", center: [1.9, 0.18, 0], normal: [1, 0, 0], stressValue: 0 }
      ]
    };
    const eligibleStudy: Study = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-top", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-top", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-top", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "medium", status: "complete" },
      solverSettings: {}
    } as Study;

    const runHtml = renderPanel("run", { study: eligibleStudy, displayModel: eligibleDisplayModel });

    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml.match(/Local \(in-browser\)/g)).toHaveLength(1);
    expect(runHtml).toContain("local core worker");
    expect(runHtml).not.toContain("solver-backend");
  });

  test("keeps OpenCAE Core runs browser-local without container endpoint copy", () => {
    const detailedStudy: Study = {
      ...study,
      solverSettings: { backend: "opencae_core_local", fidelity: "ultra" }
    };

    const runHtml = renderPanel("run", {
      study: detailedStudy,
      canRunSimulation: true
    });

    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml).not.toContain("opencae-core-preview");
    expect(runHtml).not.toContain("Expected detail");
    expect(runHtml).not.toContain("Browser OpenCAE Core CPU");
    expect(runHtml).not.toContain("FEA_CONTAINER");
    expect(runHtml).not.toContain("CalculiX");
    expect(runHtml).not.toContain("Local estimate");
    expect(runHtml).not.toContain("cloud solver endpoint");
    expect(runHtml).not.toContain('<button class="primary wide" disabled=""');
  });

  test("labels retired cloud backend selections from old saves as the local solver", () => {
    const cloudStudy = {
      ...study,
      solverSettings: { backend: "opencae_core_cloud", fidelity: "ultra" }
    } as unknown as Study;

    const runHtml = renderPanel("run", {
      study: cloudStudy,
      canRunSimulation: true
    });

    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml).not.toContain("OpenCAE Core Cloud");
    expect(runHtml).not.toContain("CalculiX FEA");
    expect(runHtml).not.toContain("Detailed local");
    expect(runHtml).not.toContain("Local estimate");
  });

  test("warns when an invalid Core mesh blocks a run without legacy labels", () => {
    const runHtml = renderPanel("run", {
      study: {
        ...study,
        solverSettings: { backend: "opencae_core_local" },
        meshSettings: { preset: "medium", status: "warning", summary: { nodes: 8, elements: 2, warnings: ["Disconnected mesh"], quality: "medium" } } as Study["meshSettings"]
      },
      canRunSimulation: false,
      missingRunItems: ["Valid Core volume mesh"]
    });

    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml).toContain("Complete valid core volume mesh before running.");
    expect(runHtml).not.toContain("Local estimate");
    expect(runHtml).not.toContain("CalculiX");
  });

  test("treats legacy backend selections as Auto with truthful resolution labels", () => {
    const detailedStudy = {
      ...study,
      solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" }
    } as unknown as Study;

    const runHtml = renderPanel("run", {
      study: detailedStudy
    });

    // Legacy tokens are not an explicit choice; every run executes locally
    // (the only execution path since B4a) and the panel says so plainly.
    expect(runHtml).not.toContain("solver-backend");
    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml).toContain("sparse_static");
    expect(runHtml).not.toContain("Expected detail");
    expect(runHtml).not.toContain("Browser OpenCAE Core CPU");
    expect(runHtml).not.toContain("cloud solver endpoint");
    expect(runHtml).not.toContain("http://localhost:4317");
  });

  test("shows dynamic OpenCAE Core solver details", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core_local",
        fidelity: "ultra",
        startTime: 0,
        endTime: 0.5,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    } as Study;

    const runHtml = renderPanel("run", { study: dynamicStudy });

    expect(runHtml).toContain("Local (in-browser)");
    expect(runHtml).toContain('aria-label="Start time help"');
    expect(runHtml).toContain('aria-label="End time help"');
    expect(runHtml).toContain('aria-label="Time step help"');
    expect(runHtml).toContain('aria-label="Output interval help"');
    expect(runHtml).toContain('aria-label="Load profile help"');
    expect(runHtml).toContain('aria-label="Damping ratio help"');
    expect(runHtml).not.toContain("Expected detail");
    expect(runHtml).not.toContain("Browser OpenCAE Core CPU");
    expect(runHtml).toContain("mdof_dynamic");
    expect(runHtml).not.toContain("opencae-core-preview");
    expect(runHtml).not.toContain("external transient container");
    expect(runHtml).not.toContain("cloudflare-fea-calculix");
    expect(runHtml).not.toContain("cloudflare-queue-container");
  });

  test("warns when dynamic settings generate a very large playback frame set", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 10,
        timeStep: 0.001,
        outputInterval: 0.001,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };

    expect(renderPanel("run", { study: dynamicStudy })).toContain("Large frame counts may slow result loading and playback.");
  });

  test("estimates dynamic frames from output interval rather than integration time step", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.5,
        timeStep: 0.001,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };

    expect(renderPanel("run", { study: dynamicStudy })).toContain('<strong>101</strong>');
  });

  test("normalizes legacy dense dynamic output cadence to avoid huge local frame writes", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.5,
        timeStep: 0.001,
        outputInterval: 0.001,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const html = renderPanel("run", { study: dynamicStudy });

    expect(html).toContain('<strong>101</strong>');
    expect(html).toContain('<strong>Every 0.005 s</strong>');
  });

  test("normalizes fine OpenCAE Core dynamic output cadence", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core_local",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.001,
        outputInterval: 0.001,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };

    const html = renderPanel("run", { study: dynamicStudy });

    expect(html).toContain("Output interval");
    expect(html).toContain('<strong>21</strong>');
    expect(html).toContain('<strong>Every 0.005 s</strong>');
  });

  test("normalizes dense OpenCAE Core dynamic output before estimating frame budget", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core_local",
        startTime: 0,
        endTime: 0.2,
        timeStep: 0.0005,
        outputInterval: 0.0005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };

    const html = renderPanel("run", { study: dynamicStudy });

    expect(html).toContain('<strong>41</strong>');
    expect(html).toContain('<strong>Every 0.005 s</strong>');
    expect(html).not.toContain("dynamic output would exceed frame budget");
  });

  test("renders playback controls for dynamic result frames", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const html = renderPanel("results", {
      study: dynamicStudy,
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 },
        { id: "field-velocity-1", runId: "run-1", type: "velocity", location: "face", values: [3], min: 3, max: 3, units: "mm/s", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain("Frame");
    expect(html).toContain("Play");
    expect(html).toContain("Animation speed");
    expect(html).toContain("12 fps");
    expect(html).toContain("Reverse loop");
    expect(html.indexOf("Animation speed")).toBeLessThan(html.indexOf(">Play</button>"));
    expect(html).toContain("Peak displacement");
    expect(html).toContain("Result mode");
    expect(html).not.toContain("Switches the color plot");
    expect(html).not.toContain("Von Mises Stress");
  });

  test("shows interpolated playback time instead of jumping between integer frames", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.01,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const html = renderPanel("results", {
      study: dynamicStudy,
      resultFrameIndex: 0,
      resultFramePosition: 0.5,
      resultPlaybackPlaying: true,
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain("0.0025 s");
  });

  test("marks peak displacement on the playback time slider", () => {
    const html = renderPanel("results", {
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 0, max: 3, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 0, max: 3, units: "MPa", frameIndex: 1, timeSeconds: 0.005 },
        { id: "field-stress-2", runId: "run-1", type: "stress", location: "face", values: [3], min: 0, max: 3, units: "MPa", frameIndex: 2, timeSeconds: 0.01 },
        { id: "field-displacement-1", runId: "run-1", type: "displacement", location: "face", values: [4.25], min: 0, max: 4.25, units: "mm", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain('class="playback-time-track"');
    expect(html).toContain('class="playback-peak-marker"');
    expect(html).toContain("--playback-peak-position:50%");
    expect(html).toContain('aria-label="Peak displacement at 0.0050 s"');
  });

  test("maps peak displacement time to the playback slider position", () => {
    expect(playbackPeakMarkerPercent([
      { frameIndex: 0, timeSeconds: 0 },
      { frameIndex: 7, timeSeconds: 0.005 },
      { frameIndex: 12, timeSeconds: 0.015 }
    ], 0.01)).toBeCloseTo(75);
  });

  test("shows the current playback frame count next to the dynamic time", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.01,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const html = renderPanel("results", {
      study: dynamicStudy,
      resultFrameIndex: 1,
      resultFramePosition: 1,
      resultPlaybackPlaying: true,
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 0, max: 2, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 0, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain("Frame 2 / 2");
  });

  test("shows sparse solver frame indexes as sequential playback frame numbers", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.02,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const html = renderPanel("results", {
      study: dynamicStudy,
      resultFrameIndex: 7,
      resultFramePosition: 7,
      resultPlaybackPlaying: true,
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 0, max: 3, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-7", runId: "run-1", type: "stress", location: "face", values: [2], min: 0, max: 3, units: "MPa", frameIndex: 7, timeSeconds: 0.005 },
        { id: "field-stress-12", runId: "run-1", type: "stress", location: "face", values: [3], min: 0, max: 3, units: "MPa", frameIndex: 12, timeSeconds: 0.01 }
      ]
    });

    expect(html).toContain("Frame 2 / 3");
    expect(html).not.toContain("Frame 3 / 3");
  });

  test("uses transient summary time for peak displacement when displacement frames are not visible", () => {
    const html = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        maxDisplacement: 4.25,
        maxDisplacementUnits: "mm",
        transient: {
          analysisType: "dynamic_structural",
          integrationMethod: "newmark_average_acceleration",
          startTime: 0,
          endTime: 0.1,
          timeStep: 0.005,
          outputInterval: 0.005,
          dampingRatio: 0.02,
          frameCount: 21,
          peakDisplacementTimeSeconds: 0.045,
          peakDisplacement: 4.25
        }
      },
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain("4.25 mm at 0.0450 s");
  });

  test("uses active displacement frame values rather than global dynamic ranges for peak displacement time", () => {
    const html = renderPanel("results", {
      resultFields: [
        { id: "field-displacement-0", runId: "run-1", type: "displacement", location: "face", values: [0], min: 0, max: 4.25, units: "mm", frameIndex: 0, timeSeconds: 0 },
        { id: "field-displacement-1", runId: "run-1", type: "displacement", location: "face", values: [4.25], min: 0, max: 4.25, units: "mm", frameIndex: 1, timeSeconds: 0.045 }
      ]
    });

    expect(html).toContain("4.25 mm at 0.0450 s");
  });

  test("shows pause when dynamic result playback is active", () => {
    const html = renderPanel("results", {
      resultPlaybackPlaying: true,
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain("Pause");
  });

  test("shows reverse loop as checked when ping-pong playback is enabled", () => {
    const html = renderPanel("results", {
      resultPlaybackReverseLoop: true,
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain('class="toggle playback-loop-toggle"');
    expect(html).toContain('<input type="checkbox" checked=""/>');
    expect(html).toContain("Reverse loop");
  });

  test("marks the current time control as a playback playhead instead of a normal slider", () => {
    const html = renderPanel("results", {
      resultFields: [
        { id: "field-stress-0", runId: "run-1", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
        { id: "field-stress-1", runId: "run-1", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
      ]
    });

    expect(html).toContain('class="playback-time-range"');
    expect(html).toContain('aria-label="Playback time position"');
  });

  test("shows X as the bracket's weakest FDM build direction for an out-of-plane force", () => {
    const bracketStudy = {
      ...study,
      materialAssignments: [{
        id: "assign",
        materialId: "mat-abs",
        selectionRef: "selection-body",
        parameters: { manufacturingProcessId: "fdm", infillDensity: 35, wallCount: 3, layerOrientation: "x" },
        status: "complete"
      }],
      namedSelections: [
        {
          id: "selection-fixed-face",
          name: "Fixed base mounting holes",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-left", label: "Base mounting holes" }],
          fingerprint: "fixed"
        },
        {
          id: "selection-load-face",
          name: "Top load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load-top", label: "Top load face" }],
          fingerprint: "load"
        }
      ],
      constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
      // Built-in samples store model-space -Y, which renders/solves as global -Z.
      loads: [{ id: "load", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, direction: [0, -1, 0] }, status: "complete" }]
    } satisfies Study;
    const xHtml = renderPanel("material", { displayModel: bracketDisplayModel, study: bracketStudy });
    const yHtml = renderPanel("material", {
      displayModel: bracketDisplayModel,
      study: {
        ...bracketStudy,
        materialAssignments: [{
          id: "assign",
          materialId: "mat-abs",
          selectionRef: "selection-body",
          parameters: { manufacturingProcessId: "fdm", infillDensity: 35, wallCount: 3, layerOrientation: "y" },
          status: "complete"
        }]
      }
    });
    const rotatedYHtml = renderPanel("material", {
      displayModel: { ...bracketDisplayModel, orientation: { x: 0, y: 0, z: 90 } },
      study: {
        ...bracketStudy,
        materialAssignments: [{
          id: "assign",
          materialId: "mat-abs",
          selectionRef: "selection-body",
          parameters: { manufacturingProcessId: "fdm", infillDensity: 35, wallCount: 3, layerOrientation: "y" },
          status: "complete"
        }]
      }
    });

    expect(xHtml).toContain('<span>Governing load path</span><strong>X axis</strong>');
    expect(xHtml).toContain('<span>Layer response</span><strong>Across layers · weakest</strong>');
    expect(xHtml).toContain('<span>Effective modulus</span><strong>743.4 MPa</strong>');
    expect(xHtml).toContain('<span>Effective yield</span><strong>8.316 MPa</strong>');
    expect(yHtml).toContain('<span>Layer response</span><strong>Within layers</strong>');
    expect(yHtml).toContain('<span>Effective modulus</span><strong>1,029.3 MPa</strong>');
    expect(yHtml).toContain('<span>Effective yield</span><strong>16.63 MPa</strong>');
    expect(rotatedYHtml).toContain('<span>Governing load path</span><strong>Y axis</strong>');
    expect(rotatedYHtml).toContain('<span>Layer response</span><strong>Across layers · weakest</strong>');
  });

  test("separates the base material from its compatible manufacturing processes", () => {
    const html = renderPanel("material", {
      study: {
        ...study,
        materialAssignments: [{
          id: "assign",
          materialId: "mat-abs",
          selectionRef: "selection-body",
          parameters: { manufacturingProcessId: "fdm", infillDensity: 35, wallCount: 3, layerOrientation: "z" },
          status: "complete"
        }]
      }
    });

    expect(html).toContain("Base Material");
    expect(html).toContain("ABS Plastic");
    expect(html).toContain("Thermoplastic");
    expect(html).toContain("Manufacturing Process");
    expect(html).toContain("Compatible with ABS Plastic. Only validated options are shown.");
    expect(html).toContain('role="radiogroup" aria-label="Manufacturing process"');
    expect(html).toContain("CNC machining");
    expect(html).toContain("Injection molding");
    expect(html).toContain("FDM printing");
    expect(html).not.toContain("SLA printing");
    expect(html).toContain("FDM Settings");
    expect(html).toContain("Infill density");
    expect(html).toContain("Wall count");
    expect(html).toContain("Build direction");
    expect(html).toContain("Simulation Properties");
    expect(html).toContain("Effective modulus");
    expect(html).toContain("Effective density");
    expect(html).toContain("Effective yield");
    expect(html).toContain("Poisson ratio");
    expect(html).toContain("Apply material &amp; process");
    expect(html).not.toContain("3D printed part");
  });

  test("only shows FDM settings when FDM is the selected manufacturing process", () => {
    const cncHtml = renderPanel("material", {
      study: {
        ...study,
        materialAssignments: [{
          id: "assign",
          materialId: "mat-abs",
          selectionRef: "selection-body",
          parameters: { manufacturingProcessId: "cnc_machining" },
          status: "complete"
        }]
      }
    });

    expect(cncHtml).toContain('role="radio" aria-checked="true"');
    expect(cncHtml).toContain("CNC machining");
    expect(cncHtml).toContain("FDM printing");
    expect(cncHtml).not.toContain("FDM Settings");
    expect(cncHtml).not.toContain("Infill density");
    expect(cncHtml).not.toContain("Wall count");
    expect(cncHtml).not.toContain("Build direction");
  });

  test("enables adding payload mass when a payload object is selected without a named face selection", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const html = renderToStaticMarkup(
        <RightPanel
          activeStep="loads"
          project={project}
          displayModel={displayModel}
          study={study}
          selectedFace={displayModel.faces[0] ?? null}
          viewMode="model"
          resultMode="stress"
          showDeformed={false}
          showDimensions={false}
          stressExaggeration={1}
          resultSummary={resultSummary}
          runProgress={0}
          sampleModel="bracket"
          draftLoadType="gravity"
          draftLoadValue={5}
          draftLoadDirection="-Z"
          selectedLoadPoint={[1, 2, 3]}
          selectedPayloadObject={{ id: "rod-1", label: "Rod 1", center: [1, 2, 3], volumeM3: 0.001, volumeSource: "mesh", volumeStatus: "available" }}
          onFitView={vi.fn()}
          onRotateModel={vi.fn()}
          onResetModelOrientation={vi.fn()}
          onLoadSample={vi.fn()}
          onUploadModel={vi.fn()}
          onSampleModelChange={vi.fn()}
          onViewModeChange={vi.fn()}
          onResultModeChange={vi.fn()}
          onToggleDeformed={vi.fn()}
          onToggleDimensions={vi.fn()}
          onStressExaggerationChange={vi.fn()}
          onAssignMaterial={vi.fn()}
          onAddSupport={vi.fn()}
          onUpdateSupport={vi.fn()}
          onRemoveSupport={vi.fn()}
          onDraftLoadTypeChange={vi.fn()}
          onDraftLoadValueChange={vi.fn()}
          onDraftLoadDirectionChange={vi.fn()}
          onAddLoad={vi.fn()}
          onUpdateLoad={vi.fn()}
          onPreviewLoadEdit={vi.fn()}
          onRemoveLoad={vi.fn()}
          onGenerateMesh={vi.fn()}
          onRunSimulation={vi.fn()}
          canRunSimulation={false}
          missingRunItems={[]}
          onStepSelect={vi.fn()}
        />
      );

      expect(html).toContain("Selected Rod 1");
      expect(html).not.toContain("Selected Top face");
      expect(html).toContain("Payload material");
      expect(html).not.toContain("Search materials");
      expect(html).toContain("<datalist");
      expect(html).toContain('value="Carbon steel"');
      expect(html).not.toContain('label="Plastics"');
      expect(html).toContain("Calculated mass");
      expect(html).toContain("Manual mass override");
      expect(html).toContain("Add each rod or carried part separately");
      expect(html).toContain("Add payload mass");
      expect(html).not.toMatch(/<button class="outline-action wide" disabled="">[\s\S]*Add payload mass/);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("opens load editing from the applied load card without an edit button", () => {
    const html = renderToStaticMarkup(
      <RightPanel
        activeStep="loads"
        project={project}
        displayModel={displayModel}
        study={{
          ...study,
          loads: [{
            id: "load-1",
            type: "force",
            selectionRef: "selection-top",
            parameters: { value: 500, units: "N", direction: [0, 0, -1] },
            status: "complete"
          }]
        }}
        selectedFace={displayModel.faces[0] ?? null}
        viewMode="model"
        resultMode="stress"
        showDeformed={false}
        showDimensions={false}
        stressExaggeration={1}
        resultSummary={resultSummary}
        runProgress={0}
        sampleModel="bracket"
        draftLoadType="force"
        draftLoadValue={500}
        draftLoadDirection="-Z"
        selectedLoadPoint={null}
        selectedPayloadObject={null}
        onFitView={vi.fn()}
        onRotateModel={vi.fn()}
        onResetModelOrientation={vi.fn()}
        onLoadSample={vi.fn()}
        onUploadModel={vi.fn()}
        onSampleModelChange={vi.fn()}
        onViewModeChange={vi.fn()}
        onResultModeChange={vi.fn()}
        onToggleDeformed={vi.fn()}
        onToggleDimensions={vi.fn()}
        onStressExaggerationChange={vi.fn()}
        onAssignMaterial={vi.fn()}
        onAddSupport={vi.fn()}
        onUpdateSupport={vi.fn()}
        onRemoveSupport={vi.fn()}
        onDraftLoadTypeChange={vi.fn()}
        onDraftLoadValueChange={vi.fn()}
        onDraftLoadDirectionChange={vi.fn()}
        onAddLoad={vi.fn()}
        onUpdateLoad={vi.fn()}
        onPreviewLoadEdit={vi.fn()}
        onRemoveLoad={vi.fn()}
        onGenerateMesh={vi.fn()}
        onRunSimulation={vi.fn()}
        canRunSimulation={false}
        missingRunItems={[]}
        onStepSelect={vi.fn()}
      />
    );

    expect(html).not.toContain("Edit load");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Edit L1 force load"');
  });

  test("shows the selected payload material in applied payload mass loads", () => {
    const html = renderToStaticMarkup(
      <RightPanel
        activeStep="loads"
        project={project}
        displayModel={displayModel}
        study={{
          ...study,
          loads: [{
            id: "load-1",
            type: "gravity",
            selectionRef: "selection-top",
            parameters: {
              value: 0.159,
              units: "kg",
              direction: [0, 0, -1],
              payloadMaterialId: "payload-silicon",
              payloadObject: { id: "part-8", label: "Part 8", center: [1, 2, 3] }
            },
            status: "complete"
          }]
        }}
        selectedFace={displayModel.faces[0] ?? null}
        viewMode="model"
        resultMode="stress"
        showDeformed={false}
        showDimensions={false}
        stressExaggeration={1}
        resultSummary={resultSummary}
        runProgress={0}
        sampleModel="bracket"
        draftLoadType="gravity"
        draftLoadValue={0.159}
        draftLoadDirection="-Z"
        selectedLoadPoint={null}
        selectedPayloadObject={null}
        onFitView={vi.fn()}
        onRotateModel={vi.fn()}
        onResetModelOrientation={vi.fn()}
        onLoadSample={vi.fn()}
        onUploadModel={vi.fn()}
        onSampleModelChange={vi.fn()}
        onViewModeChange={vi.fn()}
        onResultModeChange={vi.fn()}
        onToggleDeformed={vi.fn()}
        onToggleDimensions={vi.fn()}
        onStressExaggerationChange={vi.fn()}
        onAssignMaterial={vi.fn()}
        onAddSupport={vi.fn()}
        onUpdateSupport={vi.fn()}
        onRemoveSupport={vi.fn()}
        onDraftLoadTypeChange={vi.fn()}
        onDraftLoadValueChange={vi.fn()}
        onDraftLoadDirectionChange={vi.fn()}
        onAddLoad={vi.fn()}
        onUpdateLoad={vi.fn()}
        onPreviewLoadEdit={vi.fn()}
        onRemoveLoad={vi.fn()}
        onGenerateMesh={vi.fn()}
        onRunSimulation={vi.fn()}
        canRunSimulation={false}
        missingRunItems={[]}
        onStepSelect={vi.fn()}
      />
    );

    expect(html).toContain("Payload mass");
    expect(html).toContain("Part 8 · Silicon");
  });

  test("disables next run navigation until mesh generation is complete", () => {
    const html = renderToStaticMarkup(
      <RightPanel
        activeStep="mesh"
        project={project}
        displayModel={displayModel}
        study={{ ...study, meshSettings: { preset: "medium", status: "not_started" } }}
        selectedFace={displayModel.faces[0] ?? null}
        viewMode="model"
        resultMode="stress"
        showDeformed={false}
        showDimensions={false}
        stressExaggeration={1}
        resultSummary={resultSummary}
        runProgress={0}
        sampleModel="bracket"
        draftLoadType="force"
        draftLoadValue={500}
        draftLoadDirection="-Z"
        selectedLoadPoint={null}
        selectedPayloadObject={null}
        onFitView={vi.fn()}
        onRotateModel={vi.fn()}
        onResetModelOrientation={vi.fn()}
        onLoadSample={vi.fn()}
        onUploadModel={vi.fn()}
        onSampleModelChange={vi.fn()}
        onViewModeChange={vi.fn()}
        onResultModeChange={vi.fn()}
        onToggleDeformed={vi.fn()}
        onToggleDimensions={vi.fn()}
        onStressExaggerationChange={vi.fn()}
        onAssignMaterial={vi.fn()}
        onAddSupport={vi.fn()}
        onUpdateSupport={vi.fn()}
        onRemoveSupport={vi.fn()}
        onDraftLoadTypeChange={vi.fn()}
        onDraftLoadValueChange={vi.fn()}
        onDraftLoadDirectionChange={vi.fn()}
        onAddLoad={vi.fn()}
        onUpdateLoad={vi.fn()}
        onPreviewLoadEdit={vi.fn()}
        onRemoveLoad={vi.fn()}
        onGenerateMesh={vi.fn()}
        onRunSimulation={vi.fn()}
        canRunSimulation={false}
        missingRunItems={["Mesh generated"]}
        onStepSelect={vi.fn()}
      />
    );

    expect(html).toContain('title="Next workflow step (N)"');
    expect(html).toContain('aria-label="Next workflow step: Run. Shortcut N"');
    expect(html).toContain('<span class="workflow-nav-label">Next: Run</span><kbd>N</kbd>');
  });

  test("turns the active meshing button into an enabled stop action", () => {
    const html = renderPanel("mesh", {
      meshPhaseProgress: {
        phase: "mesh3d",
        phaseIndex: 4,
        phaseCount: 8,
        message: "Meshing volume..."
      }
    });

    expect(html).toContain('aria-label="Stop mesh generation"');
    expect(html).toContain("Stop meshing");
    expect(html).not.toContain('aria-label="Stop mesh generation" disabled');
  });

  test("shows Back and Next hotkey hints on workflow navigation buttons", () => {
    const html = renderPanel("loads", { study: { ...study, meshSettings: { preset: "medium", status: "complete" } } });

    expect(html).toContain('title="Previous workflow step (B)"');
    expect(html).toContain('aria-label="Previous workflow step: Supports. Shortcut B"');
    expect(html).toContain('<span class="workflow-nav-label">Back: Supports</span><kbd>B</kbd>');
    expect(html).toContain('title="Next workflow step (N)"');
    expect(html).toContain('aria-label="Next workflow step: Mesh. Shortcut N"');
    expect(html).toContain('<span class="workflow-nav-label">Next: Mesh</span><kbd>N</kbd>');
  });

  test("requires a picked model point before adding a force load", () => {
    const markup = renderPanel("loads");

    expect(markup).toContain(">Add load<");
    expect(markup).toContain('<button class="outline-action wide" disabled="">');
    expect(markup).toContain("Select a point on the model, then click Add load.");
  });

  test("keeps a picked force location ready for the add load action", () => {
    const markup = renderPanel("loads", {
      selectedFace: displayModel.faces[0],
      selectedLoadPoint: [1, 2, 3]
    });

    expect(markup).toContain("point picked");
    expect(markup).toContain(">Add load<");
    expect(markup).not.toContain('<button class="outline-action wide" disabled="">');
  });

  test("shows an empty results state instead of fabricated numbers when no run has completed", () => {
    const html = renderPanel("results", { resultSummary: null });

    expect(html).toContain("Run a simulation to see results.");
    expect(html).not.toContain("Max stress");
    expect(html).not.toContain("Safety factor");
    expect(html).not.toContain("Result mode");
  });

  test("offers one-click report generation with busy and error states", () => {
    const idle = renderPanel("results", { onGenerateReport: vi.fn() });
    const busy = renderPanel("results", { onGenerateReport: vi.fn(), reportBusy: true });
    const failed = renderPanel("results", { onGenerateReport: vi.fn(), reportError: "Capture failed." });

    expect(idle).toContain("Generate report");
    expect(busy).toContain("Generating…");
    expect(busy).toContain('disabled=""');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Capture failed.");
  });

  test("hides the sample Volume and Mass rows for blank and uploaded projects", () => {
    const blankHtml = renderPanel("model");
    const uploadedHtml = renderPanel("model", {
      project: {
        ...project,
        geometryFiles: [{
          id: "geom-upload",
          projectId: project.id,
          filename: "fixture.step",
          localPath: "uploads/fixture.step",
          artifactKey: "project-1/geometry/uploaded-display.json",
          status: "ready",
          metadata: { source: "local-upload" }
        }]
      }
    });
    const sampleHtml = renderPanel("model", {
      project: {
        ...project,
        geometryFiles: [{
          id: "geom-sample",
          projectId: project.id,
          filename: "bracket-demo.step",
          localPath: "examples/bracket-demo/bracket-demo.step",
          artifactKey: "project-1/geometry/bracket-display.json",
          status: "ready",
          metadata: { source: "sample", sampleModel: "bracket" }
        }]
      }
    });

    expect(blankHtml).not.toContain("<span>Volume</span>");
    expect(blankHtml).not.toContain("<span>Mass</span>");
    expect(uploadedHtml).not.toContain("<span>Volume</span>");
    expect(uploadedHtml).not.toContain("<span>Mass</span>");
    expect(sampleHtml).toContain("<span>Volume</span>");
    expect(sampleHtml).toContain("<span>Mass</span>");
  });

  test("reports beam structural mass separately from the payload mass", () => {
    const beamHtml = renderPanel("model", {
      sampleModel: "plate",
      project: {
        ...project,
        geometryFiles: [{
          id: "geom-beam",
          projectId: project.id,
          filename: "end-loaded-beam.step",
          localPath: "examples/beam/end-loaded-beam.step",
          artifactKey: "project-1/geometry/beam-display.json",
          status: "ready",
          metadata: { source: "sample", sampleModel: "plate" }
        }]
      }
    });

    expect(beamHtml).toContain("28,590 mm");
    expect(beamHtml).toContain("77 g");
    expect(beamHtml).toContain("Payload mass · 0.498 kg");
  });

  test("renders an accessible repair action when uploaded STEP surfaces are open", () => {
    const html = renderPanel("model", {
      project: uploadedStepProject("repairable", "Open boundary loops were detected in this STEP model."),
      onRepairModel: vi.fn()
    });

    expect(html).toContain('<div class="step-repair-card" role="alert" aria-label="Open STEP surfaces detected">');
    expect(html).toContain("Open boundary loops were detected in this STEP model.");
    expect(html).toContain("Fix open surfaces");
    expect(html).not.toContain('<button class="outline-action wide" type="button" disabled="">');
  });

  test("disables the repair action and shows progress while fixing STEP surfaces", () => {
    const html = renderPanel("model", {
      project: uploadedStepProject("repairable"),
      onRepairModel: vi.fn(),
      isRepairingModel: true
    });

    expect(html).toMatch(/<button class="outline-action wide" type="button" disabled="">[\s\S]*Fixing model\.\.\.<\/button>/);
    expect(html).not.toContain("Fix open surfaces");
  });

  test("confirms when uploaded STEP geometry was repaired", () => {
    const html = renderPanel("model", {
      project: uploadedStepProject("repaired")
    });

    expect(html).toContain("Geometry repair complete.");
    expect(html).toContain("Open boundaries were converted into a closed solid");
    expect(html).not.toContain("Fix open surfaces");
  });

  test("shows an unrepairable STEP warning without offering an automatic fix", () => {
    const html = renderPanel("model", {
      project: uploadedStepProject("unrepairable", "Automatic repair could not close every surface.")
    });

    expect(html).toContain('<p class="panel-warning" role="alert">');
    expect(html).toContain("Automatic repair could not close every surface.");
    expect(html).not.toContain("Fix open surfaces");
    expect(html).not.toContain('aria-label="Open STEP surfaces detected"');
  });

  test("surfaces a post-failure repair action on both the Model and Mesh steps", () => {
    const repairableProject = uploadedStepProject(
      "repairable",
      "Automatic repair can re-close this model's faces."
    );

    for (const activeStep of ["model", "mesh"] as const) {
      const html = renderPanel(activeStep, {
        project: repairableProject,
        onRepairModel: vi.fn()
      });
      expect(html).toContain("Automatic repair can re-close this model&#x27;s faces.");
      expect(html).toContain("Fix open surfaces");
    }
  });

  test("surfaces the honest re-export warning on both the Model and Mesh steps", () => {
    const unrepairableProject = uploadedStepProject(
      "unrepairable",
      "Automatic repair cannot close this model. Re-export it from CAD as a solid body."
    );

    for (const activeStep of ["model", "mesh"] as const) {
      const html = renderPanel(activeStep, { project: unrepairableProject });
      expect(html).toContain("Automatic repair cannot close this model. Re-export it from CAD as a solid body.");
      expect(html).not.toContain("Fix open surfaces");
    }
  });

  test("offers the parametric part builder in the model panel", () => {
    const html = renderPanel("model");
    expect(html).toContain("Create parametric part");
    expect(html).toContain("Add to project");
    expect(html).toContain("Download .step");
  });
});
