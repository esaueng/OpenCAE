import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Constraint, DisplayFace, DisplayModel, DynamicSolverSettings, Load, NamedSelection, Project, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";
import { RotateCcw, Save } from "lucide-react";
import { addLoad, addSupport, assignMaterial, createProject, generateMesh, getResults, importLocalProject, loadSampleProject, renameProject, runSimulation, subscribeToRun, updateStudy as saveStudyPatch, uploadModel, type SampleModelId } from "./lib/api";
import { normalizePrintParameters, starterMaterials } from "@opencae/materials";
import { BottomPanel } from "./components/BottomPanel";
import { OpenCaeLogoMark } from "./components/OpenCaeLogoMark";
import { RightPanel } from "./components/RightPanel";
import { StartScreen } from "./components/StartScreen";
import { StepBar, type StepId } from "./components/StepBar";
import { BoundaryConditionMenu, CreateSimulationModal } from "./components/SimulationWorkflow";
import { CadViewer, type PrintLayerOrientation, type ResultMode, type ViewMode } from "./components/CadViewer";
import type { ViewerLoadMarker, ViewerSupportMarker } from "./components/CadViewer";
import {
  createViewerLoadMarkers,
  directionVectorForLabel,
  unitsForLoadType,
  type DraftLoadPreview,
  type LoadDirectionLabel,
  type PayloadObjectSelection,
  type PayloadLoadMetadata,
  type LoadType
} from "./loadPreview";
import { resetDisplayModelOrientation, type RotationAxis } from "./modelOrientation";
import { buildLocalProjectFile, suggestedProjectFilename, type LocalResultBundle } from "./projectFile";
import { buildAutosavedWorkspace, readAutosavedWorkspace, writeAutosavedWorkspace, type ThemeMode } from "./appPersistence";
import {
  canNavigateToStep,
  printLayerOrientationForViewer,
  shouldAutoAdvanceAfterMaterialAssignment,
  shouldAutoAdvanceAfterMeshGeneration,
  shouldShowStartScreen
} from "./appShellState";
import { displayModelForUnits, loadValueForUnits, resultFieldForUnits, resultSummaryForUnits, type UnitSystem } from "./unitDisplay";
import { supportDisplayLabel } from "./supportLabels";
import { nextSelectedPayloadObject, shouldClearPayloadSelectionOnViewerMiss } from "./payloadSelection";
import { createLocalDynamicStructuralStudy, createLocalStaticStressStudy } from "./localProjectFactory";

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

export function App() {
  const restoredWorkspace = useMemo(() => readAutosavedWorkspace(), []);
  const restoredProjectFile = restoredWorkspace?.projectFile;
  const restoredUi = restoredWorkspace?.ui;
  const restoredResults = restoredProjectFile?.results;
  const [project, setProject] = useState<Project | null>(restoredProjectFile?.project ?? null);
  const [displayModel, setDisplayModel] = useState<DisplayModel | null>(restoredProjectFile?.displayModel ?? null);
  const [homeRequested, setHomeRequested] = useState(restoredUi?.homeRequested ?? !restoredProjectFile);
  const [activeStep, setActiveStep] = useState<StepId>(restoredUi?.activeStep ?? "model");
  const [undoStack, setUndoStack] = useState<Project[]>(restoredUi?.undoStack ?? []);
  const [redoStack, setRedoStack] = useState<Project[]>(restoredUi?.redoStack ?? []);
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(restoredUi?.selectedFaceId ?? null);
  const [selectedLoadPoint, setSelectedLoadPoint] = useState<[number, number, number] | null>(restoredUi?.selectedLoadPoint ?? null);
  const [selectedPayloadObject, setSelectedPayloadObject] = useState<PayloadObjectSelection | null>(restoredUi?.selectedPayloadObject ?? null);
  const [viewMode, setViewMode] = useState<ViewMode>(restoredUi?.viewMode ?? (restoredResults?.fields.length ? "results" : "model"));
  const [themeMode, setThemeMode] = useState<ThemeMode>(restoredUi?.themeMode ?? "dark");
  const [resultMode, setResultMode] = useState<ResultMode>(restoredUi?.resultMode ?? "stress");
  const [showDeformed, setShowDeformed] = useState(restoredUi?.showDeformed ?? false);
  const [showDimensions, setShowDimensions] = useState(restoredUi?.showDimensions ?? false);
  const [stressExaggeration, setStressExaggeration] = useState(restoredUi?.stressExaggeration ?? 1.8);
  const [fitSignal, setFitSignal] = useState(0);
  const [viewAxis, setViewAxis] = useState<RotationAxis | null>(null);
  const [viewAxisSignal, setViewAxisSignal] = useState(0);
  const [status, setStatus] = useState(restoredUi?.status ?? (restoredProjectFile ? "Workspace restored after reload." : "Ready"));
  const [logs, setLogs] = useState<string[]>(restoredUi?.logs.length ? restoredUi.logs : restoredProjectFile ? ["Workspace restored after reload.", "Ready | Local Mode"] : ["Ready | Local Mode"]);
  const [runProgress, setRunProgress] = useState(restoredUi?.runProgress ?? (restoredResults?.fields.length ? 100 : 0));
  const [activeRunId, setActiveRunId] = useState(restoredUi?.activeRunId || restoredResults?.activeRunId || restoredResults?.completedRunId || "run-bracket-demo-seeded");
  const [completedRunId, setCompletedRunId] = useState(restoredUi?.completedRunId || restoredResults?.completedRunId || "run-bracket-demo-seeded");
  const [resultSummary, setResultSummary] = useState<ResultSummary>(restoredResults?.summary ?? seededSummary);
  const [resultFields, setResultFields] = useState<ResultField[]>(restoredResults?.fields ?? []);
  const [resultFrameIndex, setResultFrameIndex] = useState(0);
  const [draftLoadType, setDraftLoadType] = useState<LoadType>(restoredUi?.draftLoadType ?? "force");
  const [draftLoadValue, setDraftLoadValue] = useState(restoredUi?.draftLoadValue ?? 500);
  const [draftLoadDirection, setDraftLoadDirection] = useState<LoadDirectionLabel>(restoredUi?.draftLoadDirection ?? "-Z");
  const [draftPayloadPreview, setDraftPayloadPreview] = useState<{ value: number; metadata: PayloadLoadMetadata } | null>(null);
  const [previewLoadEdit, setPreviewLoadEdit] = useState<Load | null>(null);
  const [sampleModel, setSampleModel] = useState<SampleModelId>(restoredUi?.sampleModel ?? "bracket");
  const [previewPrintLayerOrientation, setPreviewPrintLayerOrientation] = useState<PrintLayerOrientation | null | undefined>(undefined);
  const [isStepbarCollapsed, setIsStepbarCollapsed] = useState(false);
  const [showCreateSimulation, setShowCreateSimulation] = useState(false);
  const [showBoundaryConditionMenu, setShowBoundaryConditionMenu] = useState(false);
  const didRequestRestoredHomeView = useRef(false);

  const study = project?.studies[0] ?? null;
  const assignedPrintLayerOrientation = useMemo<PrintLayerOrientation | null>(() => {
    const assignment = study?.materialAssignments[0];
    if (!assignment) return null;
    const material = starterMaterials.find((candidate) => candidate.id === assignment.materialId);
    if (!material?.printProfile) return null;
    const parameters = normalizePrintParameters(material, assignment.parameters ?? {});
    return parameters.printed ? parameters.layerOrientation ?? "z" : null;
  }, [study?.materialAssignments]);
  const printLayerOrientation = printLayerOrientationForViewer(assignedPrintLayerOrientation, previewPrintLayerOrientation);
  const selectedFace = useMemo(() => displayModel?.faces.find((face) => face.id === selectedFaceId) ?? null, [displayModel, selectedFaceId]);
  const displayUnitSystem = project?.unitSystem ?? "SI";
  const displayModelForUi = useMemo(() => displayModel ? displayModelForUnits(displayModel, displayUnitSystem) : null, [displayModel, displayUnitSystem]);
  const resultSummaryForUi = useMemo(() => resultSummaryForUnits(resultSummary, displayUnitSystem), [displayUnitSystem, resultSummary]);
  const resultFieldsForUi = useMemo(() => resultFields.map((field) => resultFieldForUnits(field, displayUnitSystem)), [displayUnitSystem, resultFields]);
  const visibleResultFieldsForUi = useMemo(() => fieldsForResultFrame(resultFieldsForUi, resultFrameIndex), [resultFieldsForUi, resultFrameIndex]);
  const solverRunning = runProgress > 0 && runProgress < 100;
  const runReadiness = useMemo(() => readinessForStudy(study), [study]);
  const canRunSimulation = runReadiness.every((item) => item.done) && !solverRunning;
  const missingRunItems = runReadiness.filter((item) => !item.done).map((item) => item.label);
  const canUndoAction = undoStack.length > 0;
  const canRedoAction = redoStack.length > 0;

  useEffect(() => {
    if (didRequestRestoredHomeView.current) return;
    if (!restoredProjectFile || homeRequested || !project || !displayModel) return;
    didRequestRestoredHomeView.current = true;
    requestDefaultHomeView();
  }, [displayModel, homeRequested, project, restoredProjectFile]);

  const handleMeasureDisplayModelDimensions = useCallback((dimensions: NonNullable<DisplayModel["dimensions"]>) => {
    setDisplayModel((current) => {
      if (!current?.nativeCad) return current;
      if (
        current.dimensions?.x === dimensions.x &&
        current.dimensions?.y === dimensions.y &&
        current.dimensions?.z === dimensions.z &&
        current.dimensions?.units === dimensions.units
      ) {
        return current;
      }
      return { ...current, dimensions };
    });
  }, []);

  useEffect(() => {
    if (draftLoadType !== "gravity" && selectedPayloadObject) {
      setSelectedPayloadObject(null);
    }
  }, [draftLoadType, selectedPayloadObject]);

  useEffect(() => {
    if (activeStep !== "loads") setPreviewLoadEdit(null);
  }, [activeStep]);

  const draftLoadPreview = useMemo<DraftLoadPreview | undefined>(() => {
    if (!study || activeStep !== "loads") return undefined;
    const isPayloadMass = draftLoadType === "gravity";
    const face = isPayloadMass && selectedPayloadObject ? faceForPayloadObject(selectedPayloadObject) : selectedFace;
    const point = isPayloadMass ? selectedPayloadObject?.center ?? null : selectedLoadPoint;
    if (!face || !point) return undefined;
    const existingSelection = study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === face.id));
    const selection = existingSelection ?? namedSelectionForFace(study, face);
    const value = isPayloadMass ? draftPayloadPreview?.value ?? draftLoadValue : draftLoadValue;
    const payloadMetadata = isPayloadMass ? draftPayloadPreview?.metadata ?? {} : {};
    return {
      selection,
      load: {
        id: "draft-load-preview",
        type: draftLoadType,
        selectionRef: selection.id,
        parameters: {
          value,
          units: unitsForLoadType(draftLoadType),
          direction: directionVectorForLabel(draftLoadDirection, face),
          applicationPoint: point,
          ...(isPayloadMass && selectedPayloadObject ? { payloadObject: selectedPayloadObject } : {}),
          ...payloadMetadata
        },
        status: "complete"
      }
    };
  }, [activeStep, draftLoadDirection, draftLoadType, draftLoadValue, draftPayloadPreview, selectedFace, selectedLoadPoint, selectedPayloadObject, study]);

  const loadMarkers = useMemo<ViewerLoadMarker[]>(() => {
    const markers = createViewerLoadMarkers({ study, loadPreviews: previewLoadEdit ? [previewLoadEdit] : [], draftLoadPreview });
    return markers.map((marker) => {
      const converted = loadValueForUnits(marker.value, marker.units, displayUnitSystem);
      return { ...marker, value: converted.value, units: converted.units };
    });
  }, [displayUnitSystem, draftLoadPreview, previewLoadEdit, study]);
  const supportMarkers = useMemo<ViewerSupportMarker[]>(() => {
    if (!study) return [];
    const faceCounts = new Map<string, number>();
    let fixedSupportCount = 0;
    let prescribedSupportCount = 0;
    return study.constraints.flatMap((support) => {
      const selection = study.namedSelections.find((item) => item.id === support.selectionRef);
      const faceId = selection?.geometryRefs[0]?.entityId;
      if (!faceId) return [];
      const stackIndex = faceCounts.get(faceId) ?? 0;
      faceCounts.set(faceId, stackIndex + 1);
      const supportOrdinal = support.type === "fixed" ? ++fixedSupportCount : ++prescribedSupportCount;
      return [{
        id: support.id,
        faceId,
        type: support.type,
        displayLabel: supportDisplayLabel(support, supportOrdinal),
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

  useEffect(() => {
    if (!project || !displayModel) return;
    writeAutosavedWorkspace(buildAutosavedWorkspace({
      project,
      displayModel,
      results: resultFields.length ? {
        activeRunId,
        completedRunId,
        summary: resultSummary,
        fields: resultFields
      } : undefined,
      ui: {
        activeStep,
        homeRequested,
        selectedFaceId,
        selectedLoadPoint,
        selectedPayloadObject,
        viewMode,
        themeMode,
        resultMode,
        showDeformed,
        showDimensions,
        stressExaggeration,
        draftLoadType,
        draftLoadValue,
        draftLoadDirection,
        sampleModel,
        activeRunId,
        completedRunId,
        runProgress,
        undoStack,
        redoStack,
        status,
        logs
      }
    }));
  }, [
    activeRunId,
    activeStep,
    completedRunId,
    displayModel,
    draftLoadDirection,
    draftLoadType,
    draftLoadValue,
    homeRequested,
    logs,
    project,
    redoStack,
    resultFields,
    resultMode,
    resultSummary,
    runProgress,
    sampleModel,
    selectedLoadPoint,
    selectedPayloadObject,
    selectedFaceId,
    showDeformed,
    showDimensions,
    status,
    stressExaggeration,
    themeMode,
    undoStack,
    viewMode
  ]);

  async function openProjectResponse(action: Promise<{ project: Project; displayModel: DisplayModel; message?: string; results?: LocalResultBundle }>) {
    const response = await action;
    setHomeRequested(false);
    setProject(response.project);
    setDisplayModel(response.displayModel);
    requestDefaultHomeView();
    setUndoStack([]);
    setRedoStack([]);
    setSelectedLoadPoint(null);
    setSelectedPayloadObject(null);
    setShowCreateSimulation(!response.project.studies.length);
    if (response.results?.fields.length) {
      setResultSummary(response.results.summary);
      setResultFields(response.results.fields);
      setResultFrameIndex(0);
      const restoredRunId = response.results.completedRunId ?? response.results.activeRunId ?? latestCompletedRunId(response.project.studies[0] ?? null, "") ?? "";
      setActiveRunId(response.results.activeRunId ?? restoredRunId);
      setCompletedRunId(restoredRunId);
      setRunProgress(100);
      setViewMode("results");
      setActiveStep("results");
    } else {
      applyStep("model");
      setViewMode("model");
      setResultFields([]);
      setResultFrameIndex(0);
      setRunProgress(0);
      const nextCompletedRunId = latestCompletedRunId(response.project.studies[0] ?? null, "") ?? "";
      setActiveRunId(nextCompletedRunId);
      setCompletedRunId(nextCompletedRunId);
    }
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
    void openProjectResponse(uploadModel(project.id, file, project)).catch((error: unknown) => {
      pushMessage(error instanceof Error ? error.message : "Could not upload model.");
    });
  }

  async function handleSaveProject() {
    if (!project || !displayModel) return;
    try {
      const savedAt = await saveProjectToLocalDisk(project, displayModel, {
        activeRunId,
        completedRunId,
        summary: resultSummary,
        fields: resultFields
      });
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

  function handleViewportFaceSelect(face: DisplayFace, point?: [number, number, number], payloadObject?: PayloadObjectSelection) {
    setSelectedFaceId(face.id);
    const isPayloadObjectLoad = activeStep === "loads" && draftLoadType === "gravity";
    const nextLoadPoint = activeStep === "loads" ? (isPayloadObjectLoad ? payloadObject?.center ?? selectedPayloadObject?.center ?? point ?? face.center : point ?? face.center) : null;
    setSelectedPayloadObject((current) => nextSelectedPayloadObject({ activeStep, draftLoadType, current, payloadObject }));
    setSelectedLoadPoint(nextLoadPoint);
    if (displayModel && !displayModel.faces.some((item) => item.id === face.id)) {
      setDisplayModel({ ...displayModel, faces: [...displayModel.faces, face] });
    }
    if (activeStep === "supports") {
      void addFixedSupportForFace(face);
      return;
    }
    pushMessage(`${face.label} selected.`);
  }

  function handleViewerMiss() {
    if (!shouldClearPayloadSelectionOnViewerMiss({ activeStep, draftLoadType })) return;
    setSelectedPayloadObject(null);
    setSelectedLoadPoint(null);
  }

  async function addFixedSupportForFace(face: DisplayFace) {
    if (!study) return;
    const existingSelection = study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === face.id));
    const selection = existingSelection ?? namedSelectionForFace(study, face);
    if (study.constraints.some((support) => support.selectionRef === selection.id)) {
      pushMessage(`Fixed support already exists on ${selection.name}.`);
      return;
    }
    const nextSelections = existingSelection ? study.namedSelections : [...study.namedSelections, selection];
    const nextSupport: Constraint = {
      id: `constraint-${crypto.randomUUID()}`,
      type: "fixed",
      selectionRef: selection.id,
      parameters: {},
      status: "complete"
    };
    await updateStudy(
      saveStudyPatch(study.id, { namedSelections: nextSelections, constraints: [...study.constraints, nextSupport] }, "Fixed support added.", study)
    );
  }

  async function addLoadForFace(type: LoadType, value: number, face: DisplayFace, direction: LoadDirectionLabel, applicationPoint?: [number, number, number] | null, payloadObject?: PayloadObjectSelection | null, payloadMetadata: PayloadLoadMetadata = {}) {
    if (!study) return;
    const existingSelection = study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === face.id));
    const selection = existingSelection ?? namedSelectionForFace(study, face);
    const nextSelections = existingSelection ? study.namedSelections : [...study.namedSelections, selection];
    const load: Load = {
      id: `load-${crypto.randomUUID()}`,
      type,
      selectionRef: selection.id,
      parameters: { value, units: unitsForLoadType(type), direction: directionVectorForLabel(direction, face), ...(applicationPoint ? { applicationPoint } : {}), ...(payloadObject ? { payloadObject } : {}), ...(type === "gravity" ? payloadMetadata : {}) },
      status: "complete"
    };
    await updateStudy(
      saveStudyPatch(study.id, { namedSelections: nextSelections, loads: [...study.loads, load] }, "Load added.", study)
    );
  }

  async function handleRenameProject(name: string) {
    if (!project) return;
    const nextName = name.trim().replace(/\s+/g, " ");
    if (!nextName || nextName === project.name) return;
    try {
      const response = await renameProject(project.id, nextName, project);
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
    if (!canNavigateToStep(step, { meshStatus: study?.meshSettings.status ?? "not_started" })) {
      pushMessage("Generate the mesh before going to Run.");
      return;
    }
    applyStep(step);
  }

  function handleStepSelect(step: StepId) {
    navigateToStep(step);
  }

  function handleCreateStaticSimulation() {
    if (!project || !displayModel) return;
    const nextStudy = createLocalStaticStressStudy(project, displayModel);
    const nextProject = { ...project, studies: [nextStudy], updatedAt: new Date().toISOString() };
    recordUndoSnapshot(project);
    setProject(nextProject);
    setShowCreateSimulation(false);
    applyStep(displayModel.bodyCount > 0 ? "material" : "model");
    pushMessage("Static simulation created.");
  }

  function handleCreateDynamicSimulation() {
    if (!project || !displayModel) return;
    const nextStudy = createLocalDynamicStructuralStudy(project, displayModel);
    const nextProject = { ...project, studies: [nextStudy], updatedAt: new Date().toISOString() };
    recordUndoSnapshot(project);
    setProject(nextProject);
    setShowCreateSimulation(false);
    applyStep(displayModel.bodyCount > 0 ? "material" : "model");
    pushMessage("Dynamic structural simulation created.");
  }

  function handleUpdateSolverSettings(settings: Partial<DynamicSolverSettings>) {
    if (!study || study.type !== "dynamic_structural") return;
    void updateStudy(
      saveStudyPatch(
        study.id,
        { solverSettings: { ...study.solverSettings, ...settings } },
        "Dynamic settings updated.",
        study
      )
    );
  }

  function handleBoundaryConditionType(type: "fixed" | "prescribed_displacement" | "force" | "pressure" | "gravity") {
    setShowBoundaryConditionMenu(false);
    if (type === "fixed" || type === "prescribed_displacement") {
      applyStep("supports");
      if (type === "fixed" && selectedFace) void addFixedSupportForFace(selectedFace);
      return;
    }
    setDraftLoadType(type);
    setDraftLoadValue(defaultValueForLoadType(type));
    applyStep("loads");
  }

  function handleRotateModel(axis: RotationAxis) {
    setViewAxis(axis);
    setViewAxisSignal((value) => value + 1);
    pushMessage(`View aligned perpendicular to ${axis.toUpperCase()} axis.`);
  }

  function handleResetModelOrientation() {
    setDisplayModel((current) => (current ? resetDisplayModelOrientation(current) : current));
    requestDefaultHomeView();
    pushMessage("Model orientation reset.");
  }

  function requestDefaultHomeView() {
    setViewAxis(null);
    setFitSignal((value) => value + 1);
  }

  function handleFitDefaultView() {
    requestDefaultHomeView();
  }

  function handleUnitSystemChange(unitSystem: UnitSystem) {
    if (!project || project.unitSystem === unitSystem) return;
    recordUndoSnapshot(project);
    setProject({ ...project, unitSystem });
    pushMessage(`Project units switched to ${unitSystem === "SI" ? "metric" : "imperial"}.`);
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
    if (!canRunSimulation) {
      pushMessage(missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}.` : "Simulation is already running.");
      return;
    }
    const response = await runSimulation(study.id, study, displayModel ?? undefined);
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
        setResultFrameIndex(0);
        setCompletedRunId(response.run.id);
        setViewMode("results");
        setActiveStep("results");
      }
    });
  }

  function handleOpenStartMenu() {
    setHomeRequested(true);
  }

  if (shouldShowStartScreen({ homeRequested, hasProject: Boolean(project), hasDisplayModel: Boolean(displayModel), hasStudy: Boolean(study) }) || !project || !displayModel || !displayModelForUi) {
    return <StartScreen onLoadSample={handleLoadSample} onCreateProject={handleCreateProject} onOpenProject={handleOpenProject} />;
  }

  return (
    <div className={`app-shell theme-${themeMode} ${isStepbarCollapsed ? "stepbar-collapsed" : ""}`}>
      <header className="topbar">
        <button className="brand brand-button" type="button" onClick={handleOpenStartMenu} title="Back to start menu" aria-label="Back to start menu">
          <OpenCaeLogoMark />OpenCAE <span className="beta-tag">beta</span>
        </button>
        <div className="topbar-divider topbar-divider-project" />
        <div className="breadcrumb">
          <ProjectNameChip name={project.name} onRename={handleRenameProject} />
          {study ? <><span className="breadcrumb-sep">/</span><span>{study.name}</span></> : <><span className="breadcrumb-sep">/</span><span>No simulation</span></>}
        </div>
        <div className="topbar-tools" aria-label="Workspace tools">
          <div className="history-tools" role="group" aria-label="Undo and redo">
            <button className="icon-button history-button" type="button" title="Undo last change" aria-label="Undo last change" disabled={!canUndoAction} onClick={handleUndoAction}><UndoIcon /></button>
            <button className="icon-button history-button" type="button" title="Redo last change" aria-label="Redo last change" disabled={!canRedoAction} onClick={handleRedoAction}><RedoIcon /></button>
          </div>
        </div>
        <button
          className={`primary topbar-action ${solverRunning ? "running" : ""}`}
          onClick={study ? handleRunSimulation : handleCreateStaticSimulation}
          disabled={study ? !canRunSimulation : false}
          title={missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}` : "Run simulation"}
        >
          <span aria-hidden="true">▶</span>{study ? (solverRunning ? "Running…" : "Run simulation") : "Create simulation"}
        </button>
        <button className="secondary topbar-action" type="button" onClick={handleSaveProject} title="Save project to local disk">
          <Save size={16} aria-hidden="true" />
          Save project
        </button>
      </header>

      <main className="workspace">
        {study ? (
          <StepBar
            activeStep={activeStep}
            collapsed={isStepbarCollapsed}
            project={project}
            themeMode={themeMode}
            onSelect={handleStepSelect}
            onToggleCollapsed={() => setIsStepbarCollapsed((collapsed) => !collapsed)}
            onToggleTheme={() => setThemeMode((mode) => (mode === "dark" ? "light" : "dark"))}
            onUnitSystemChange={handleUnitSystemChange}
            study={study}
            hasResults={viewMode === "results" || resultFields.length > 0}
          />
        ) : (
          <NoStudyPanel
            hasGeometry={displayModel.bodyCount > 0 || project.geometryFiles.length > 0}
            onUploadModel={handleUploadModel}
            onCreateSimulation={() => setShowCreateSimulation(true)}
          />
        )}
        <CadViewer
          displayModel={displayModelForUi}
          activeStep={activeStep}
          selectedFaceId={selectedFaceId}
          payloadObjectSelectionMode={Boolean(study && activeStep === "loads" && draftLoadType === "gravity")}
          selectedPayloadObject={selectedPayloadObject}
          onViewerMiss={handleViewerMiss}
          onSelectFace={handleViewportFaceSelect}
          viewMode={viewMode}
          resultMode={resultMode}
          showDeformed={showDeformed}
          showDimensions={showDimensions}
          stressExaggeration={stressExaggeration}
          resultFields={visibleResultFieldsForUi}
          unitSystem={displayUnitSystem}
          themeMode={themeMode}
          fitSignal={fitSignal}
          viewAxis={viewAxis}
          viewAxisSignal={viewAxisSignal}
          loadMarkers={loadMarkers}
          supportMarkers={supportMarkers}
          printLayerOrientation={printLayerOrientation}
          onResetView={handleFitDefaultView}
          onMeasureDisplayModelDimensions={handleMeasureDisplayModelDimensions}
        />
        {study ? <RightPanel
          activeStep={activeStep}
          project={project}
          displayModel={displayModelForUi}
          study={study}
          selectedFace={selectedFace}
          viewMode={viewMode}
          resultMode={resultMode}
          showDeformed={showDeformed}
          showDimensions={showDimensions}
          stressExaggeration={stressExaggeration}
          resultSummary={resultSummaryForUi}
          resultFields={resultFieldsForUi}
          runProgress={runProgress}
          sampleModel={sampleModel}
          draftLoadType={draftLoadType}
          draftLoadValue={draftLoadValue}
          draftLoadDirection={draftLoadDirection}
          selectedLoadPoint={selectedLoadPoint}
          selectedPayloadObject={selectedPayloadObject}
          onFitView={handleFitDefaultView}
          onRotateModel={handleRotateModel}
          onResetModelOrientation={handleResetModelOrientation}
          onLoadSample={handleLoadSample}
          onUploadModel={handleUploadModel}
          onSampleModelChange={handleLoadSample}
          onViewModeChange={setViewMode}
          onResultModeChange={setResultMode}
          onToggleDeformed={() => setShowDeformed((value) => !value)}
          onToggleDimensions={() => setShowDimensions((value) => !value)}
          onStressExaggerationChange={setStressExaggeration}
          onAssignMaterial={(materialId, parameters) =>
            updateStudy(assignMaterial(study.id, materialId, parameters, study), shouldAutoAdvanceAfterMaterialAssignment() ? "supports" : undefined)
          }
          onPreviewPrintLayerOrientation={setPreviewPrintLayerOrientation}
          onAddSupport={(selectionRef) => updateStudy(addSupport(study.id, selectionRef, study))}
          onUpdateSupport={(support: Constraint) =>
            updateStudy(
              saveStudyPatch(
                study.id,
                { constraints: study.constraints.map((item) => (item.id === support.id ? support : item)) },
                "Support updated.",
                study
              )
            )
          }
          onRemoveSupport={(supportId) =>
            updateStudy(saveStudyPatch(study.id, { constraints: study.constraints.filter((item) => item.id !== supportId) }, "Support removed.", study))
          }
          onDraftLoadTypeChange={(type) => {
            setDraftLoadType(type);
          }}
          onDraftLoadValueChange={(value) => {
            setDraftLoadValue(value);
          }}
          onDraftLoadDirectionChange={(direction) => {
            setDraftLoadDirection(direction);
          }}
          onAddLoad={(type, value, selectionRef, direction, payloadMetadata = {}) => {
            const selection = study.namedSelections.find((item) => item.id === selectionRef);
            const faceId = selection?.geometryRefs[0]?.entityId;
            const payloadObject = type === "gravity" ? selectedPayloadObject : null;
            const fallbackPayloadFace = payloadObject ? faceForPayloadObject(payloadObject) : null;
            const face = selectedFace?.id === faceId || (!selection && selectedFace) ? selectedFace : displayModel.faces.find((item) => item.id === faceId) ?? fallbackPayloadFace;
            if (!face) return;
            const applicationPoint = type === "gravity" && payloadObject ? payloadObject.center : selectedLoadPoint;
            if (type !== "gravity" && !applicationPoint) {
              pushMessage("Select a point on the model before adding a load.");
              return;
            }
            if (selection) {
              updateStudy(addLoad(study.id, type, value, selection.id, directionVectorForLabel(direction, face), applicationPoint, payloadObject, study, payloadMetadata));
              setSelectedLoadPoint(null);
              if (type === "gravity") setSelectedPayloadObject(null);
              return;
            }
            void addLoadForFace(type, value, face, direction, applicationPoint, payloadObject, payloadMetadata);
            setSelectedLoadPoint(null);
            if (type === "gravity") setSelectedPayloadObject(null);
          }}
          onDraftPayloadPreviewChange={setDraftPayloadPreview}
          onUpdateLoad={(load: Load) =>
            updateStudy(
              saveStudyPatch(study.id, { loads: study.loads.map((item) => (item.id === load.id ? load : item)) }, "Load updated.", study)
            )
          }
          onPreviewLoadEdit={setPreviewLoadEdit}
          onRemoveLoad={(loadId) =>
            updateStudy(saveStudyPatch(study.id, { loads: study.loads.filter((item) => item.id !== loadId) }, "Load removed.", study))
          }
          onGenerateMesh={(preset) => updateStudy(generateMesh(study.id, preset, study, displayModel), shouldAutoAdvanceAfterMeshGeneration() ? "run" : undefined)}
          onUpdateSolverSettings={handleUpdateSolverSettings}
          onRunSimulation={handleRunSimulation}
          canRunSimulation={canRunSimulation}
          missingRunItems={missingRunItems}
          resultFrameIndex={resultFrameIndex}
          onResultFrameChange={setResultFrameIndex}
          onStepSelect={handleStepSelect}
        /> : null}
        {showBoundaryConditionMenu && study ? (
          <BoundaryConditionMenu
            open
            onSelect={handleBoundaryConditionType}
            onClose={() => setShowBoundaryConditionMenu(false)}
          />
        ) : null}
        <CreateSimulationModal
          open={showCreateSimulation}
          onCreateStatic={handleCreateStaticSimulation}
          onCreateDynamic={handleCreateDynamicSimulation}
          onClose={() => setShowCreateSimulation(false)}
        />
      </main>

      <BottomPanel status={status} logs={logs} projectName={project.name} studyName={study?.name ?? "No simulation"} meshStatus={study?.meshSettings.status === "complete" ? "Ready" : "Not generated"} solverStatus={solverRunning ? "Running" : runProgress >= 100 ? "Complete" : "Idle"} />
    </div>
  );
}

function NoStudyPanel({ hasGeometry, onUploadModel, onCreateSimulation }: { hasGeometry: boolean; onUploadModel: (file: File) => void; onCreateSimulation: () => void }) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <aside className="study-tree no-study-panel">
      <section className="study-tree-section">
        <div className="study-tree-section-header">
          <span>Geometries</span>
        </div>
        <div className="tree-row active">
          <button type="button">
            <span className={`setup-status ${hasGeometry ? "complete" : "missing"}`} />
            Geometry
          </button>
        </div>
      </section>
      <section className="study-tree-section">
        <div className="study-tree-section-header">
          <span>Simulations</span>
        </div>
        <button className="outline-action wide" type="button" onClick={onCreateSimulation}>Create Simulation</button>
        <p className="panel-copy">Create a Static Analysis after loading geometry. Other analysis types are listed in the simulation picker as future options.</p>
      </section>
      <section className="study-tree-section">
        <div className="study-tree-section-header">
          <span>Model</span>
        </div>
        <input
          ref={uploadInputRef}
          className="hidden-file-input"
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          accept=".step,.stp,.stl,.obj"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) onUploadModel(file);
          }}
        />
        <button className={hasGeometry ? "secondary wide" : "primary wide"} type="button" onClick={() => uploadInputRef.current?.click()}>
          {hasGeometry ? "Replace model" : "Upload model"}
        </button>
      </section>
      <section className="study-tree-section">
        <div className="study-tree-section-header">
          <span>Job status</span>
        </div>
        <span className="job-status-row inactive">No active simulation</span>
      </section>
    </aside>
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

function latestCompletedRunId(study: Study | null, activeRunId: string): string | null {
  if (!study) return null;
  if (study.runs.some((run) => run.id === activeRunId && (run.resultRef || run.status === "complete"))) return activeRunId;
  const completed = [...study.runs].reverse().find((run) => run.resultRef || run.status === "complete");
  return completed?.id ?? null;
}

function fieldsForResultFrame(fields: ResultField[], frameIndex: number): ResultField[] {
  const hasFrames = fields.some((field) => typeof field.frameIndex === "number");
  if (!hasFrames) return fields;
  return fields.filter((field) => (field.frameIndex ?? 0) === frameIndex);
}

function readinessForStudy(study: Study | null) {
  return [
    { label: "Material assigned", done: Boolean(study?.materialAssignments.length) },
    { label: "Support added", done: Boolean(study?.constraints.length) },
    { label: "Load added", done: Boolean(study?.loads.length) },
    { label: "Mesh generated", done: study?.meshSettings.status === "complete" }
  ];
}

function namedSelectionForFace(study: Study, face: DisplayFace): NamedSelection {
  const bodyId = study.geometryScope[0]?.bodyId ?? "body-uploaded";
  return {
    id: `selection-${face.id}`,
    name: face.label,
    entityType: "face",
    geometryRefs: [{ bodyId, entityType: "face", entityId: face.id, label: face.label }],
    fingerprint: `${face.id}-${face.center.map((value) => value.toFixed(3)).join("-")}`
  };
}

function faceForPayloadObject(payloadObject: PayloadObjectSelection): DisplayFace {
  return {
    id: `payload-face-${payloadObject.id}`,
    label: payloadObject.label,
    color: "#4da3ff",
    center: payloadObject.center,
    normal: [0, 0, 1],
    stressValue: 0
  };
}

function defaultValueForLoadType(type: LoadType) {
  if (type === "pressure") return 100;
  if (type === "gravity") return 5;
  return 500;
}

async function saveProjectToLocalDisk(project: Project, displayModel: DisplayModel, results?: LocalResultBundle): Promise<string> {
  const savedAt = new Date().toISOString();
  const filename = suggestedProjectFilename(project.name);
  const savedResults = results?.fields.length ? results : undefined;
  const blob = new Blob([JSON.stringify(buildLocalProjectFile(project, displayModel, savedAt, savedResults), null, 2)], {
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

function UndoIcon() {
  return <RotateCcw size={18} aria-hidden="true" />;
}

function RedoIcon() {
  return <RotateCcw className="redo-icon" size={18} aria-hidden="true" />;
}
