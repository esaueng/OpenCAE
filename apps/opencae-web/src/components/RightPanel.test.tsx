import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, ResultSummary, Study } from "@opencae/schema";
import { RightPanel } from "./RightPanel";

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

describe("RightPanel payload mass controls", () => {
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
          canGenerateReport={false}
          onGenerateReport={vi.fn()}
          onStepSelect={vi.fn()}
        />
      );

      expect(html).toContain("Selected Rod 1");
      expect(html).not.toContain("Selected Top face");
      expect(html).toContain("Payload material");
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
        canGenerateReport={false}
        onGenerateReport={vi.fn()}
        onStepSelect={vi.fn()}
      />
    );

    expect(html).not.toContain("Edit load");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Edit L1 force load"');
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
        canGenerateReport={false}
        onGenerateReport={vi.fn()}
        onStepSelect={vi.fn()}
      />
    );

    expect(html).toContain('<button class="primary" type="button" disabled="">Next: Run</button>');
  });
});
