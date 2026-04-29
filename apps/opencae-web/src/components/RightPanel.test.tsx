import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, ResultSummary, Study } from "@opencae/schema";
import { RightPanel, rangeProgressPercent } from "./RightPanel";
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
        integrationMethod: "newmark_average_acceleration"
      }
    };

    expect(renderPanel("run", { study: dynamicStudy })).toContain("End time");
    expect(renderPanel("run")).not.toContain("End time");
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
        integrationMethod: "newmark_average_acceleration"
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
    expect(html).toContain("Peak displacement");
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

    expect(html).toContain('<button class="primary" type="button" disabled="">Next: Run</button>');
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
