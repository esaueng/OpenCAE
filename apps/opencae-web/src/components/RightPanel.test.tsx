import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, ResultSummary, Study } from "@opencae/schema";
import { editableNumberCommitValue, playbackPeakMarkerPercent, RightPanel, rangeProgressPercent } from "./RightPanel";
import type { StepId } from "./StepBar";

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
      onRunSimulation={vi.fn()}
      onCancelSimulation={vi.fn()}
      canRunSimulation={false}
      missingRunItems={[]}
      resultPlaybackPlaying={false}
      resultPlaybackFps={12}
      onResultPlaybackToggle={vi.fn()}
      onResultPlaybackFpsChange={vi.fn()}
      onStepSelect={vi.fn()}
      {...overrides}
    />
  );
}

describe("RightPanel payload mass controls", () => {
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
    const localHtml = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        provenance: { kind: "local_estimate", solver: "opencae-local-heuristic-surface", solverVersion: "0.1.0", meshSource: "mock", resultSource: "generated", units: "mm-N-s-MPa" }
      }
    });
    const beamHtml = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        provenance: { kind: "analytical_benchmark", solver: "opencae-euler-bernoulli", solverVersion: "0.1.0", meshSource: "structured_block", resultSource: "generated", units: "mm-N-s-MPa" }
      }
    });
    const coreHtml = renderPanel("results", {
      resultSummary: {
        ...resultSummary,
        provenance: { kind: "opencae_core_fea", solver: "opencae-core-cpu-tet4", solverVersion: "0.1.0", meshSource: "opencae_core_tet4", resultSource: "computed", units: "mm-N-s-MPa" }
      }
    });

    expect(localHtml).toContain("Local estimate");
    expect(localHtml).not.toContain("Local FEA");
    expect(beamHtml).toContain("Analytical benchmark");
    expect(coreHtml).toContain("OpenCAE Core");
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

  test("shows a stop processing action while a simulation is running", () => {
    const markup = renderPanel("run", { runProgress: 42 });

    expect(markup).toContain("Stop processing");
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

  test("renders backend and fidelity controls for detailed simulation runs", () => {
    const detailedStudy: Study = {
      ...study,
      solverSettings: { backend: "opencae_core", fidelity: "ultra" }
    };

    const runHtml = renderPanel("run", { study: detailedStudy });
    const meshHtml = renderPanel("mesh", { study: { ...detailedStudy, meshSettings: { preset: "ultra", status: "complete", summary: { nodes: 182400, elements: 119808, warnings: [], analysisSampleCount: 45000, quality: "ultra" } } } });

    expect(runHtml).toContain("Simulation backend");
    expect(runHtml).toContain("Detailed local");
    expect(runHtml).toContain("OpenCAE Core");
    expect(runHtml).toContain("Fidelity");
    expect(meshHtml).toContain("Ultra");
    expect(meshHtml).toContain("Analysis samples");
    expect(meshHtml).toContain("45,000");
  });

  test("keeps OpenCAE Core runs browser-local without container endpoint copy", () => {
    const detailedStudy: Study = {
      ...study,
      solverSettings: { backend: "opencae_core", fidelity: "ultra" }
    };

    const runHtml = renderPanel("run", {
      study: detailedStudy,
      canRunSimulation: true
    });

    expect(runHtml).toContain("OpenCAE Core");
    expect(runHtml).toContain("opencae-core-cpu-tet4");
    expect(runHtml).not.toContain("Expected detail");
    expect(runHtml).not.toContain("Browser OpenCAE Core CPU");
    expect(runHtml).not.toContain("FEA_CONTAINER");
    expect(runHtml).not.toContain("Cloud FEA endpoint");
    expect(runHtml).not.toContain('<button class="primary wide" disabled=""');
  });

  test("normalizes legacy Cloud FEA selections to OpenCAE Core", () => {
    const detailedStudy: Study = {
      ...study,
      solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" }
    };

    const runHtml = renderPanel("run", {
      study: detailedStudy
    });

    expect(runHtml).toContain("OpenCAE Core");
    expect(runHtml).not.toContain("Expected detail");
    expect(runHtml).not.toContain("Browser OpenCAE Core CPU");
    expect(runHtml).not.toContain("Cloud FEA endpoint");
    expect(runHtml).not.toContain("http://localhost:4317");
  });

  test("shows dynamic OpenCAE Core runs fall back to Detailed local", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core",
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

    expect(runHtml).toContain("OpenCAE Core");
    expect(runHtml).not.toContain("Expected detail");
    expect(runHtml).not.toContain("Browser OpenCAE Core CPU");
    expect(runHtml).toContain("Dynamic OpenCAE Core runs fall back to Detailed local until transient Core support is available.");
    expect(runHtml).toContain("opencae-core-cpu-tet4");
    expect(runHtml).not.toContain("CalculiX transient container");
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

  test("normalizes fine OpenCAE Core dynamic output cadence to local fallback limits", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core",
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
    expect(html).toContain("Dynamic OpenCAE Core runs fall back to Detailed local until transient Core support is available.");
  });

  test("normalizes dense OpenCAE Core dynamic output before estimating frame budget", () => {
    const dynamicStudy: Study = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core",
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
    expect(html.indexOf("Animation speed")).toBeLessThan(html.indexOf(">Play</button>"));
    expect(html).not.toContain("Loop");
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

  test("shows contextual weak X build yield on cantilever material previews", () => {
    const html = renderToStaticMarkup(
      <RightPanel
        activeStep="material"
        project={project}
        displayModel={{
          ...displayModel,
          id: "display-cantilever",
          faces: [
            { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.8, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
            { id: "face-load-top", label: "Free end load face", color: "#4da3ff", center: [1.75, 0.18, 0], normal: [1, 0, 0], stressValue: 96 }
          ]
        }}
        study={{
          ...study,
          materialAssignments: [{ id: "assign", materialId: "mat-petg", selectionRef: "selection-body", parameters: { printed: true, infillDensity: 100, wallCount: 3, layerOrientation: "x" }, status: "complete" }],
          namedSelections: [
            {
              id: "selection-fixed-face",
              name: "Fixed end face",
              entityType: "face",
              geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
              fingerprint: "fixed"
            },
            {
              id: "selection-load-face",
              name: "Free end load face",
              entityType: "face",
              geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load-top", label: "Free end load face" }],
              fingerprint: "load"
            }
          ],
          constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
          loads: [{ id: "load", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, direction: [0, 0, -1] }, status: "complete" }]
        }}
        selectedFace={null}
        viewMode="model"
        resultMode="stress"
        showDeformed={false}
        showDimensions={false}
        stressExaggeration={1}
        resultSummary={resultSummary}
        runProgress={0}
        sampleModel="cantilever"
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

    expect(html).toContain("17.5 MPa");
  });

  test("hides print process details when a printable material is not marked as 3D printed", () => {
    const html = renderToStaticMarkup(
      <RightPanel
        activeStep="material"
        project={project}
        displayModel={displayModel}
        study={{
          ...study,
          materialAssignments: [{ id: "assign", materialId: "mat-abs", selectionRef: "selection-body", parameters: { printed: false, infillDensity: 35, wallCount: 3, layerOrientation: "z" }, status: "complete" }]
        }}
        selectedFace={null}
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

    expect(html).toContain("3D printed part");
    expect(html).not.toContain("Print process");
    expect(html).not.toContain("FDM");
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
});
