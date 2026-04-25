import { useEffect, useMemo, useState } from "react";
import type { Constraint, DisplayModel, Load, Project, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";
import { RotateCcw, Save } from "lucide-react";
import { addLoad, addSupport, assignMaterial, createProject, generateMesh, getResults, importLocalProject, loadSampleProject, renameProject, runSimulation, subscribeToRun, updateStudy as saveStudyPatch, uploadModel, type SampleModelId } from "./lib/api";
import { BottomPanel } from "./components/BottomPanel";
import { RightPanel } from "./components/RightPanel";
import { StartScreen } from "./components/StartScreen";
import { StepBar, type StepId } from "./components/StepBar";
import { CadViewer, type ResultMode, type ViewMode } from "./components/CadViewer";
import type { ViewerLoadMarker, ViewerSupportMarker } from "./components/CadViewer";
import {
  createViewerLoadMarkers,
  directionVectorForLabel,
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
  const [undoStack, setUndoStack] = useState<Project[]>([]);
  const [redoStack, setRedoStack] = useState<Project[]>([]);
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
  const [completedRunId, setCompletedRunId] = useState("run-bracket-demo-seeded");
  const [resultSummary, setResultSummary] = useState<ResultSummary>(seededSummary);
  const [resultFields, setResultFields] = useState<ResultField[]>([]);
  const [draftLoadType, setDraftLoadType] = useState<LoadType>("force");
  const [draftLoadValue, setDraftLoadValue] = useState(500);
  const [draftLoadDirection, setDraftLoadDirection] = useState<LoadDirectionLabel>("-Y");
  const [loadEditorActive, setLoadEditorActive] = useState(false);
  const [sampleModel, setSampleModel] = useState<SampleModelId>("bracket");

  const study = project?.studies[0] ?? null;
  const reportRunId = useMemo(() => {
    if (completedRunId) return completedRunId;
    if (runProgress >= 100 && activeRunId) return activeRunId;
    return latestReportRunId(study, "");
  }, [activeRunId, completedRunId, runProgress, study]);
  const reportDownloadUrl = reportRunId ? `/api/runs/${reportRunId}/report.pdf` : project ? `/api/projects/${project.id}/report.pdf` : undefined;
  const selectedFace = useMemo(() => displayModel?.faces.find((face) => face.id === selectedFaceId) ?? null, [displayModel, selectedFaceId]);
  const solverRunning = runProgress > 0 && runProgress < 100;
  const canUndoAction = undoStack.length > 0;
  const canRedoAction = redoStack.length > 0;
  const loadMarkers = useMemo<ViewerLoadMarker[]>(() => {
    return createViewerLoadMarkers({
      study,
      selectedFace,
      draftLoad: { type: draftLoadType, value: draftLoadValue, directionLabel: draftLoadDirection },
      includeDraftPreview: activeStep === "loads" && !loadEditorActive
    });
  }, [activeStep, draftLoadDirection, draftLoadType, draftLoadValue, loadEditorActive, selectedFace, study]);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedoAction();
        } else {
          handleUndoAction();
        }
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [displayModel, project, undoStack, redoStack]);

  async function openProjectResponse(action: Promise<{ project: Project; displayModel: DisplayModel; message?: string }>) {
    const response = await action;
    setProject(response.project);
    setDisplayModel(response.displayModel);
    applyStep("model");
    setUndoStack([]);
    setRedoStack([]);
    setViewMode("model");
    setResultFields([]);
    const nextCompletedRunId = latestReportRunId(response.project.studies[0] ?? null, "") ?? "";
    setActiveRunId(nextCompletedRunId);
    setCompletedRunId(nextCompletedRunId);
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

  function handleUploadModel(file: File) {
    if (!project) return;
    void openProjectResponse(uploadModel(project.id, file)).catch((error: unknown) => {
      pushMessage(error instanceof Error ? error.message : "Could not upload model.");
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
      recordUndoSnapshot(project);
      setProject({ ...project, studies: project.studies.map((item) => (item.id === response.study.id ? response.study : item)) });
    }
    pushMessage(response.message);
    if (nextStep) navigateToStep(nextStep);
  }

  async function handleRenameProject(name: string) {
    if (!project) return;
    const nextName = name.trim().replace(/\s+/g, " ");
    if (!nextName || nextName === project.name) return;
    try {
      const response = await renameProject(project.id, nextName);
      recordUndoSnapshot(project);
      setProject(response.project);
      pushMessage(response.message);
    } catch (error) {
      pushMessage(error instanceof Error ? error.message : "Could not rename project.");
    }
  }

  function recordUndoSnapshot(snapshot: Project) {
    setUndoStack((history) => [...history, structuredClone(snapshot)].slice(-30));
    setRedoStack([]);
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
  }

  function handleStepSelect(step: StepId) {
    navigateToStep(step);
  }

  function handleUndoAction() {
    if (!project || !canUndoAction) return;
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, structuredClone(project)]);
    setProject(structuredClone(previous));
    void persistProjectSnapshot(previous, "Undo applied.");
  }

  function handleRedoAction() {
    if (!project || !canRedoAction) return;
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, structuredClone(project)].slice(-30));
    setProject(structuredClone(next));
    void persistProjectSnapshot(next, "Redo applied.");
  }

  async function persistProjectSnapshot(snapshot: Project, message: string) {
    const snapshotStudy = snapshot.studies[0];
    if (!snapshotStudy) return;
    try {
      await saveStudyPatch(snapshotStudy.id, snapshotStudy, message);
      pushMessage(message);
    } catch (error) {
      pushMessage(error instanceof Error ? error.message : "Could not update undo history.");
    }
  }

  async function handleRunSimulation() {
    if (!study) return;
    const response = await runSimulation(study.id);
    setActiveRunId(response.run.id);
    setCompletedRunId("");
    setRunProgress(0);
    pushMessage(response.message);
    const source = subscribeToRun(response.run.id, async (event: RunEvent) => {
      if (typeof event.progress === "number") setRunProgress(event.progress);
      pushMessage(event.message);
      if (event.type === "complete") {
        source.close();
        const results = await getResults(response.run.id);
        setResultSummary(results.summary);
        setResultFields(results.fields);
        setCompletedRunId(response.run.id);
        setViewMode("results");
        setActiveStep("results");
      }
    });
  }

  function handleGenerateReport() {
    if (!reportDownloadUrl) {
      pushMessage("Run the simulation before generating a report.");
      return;
    }
    pushMessage("PDF report download started.");
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
          <ProjectNameChip name={project.name} onRename={handleRenameProject} />
          <span className="breadcrumb-sep">/</span>
          <span>{study.name}</span>
        </div>
        <div className="topbar-tools" aria-label="Workspace tools">
          <div className="history-tools" role="group" aria-label="Undo and redo">
            <button className="icon-button history-button" type="button" title="Undo last change" aria-label="Undo last change" disabled={!canUndoAction} onClick={handleUndoAction}><UndoIcon /></button>
            <button className="icon-button history-button" type="button" title="Redo last change" aria-label="Redo last change" disabled={!canRedoAction} onClick={handleRedoAction}><RedoIcon /></button>
          </div>
          <button
            className="icon-button theme-button"
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
          resultFields={resultFields}
          themeMode={themeMode}
          fitSignal={fitSignal}
          loadMarkers={loadMarkers}
          supportMarkers={supportMarkers}
          onResetView={() => setFitSignal((value) => value + 1)}
        />
        <RightPanel
          activeStep={activeStep}
          project={project}
          displayModel={displayModel}
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
          onUploadModel={handleUploadModel}
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
          onLoadEditorActiveChange={setLoadEditorActive}
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
          canGenerateReport={Boolean(reportDownloadUrl)}
          reportUrl={reportDownloadUrl}
          reportFilename={`${project.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "opencae"}-report.pdf`}
          onGenerateReport={handleGenerateReport}
          onStepSelect={handleStepSelect}
        />
      </main>

      <BottomPanel status={status} logs={logs} projectName={project.name} studyName={study.name} meshStatus={study.meshSettings.status === "complete" ? "Ready" : "Not generated"} solverStatus={solverRunning ? "Running" : runProgress >= 100 ? "Complete" : "Idle"} />
    </div>
  );
}

function ProjectNameChip({ name, onRename }: { name: string; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  useEffect(() => {
    if (!editing) setDraftName(name);
  }, [editing, name]);

  async function commitName() {
    const nextName = draftName.trim().replace(/\s+/g, " ");
    setEditing(false);
    if (nextName) await onRename(nextName);
  }

  if (editing) {
    return (
      <input
        className="breadcrumb-chip breadcrumb-input"
        value={draftName}
        autoFocus
        onChange={(event) => setDraftName(event.currentTarget.value)}
        onBlur={() => void commitName()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commitName();
          if (event.key === "Escape") {
            setDraftName(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button className="breadcrumb-chip breadcrumb-button" type="button" onClick={() => setEditing(true)} title="Rename project">
      {name}
    </button>
  );
}

function latestReportRunId(study: Study | null, activeRunId: string): string | null {
  if (!study) return null;
  if (study.runs.some((run) => run.id === activeRunId && (run.reportRef || run.resultRef || run.status === "complete"))) return activeRunId;
  const completed = [...study.runs].reverse().find((run) => run.reportRef || run.resultRef || run.status === "complete");
  return completed?.id ?? null;
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
  return <RotateCcw size={18} aria-hidden="true" />;
}

function RedoIcon() {
  return <RotateCcw className="redo-icon" size={18} aria-hidden="true" />;
}

function SunIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 5.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M9 1.5v1.8M9 14.7v1.8M1.5 9h1.8M14.7 9h1.8M3.7 3.7 5 5M13 13l1.3 1.3M14.3 3.7 13 5M5 13l-1.3 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}

function MoonIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M14.7 11.6A6.6 6.6 0 0 1 6.4 3.3a6.2 6.2 0 1 0 8.3 8.3Z" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
