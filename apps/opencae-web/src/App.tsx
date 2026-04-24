import { useEffect, useMemo, useState } from "react";
import type { Constraint, DisplayModel, Load, Project, ResultSummary, RunEvent, Study } from "@opencae/schema";
import { Save } from "lucide-react";
import { addLoad, addSupport, assignMaterial, createProject, generateMesh, getResults, importLocalProject, loadSampleProject, runSimulation, subscribeToRun, updateStudy as saveStudyPatch, type SampleModelId } from "./lib/api";
import { BottomPanel } from "./components/BottomPanel";
import { RightPanel } from "./components/RightPanel";
import { StartScreen } from "./components/StartScreen";
import { StepBar, type StepId } from "./components/StepBar";
import { CadViewer, type ResultMode, type ViewMode } from "./components/CadViewer";
import type { ViewerLoadMarker, ViewerSupportMarker } from "./components/CadViewer";
import {
  createDraftLoadMarker,
  directionVectorForLabel,
  loadMarkerFromLoad,
  type LoadDirectionLabel,
  type LoadType
} from "./loadPreview";
import { buildLocalProjectFile, suggestedProjectFilename } from "./projectFile";

interface SaveFilePickerHandle {
  createWritable: () => Promise<{ write: (content: Blob) => Promise<void>; close: () => Promise<void> }>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<SaveFilePickerHandle>;
}

const seededSummary: ResultSummary = {
  maxStress: 142,
  maxStressUnits: "MPa",
  maxDisplacement: 0.184,
  maxDisplacementUnits: "mm",
  safetyFactor: 1.8,
  reactionForce: 500,
  reactionForceUnits: "N"
};

type ThemeMode = "dark" | "light";

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [displayModel, setDisplayModel] = useState<DisplayModel | null>(null);
  const [activeStep, setActiveStep] = useState<StepId>("model");
  const [stepHistory, setStepHistory] = useState<StepId[]>(["model"]);
  const [stepHistoryIndex, setStepHistoryIndex] = useState(0);
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("model");
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [resultMode, setResultMode] = useState<ResultMode>("stress");
  const [showDeformed, setShowDeformed] = useState(false);
  const [stressExaggeration, setStressExaggeration] = useState(1.8);
  const [fitSignal, setFitSignal] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [logs, setLogs] = useState<string[]>(["Ready | Local Mode"]);
  const [runProgress, setRunProgress] = useState(0);
  const [activeRunId, setActiveRunId] = useState("run-bracket-demo-seeded");
  const [resultSummary, setResultSummary] = useState<ResultSummary>(seededSummary);
  const [draftLoadType, setDraftLoadType] = useState<LoadType>("force");
  const [draftLoadValue, setDraftLoadValue] = useState(500);
  const [draftLoadDirection, setDraftLoadDirection] = useState<LoadDirectionLabel>("-Y");
  const [sampleModel, setSampleModel] = useState<SampleModelId>("bracket");

  const study = project?.studies[0] ?? null;
  const selectedFace = useMemo(() => displayModel?.faces.find((face) => face.id === selectedFaceId) ?? null, [displayModel, selectedFaceId]);
  const solverRunning = runProgress > 0 && runProgress < 100;
  const canUndoStep = stepHistoryIndex > 0;
  const canRedoStep = stepHistoryIndex < stepHistory.length - 1;
  const loadMarkers = useMemo<ViewerLoadMarker[]>(() => {
    if (!study) return [];
    const faceCounts = new Map<string, number>();
    const markers = study.loads.flatMap((load) => {
      const marker = loadMarkerFromLoad(load, study, 0);
      if (!marker) return [];
      const stackIndex = faceCounts.get(marker.faceId) ?? 0;
      faceCounts.set(marker.faceId, stackIndex + 1);
      return [{ ...marker, stackIndex }];
    });
    const selectedStackIndex = selectedFaceId ? faceCounts.get(selectedFaceId) ?? 0 : 0;
    const draftMarker = activeStep === "loads"
      ? createDraftLoadMarker({
        selectedFace,
        type: draftLoadType,
        value: draftLoadValue,
        directionLabel: draftLoadDirection,
        stackIndex: selectedStackIndex
      })
      : null;
    return draftMarker ? [...markers, draftMarker] : markers;
  }, [activeStep, draftLoadDirection, draftLoadType, draftLoadValue, selectedFace, selectedFaceId, study]);
  const supportMarkers = useMemo<ViewerSupportMarker[]>(() => {
    if (!study) return [];
    const faceCounts = new Map<string, number>();
    return study.constraints.flatMap((support) => {
      const selection = study.namedSelections.find((item) => item.id === support.selectionRef);
      const faceId = selection?.geometryRefs[0]?.entityId;
      if (!faceId) return [];
      const stackIndex = faceCounts.get(faceId) ?? 0;
      faceCounts.set(faceId, stackIndex + 1);
      return [{
        id: support.id,
        faceId,
        type: support.type,
        label: selection?.geometryRefs[0]?.label ?? selection?.name ?? "selected face",
        stackIndex
      }];
    });
  }, [study]);

  useEffect(() => {
    if (!project || !displayModel) return;
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveProject();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [displayModel, project]);

  async function openProjectResponse(action: Promise<{ project: Project; displayModel: DisplayModel; message?: string }>) {
    const response = await action;
    setProject(response.project);
    setDisplayModel(response.displayModel);
    applyStep("model");
    setStepHistory(["model"]);
    setStepHistoryIndex(0);
    setViewMode("model");
    pushMessage(response.message ?? "Project opened.");
  }

  async function handleLoadSample(nextSample = sampleModel) {
    setSampleModel(nextSample);
    await openProjectResponse(loadSampleProject(nextSample));
  }

  function handleCreateProject() {
    void openProjectResponse(createProject());
  }

  function handleOpenProject(file: File) {
    void openProjectResponse(importLocalProject(file)).catch((error: unknown) => {
      pushMessage(error instanceof Error ? error.message : "Could not open local project.");
    });
  }

  async function handleSaveProject() {
    if (!project || !displayModel) return;
    try {
      const savedAt = await saveProjectToLocalDisk(project, displayModel);
      setProject({ ...project, updatedAt: savedAt });
      pushMessage("Project saved to local disk.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      pushMessage(error instanceof Error ? error.message : "Could not save project.");
    }
  }

  function pushMessage(message: string) {
    setStatus(message);
    setLogs((current) => [message, ...current].slice(0, 32));
  }

  async function updateStudy(action: Promise<{ study: Study; message: string }>, nextStep?: StepId) {
    const response = await action;
    if (project) {
      setProject({ ...project, studies: project.studies.map((item) => (item.id === response.study.id ? response.study : item)) });
    }
    pushMessage(response.message);
    if (nextStep) navigateToStep(nextStep);
  }

  function applyStep(step: StepId) {
    setActiveStep(step);
    if (step === "results") {
      setViewMode("results");
      return;
    }
    if (["material", "supports", "loads", "mesh", "run"].includes(step) && viewMode === "results") {
      setViewMode("model");
    }
  }

  function navigateToStep(step: StepId) {
    if (step === activeStep) return;
    applyStep(step);
    setStepHistory((history) => {
      const nextHistory = [...history.slice(0, stepHistoryIndex + 1), step];
      setStepHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }

  function handleStepSelect(step: StepId) {
    navigateToStep(step);
  }

  function handleUndoStep() {
    if (!canUndoStep) return;
    const nextIndex = stepHistoryIndex - 1;
    const step = stepHistory[nextIndex];
    if (!step) return;
    setStepHistoryIndex(nextIndex);
    applyStep(step);
    pushMessage(`Returned to ${stepLabel(step)}.`);
  }

  function handleRedoStep() {
    if (!canRedoStep) return;
    const nextIndex = stepHistoryIndex + 1;
    const step = stepHistory[nextIndex];
    if (!step) return;
    setStepHistoryIndex(nextIndex);
    applyStep(step);
    pushMessage(`Moved to ${stepLabel(step)}.`);
  }

  async function handleRunSimulation() {
    if (!study) return;
    const response = await runSimulation(study.id);
    setActiveRunId(response.run.id);
    setRunProgress(0);
    pushMessage(response.message);
    const source = subscribeToRun(response.run.id, async (event: RunEvent) => {
      if (typeof event.progress === "number") setRunProgress(event.progress);
      pushMessage(event.message);
      if (event.type === "complete") {
        source.close();
        const results = await getResults(response.run.id);
        setResultSummary(results.summary);
        setViewMode("results");
        setActiveStep("results");
      }
    });
  }

  if (!project || !displayModel || !study) {
    return <StartScreen onLoadSample={handleLoadSample} onCreateProject={handleCreateProject} onOpenProject={handleOpenProject} />;
  }

  return (
    <div className={`app-shell theme-${themeMode}`}>
      <header className="topbar">
        <div className="brand"><TopbarMark />OpenCAE</div>
        <div className="topbar-divider topbar-divider-project" />
        <div className="breadcrumb">
          <span className="breadcrumb-chip">{project.name}</span>
          <span className="breadcrumb-sep">/</span>
          <span>{study.name}</span>
        </div>
        <div className="topbar-tools" aria-label="Workspace tools">
          <button className="icon-button" type="button" title="Previous workflow step" aria-label="Previous workflow step" disabled={!canUndoStep} onClick={handleUndoStep}><UndoIcon /></button>
          <button className="icon-button" type="button" title="Next workflow step" aria-label="Next workflow step" disabled={!canRedoStep} onClick={handleRedoStep}><RedoIcon /></button>
          <button
            className="icon-button"
            type="button"
            title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => setThemeMode((mode) => (mode === "dark" ? "light" : "dark"))}
          >
            {themeMode === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
        <button className={`primary topbar-action ${solverRunning ? "running" : ""}`} onClick={handleRunSimulation}>
          <span aria-hidden="true">▶</span>{solverRunning ? "Running…" : "Run simulation"}
        </button>
        <button className="secondary topbar-action" type="button" onClick={handleSaveProject} title="Save project to local disk">
          <Save size={16} aria-hidden="true" />
          Save project
        </button>
        <span className="local-pill"><span aria-hidden="true" />local</span>
      </header>

      <main className="workspace">
        <StepBar activeStep={activeStep} onSelect={handleStepSelect} study={study} hasResults={viewMode === "results"} />
        <CadViewer
          displayModel={displayModel}
          activeStep={activeStep}
          selectedFaceId={selectedFaceId}
          onSelectFace={(face) => {
            setSelectedFaceId(face.id);
            pushMessage(`${face.label} selected.`);
          }}
          viewMode={viewMode}
          resultMode={resultMode}
          showDeformed={showDeformed}
          stressExaggeration={stressExaggeration}
          themeMode={themeMode}
          fitSignal={fitSignal}
          loadMarkers={loadMarkers}
          supportMarkers={supportMarkers}
          onResetView={() => setFitSignal((value) => value + 1)}
        />
        <RightPanel
          activeStep={activeStep}
          project={project}
          study={study}
          selectedFace={selectedFace}
          viewMode={viewMode}
          resultMode={resultMode}
          showDeformed={showDeformed}
          stressExaggeration={stressExaggeration}
          resultSummary={resultSummary}
          runProgress={runProgress}
          sampleModel={sampleModel}
          draftLoadType={draftLoadType}
          draftLoadValue={draftLoadValue}
          draftLoadDirection={draftLoadDirection}
          onFitView={() => setFitSignal((value) => value + 1)}
          onLoadSample={handleLoadSample}
          onSampleModelChange={handleLoadSample}
          onViewModeChange={setViewMode}
          onResultModeChange={setResultMode}
          onToggleDeformed={() => setShowDeformed((value) => !value)}
          onStressExaggerationChange={setStressExaggeration}
          onAssignMaterial={(materialId) => updateStudy(assignMaterial(study.id, materialId), "supports")}
          onAddSupport={(selectionRef) => updateStudy(addSupport(study.id, selectionRef))}
          onUpdateSupport={(support: Constraint) =>
            updateStudy(
              saveStudyPatch(
                study.id,
                { constraints: study.constraints.map((item) => (item.id === support.id ? support : item)) },
                "Support updated."
              )
            )
          }
          onDraftLoadTypeChange={setDraftLoadType}
          onDraftLoadValueChange={setDraftLoadValue}
          onDraftLoadDirectionChange={setDraftLoadDirection}
          onAddLoad={(type, value, selectionRef, direction) => {
            const selection = study.namedSelections.find((item) => item.id === selectionRef);
            const faceId = selection?.geometryRefs[0]?.entityId;
            const face = selectedFace?.id === faceId ? selectedFace : displayModel.faces.find((item) => item.id === faceId);
            if (face) updateStudy(addLoad(study.id, type, value, selectionRef, directionVectorForLabel(direction, face)));
          }}
          onUpdateLoad={(load: Load) =>
            updateStudy(
              saveStudyPatch(study.id, { loads: study.loads.map((item) => (item.id === load.id ? load : item)) }, "Load updated.")
            )
          }
          onGenerateMesh={(preset) => updateStudy(generateMesh(study.id, preset), "run")}
          onRunSimulation={handleRunSimulation}
          onGenerateReport={() => window.open(`/api/runs/${activeRunId}/report`, "_blank", "noopener,noreferrer")}
        />
      </main>

      <BottomPanel status={status} logs={logs} projectName={project.name} studyName={study.name} meshStatus={study.meshSettings.status === "complete" ? "Ready" : "Not generated"} solverStatus={solverRunning ? "Running" : runProgress >= 100 ? "Complete" : "Idle"} />
    </div>
  );
}

function stepLabel(step: StepId) {
  return step.charAt(0).toUpperCase() + step.slice(1);
}

async function saveProjectToLocalDisk(project: Project, displayModel: DisplayModel): Promise<string> {
  const savedAt = new Date().toISOString();
  const filename = suggestedProjectFilename(project.name);
  const blob = new Blob([JSON.stringify(buildLocalProjectFile(project, displayModel, savedAt), null, 2)], {
    type: "application/json"
  });
  const savePicker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (savePicker) {
    const handle = await savePicker({
      suggestedName: filename,
      types: [{ description: "OpenCAE project", accept: { "application/json": [".json", ".opencae"] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return savedAt;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return savedAt;
}

function TopbarMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 1.8 15.2 5.4v7.2L9 16.2l-6.2-3.6V5.4L9 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.6 6.9 9 5l3.4 1.9v4.2L9 13l-3.4-1.9V6.9Z" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.68" />
    </svg>
  );
}

function UndoIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M7 5H3v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M3.5 8.5A5.4 5.4 0 1 0 5 4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function RedoIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M11 5h4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M14.5 8.5A5.4 5.4 0 1 1 13 4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function SunIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 5.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M9 1.5v1.8M9 14.7v1.8M1.5 9h1.8M14.7 9h1.8M3.7 3.7 5 5M13 13l1.3 1.3M14.3 3.7 13 5M5 13l-1.3 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}

function MoonIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M14.7 11.6A6.6 6.6 0 0 1 6.4 3.3a6.2 6.2 0 1 0 8.3 8.3Z" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
