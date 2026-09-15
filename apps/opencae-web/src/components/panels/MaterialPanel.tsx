/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Anchor, ArrowDown, Atom, Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Eye, Factory, FileCode2, FileDown, FileImage, FolderDown, Gauge, Grid3X3, Layers3, Maximize2, Pause, Play, Plus, RotateCcw, Ruler, ScanLine, ShieldCheck, Table2, Upload, Weight, Wrench, X } from "lucide-react";
import { finiteExtrema } from "@opencae/core";
import { compatibleManufacturingProcessesFor, defaultManufacturingParametersFor, defaultManufacturingProcessIdFor, effectiveMaterialProperties, fdmPropertyFactorsFor, isManufacturingProcessCompatible, manufacturingParametersForAssignment, manufacturingProcessForId, massKgForPayloadMaterial, materialCatalog, materialCategoryLabel, normalizeManufacturingParameters, payloadMaterialForId, payloadMaterials, type ManufacturingParameters, type ManufacturingProcessId, type PayloadMaterialCategory } from "@opencae/materials";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor, isModalResultSummary, isThermalResultSummary } from "@opencae/schema";
import type { Constraint, CustomMaterial, DisplayFace, DisplayModel, DynamicSolverSettings, Load, LoadCase, LoadCombination, Material, MeshConnection, MeshConvergenceRecord, MeshQuality, ModalResultSummary, ModalSolverSettings, Project, ResultField, ResultSummary, RunTimingEstimate, RunVariantRef, SimulationFidelity, StructuralResultSummary, Study, ThermalResultSummary } from "@opencae/schema";
import { inferGlobalCriticalPrintAxis } from "@opencae/study-core";
import type { RunReadinessItem } from "../../runReadiness";
import type { WorkspaceNotice } from "../../workspaceNotice";
import { STUDY_TYPE_LABELS, studyTypeSwitchConsequence } from "../../studyTypeSwitch";
import { GEOMETRY_FILE_ACCEPT, PREVIEW_ONLY_GEOMETRY_NOTICE, SUPPORTED_GEOMETRY_FORMAT_LABEL, isPreviewOnlyGeometry } from "../../geometryFormats";
import type { StepId } from "../StepBar";
import { applicationPointForLoad, createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, equivalentForceForLoad, LOAD_DIRECTION_LABELS, loadMagnitudeError, loadMarkerOrdinalLabel, payloadObjectForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata, type PayloadMassMode } from "../../loadPreview";
import { DEFAULT_SECTION_PLANE, type PayloadObjectSelection, type ResultMode, type SectionPlaneState, type StressComponent, type ViewMode } from "../../workspaceViewTypes";
import { availableStressComponents, type ResolvedResultProbe } from "../../resultSelection";
import { meshTargetSizeMmForPreset, type SampleAnalysisType, type SampleModelId } from "../../lib/api";
import type { WasmMeshPhaseProgress } from "../../lib/wasmMeshing";
import { defaultConvergenceProbe, type ConvergenceProbe } from "../../meshConvergence";
import { stepGeometryMetadataForProject } from "../../stepGeometryState";
import { dimensionValuesForDisplayModel } from "../../modelDimensions";
import { formatModelOrientation, getModelOrientation, type RotationAxis } from "../../modelOrientation";
import { shouldShowSampleModelPicker } from "../../modelPanelState";
import { SETTING_HELP, type SettingHelpId, type SettingHelpVisual } from "../../settingHelp";
import { supportDisplayLabel } from "../../supportLabels";
import { getViewportTooltipPosition } from "../../tooltipPosition";
import { defaultSolverMethodForStudy, forceForUnits, formatDensity, formatDisplayNumber, formatMass, formatMaterialStress, formatMeshSourceLabel, formatResultMetric, formatResultNumber, formatResultProvenanceLabel, formatVolume, hasResultUnit, legacyResultWarningForProvenance, loadValueForUnits, solverMethodForResult, solverRunnerLabelForResult, type UnitSystem } from "../../unitDisplay";
import { canNavigateToStep } from "../../appShellState";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { MaterialLibraryModal } from "../SimulationWorkflow";
import { ParametricPartBuilder } from "../ParametricPartBuilder";
import { SampleOptionCard } from "../SampleOptionCard";
import { SAMPLE_ANALYSIS_OPTIONS, sampleAnalysisOptionFor } from "../sampleAnalysisOptions";
import { SAMPLE_OPTIONS, sampleOptionFor } from "../sampleOptions";
import { dynamicPlaybackFrames } from "../../resultFields";
import { resultScaleCssGradient, validManualResultRange, type ResolvedResultColorScale, type ResultColorScaleSetting } from "../../resultColorScale";
import { INVALID_REACTION_WARNING, PREVIEW_GEOMETRY_WARNING, canShowReverseLoadCapacity, hasInvalidReactionForce, hasUnavailableReactionDiagnostic, shouldBlockPreviewResultsForDisplayModel } from "../../resultProvenance";
import {
  frameIndexForRoundedPlaybackOrdinal,
  playbackOrdinalForSolverFramePosition
} from "../../resultPlaybackTimeline";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
import type { RightPanelProps, SolverSettingsPatch } from "./RightPanelProps";
import { Panel } from "./PanelChrome";
import { EMPTY_PARAMETERS } from "./RightPanelProps";
import { Callout, HelpLabel, Info, SectionTitle, materialForId } from "./PanelChrome";
export function MaterialPanel({ project, displayModel, study, onAssignMaterial, onSaveCustomMaterial, onDeleteCustomMaterial, onPreviewPrintLayerOrientation, registerBeforeNext }: RightPanelProps) {
  const materials = useMemo(() => materialCatalog(project.customMaterials), [project.customMaterials]);
  const defaultMaterial = materials[0]!;
  const currentAssignment = study.materialAssignments[0];
  const current = currentAssignment?.materialId ?? "mat-aluminum-6061";
  const currentParameters = currentAssignment?.parameters ?? EMPTY_PARAMETERS;
  const initialMaterial = materialForId(current, materials) ?? defaultMaterial;
  const [selectedMaterialId, setSelectedMaterialId] = useState(initialMaterial.id);
  const [manufacturingParameters, setManufacturingParameters] = useState<ManufacturingParameters>(() =>
    normalizeManufacturingParameters(initialMaterial, currentParameters)
  );
  const [showLibrary, setShowLibrary] = useState(false);
  const [compatibilityNote, setCompatibilityNote] = useState<string | null>(null);

  useEffect(() => {
    const material = materialForId(current, materials) ?? defaultMaterial;
    setSelectedMaterialId(material.id);
    setManufacturingParameters(normalizeManufacturingParameters(material, currentParameters));
    setCompatibilityNote(null);
  }, [current, currentParameters, defaultMaterial, materials]);

  const selectedMaterial = materialForId(selectedMaterialId, materials) ?? defaultMaterial;
  const resolvedAssignedMaterial = materialForId(current, materials);
  const assignedMaterial = resolvedAssignedMaterial ?? defaultMaterial;
  const selectedProcessId = manufacturingParameters.manufacturingProcessId ?? defaultManufacturingProcessIdFor(selectedMaterial);
  const selectedProcess = manufacturingProcessForId(selectedProcessId)!;
  const compatibleProcesses = compatibleManufacturingProcessesFor(selectedMaterial);
  const processUsesBuildDirection = selectedProcess.settingsKind === "fdm" || selectedProcess.settingsKind === "build_direction";
  const criticalLayerAxis = inferGlobalCriticalPrintAxis(study, displayModel.faces.map((face) => ({
    entityId: face.id,
    center: face.center,
    ...(face.area ? { areaM2: face.area * 1e-6 } : {})
  })), displayModel);
  const effectiveMaterial = effectiveMaterialProperties(selectedMaterial, { ...manufacturingParameters }, { criticalLayerAxis });
  const fdmFactors = fdmPropertyFactorsFor(selectedMaterial, manufacturingParameters, { criticalLayerAxis });
  const assignedParameters = currentAssignment ? normalizeManufacturingParameters(assignedMaterial, currentParameters) : undefined;
  const assignedProcess = assignedParameters?.manufacturingProcessId ? manufacturingProcessForId(assignedParameters.manufacturingProcessId) : undefined;
  const assignedDetail = assignedProcess
    ? `${assignedProcess.label}${assignedProcess.id === "fdm" ? ` · ${assignedParameters?.infillDensity}% infill` : ""}`
    : "Process not selected";
  const assignedSelectionLabel = study.geometryScope[0]?.label ?? displayModel.name;
  const pendingParameters = manufacturingParametersForAssignment(selectedMaterial, manufacturingParameters);
  // Both sides go through the assignment normalizer: stored parameters may
  // predate a derived field (e.g. `printed`) that the normalizer adds today.
  const selectionMatchesAssignment = Boolean(currentAssignment) && selectedMaterialId === current
    && sameManufacturingParameters(pendingParameters, manufacturingParametersForAssignment(assignedMaterial, currentParameters));
  // Only processes that change the properties earn a second table; for solid
  // stock the effective values are the base values and repeating them was noise.
  const processAltersProperties = Boolean(fdmFactors)
    || differs(effectiveMaterial.youngsModulus, selectedMaterial.youngsModulus)
    || differs(effectiveMaterial.density, selectedMaterial.density)
    || differs(effectiveMaterial.yieldStrength, selectedMaterial.yieldStrength);
  const assignmentStatus = selectionMatchesAssignment
    ? `Assigned to ${assignedSelectionLabel} · ${assignedDetail}`
    : currentAssignment && resolvedAssignedMaterial
      ? `Not applied yet · ${assignedSelectionLabel} still uses ${resolvedAssignedMaterial.name}`
      : currentAssignment
        ? `Not applied yet · assigned material “${currentAssignment.materialId}” is unknown`
        : "Not applied yet · no material assigned";

  // Next commits the previewed material (2026-09 review F3): leaving without
  // Apply used to be silent and only surfaced at Run as "Material assigned".
  useEffect(() => {
    registerBeforeNext?.(selectionMatchesAssignment ? null : () => onAssignMaterial(selectedMaterialId, pendingParameters));
    return () => registerBeforeNext?.(null);
  }, [onAssignMaterial, pendingParameters, registerBeforeNext, selectedMaterialId, selectionMatchesAssignment]);

  useEffect(() => {
    onPreviewPrintLayerOrientation?.(processUsesBuildDirection ? manufacturingParameters.layerOrientation ?? "z" : null);
    return () => onPreviewPrintLayerOrientation?.(undefined);
  }, [manufacturingParameters.layerOrientation, onPreviewPrintLayerOrientation, processUsesBuildDirection]);

  function handleMaterialChange(materialId: string) {
    const material = materialForId(materialId, materials);
    if (!material) return;
    const previousProcessId = manufacturingParameters.manufacturingProcessId;
    const canKeepProcess = previousProcessId ? isManufacturingProcessCompatible(material, previousProcessId) : false;
    const nextProcessId = canKeepProcess ? previousProcessId! : defaultManufacturingProcessIdFor(material);
    const nextParameters = canKeepProcess
      ? normalizeManufacturingParameters(material, { ...manufacturingParameters, manufacturingProcessId: nextProcessId })
      : defaultManufacturingParametersFor(material, nextProcessId);
    setSelectedMaterialId(materialId);
    setManufacturingParameters(nextParameters);
    if (previousProcessId && !canKeepProcess) {
      const previousProcess = manufacturingProcessForId(previousProcessId);
      const nextProcess = manufacturingProcessForId(nextProcessId);
      setCompatibilityNote(`${previousProcess?.label ?? "The selected process"} is not available for ${material.name}. Switched to ${nextProcess?.label ?? "a compatible process"}.`);
    } else {
      setCompatibilityNote(null);
    }
  }

  function handleProcessChange(processId: ManufacturingProcessId) {
    setManufacturingParameters(defaultManufacturingParametersFor(selectedMaterial, processId));
    setCompatibilityNote(null);
  }

  function updateManufacturingParameters(patch: Partial<ManufacturingParameters>) {
    setManufacturingParameters((previous) => normalizeManufacturingParameters(selectedMaterial, { ...previous, ...patch }));
  }

  return (
    <Panel title="Material" step="material" helper="Choose the material, then how it is made." study={study}>
      <SectionTitle helpId="materialLibrary">Base Material</SectionTitle>
      <div className="base-material-card">
        <button className="base-material-selector" type="button" onClick={() => setShowLibrary(true)} aria-label={`Change base material. Current material: ${selectedMaterial.name}`}>
          <span className="base-material-icon"><Atom size={20} aria-hidden="true" /></span>
          <span className="base-material-name">
            <strong>{selectedMaterial.name}</strong>
            <small>{materialCategoryLabel(selectedMaterial)}</small>
          </span>
          <span className="base-material-change">Change <ChevronRight size={15} aria-hidden="true" /></span>
        </button>
        <div className="base-material-properties">
          <Info label="Modulus" value={formatMaterialStress(selectedMaterial.youngsModulus, project.unitSystem)} />
          <Info label="Density" value={formatDensity(selectedMaterial.density, "kg/m^3", project.unitSystem)} />
          <Info label="Yield strength" value={formatMaterialStress(selectedMaterial.yieldStrength, project.unitSystem)} />
          <Info label="Poisson ratio" value={String(selectedMaterial.poissonRatio)} />
        </div>
        <p className={`base-material-status${selectionMatchesAssignment ? "" : " pending"}`} role="status">
          {selectionMatchesAssignment ? <Check size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
          {assignmentStatus}
        </p>
      </div>

      <SectionTitle helpId="manufacturingProcess">Manufacturing Process</SectionTitle>
      <p className="material-process-helper">Compatible with {selectedMaterial.name}. Only validated options are shown.</p>
      <div className="material-process-list" role="radiogroup" aria-label="Manufacturing process">
        {compatibleProcesses.map((process) => {
          const active = process.id === selectedProcessId;
          return (
            <button
              key={process.id}
              className={`material-process-option ${active ? "active" : ""}`}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${process.label}. ${process.description}`}
              onClick={() => handleProcessChange(process.id)}
            >
              <span className="material-process-radio" aria-hidden="true">{active ? <Check size={14} /> : null}</span>
              <span className="material-process-icon"><ManufacturingProcessIcon processId={process.id} /></span>
              <span className="material-process-copy">
                <strong>{process.label}</strong>
                <small>{process.description}</small>
              </span>
            </button>
          );
        })}
      </div>
      {compatibilityNote ? <p className="material-compatibility-note" role="status">{compatibilityNote}</p> : null}

      {processUsesBuildDirection ? (
        <>
          <SectionTitle helpId="printSettings">{selectedProcess.shortLabel} Settings</SectionTitle>
          <div className="print-settings">
            <div className={`print-settings-grid ${selectedProcess.settingsKind === "fdm" ? "" : "build-direction-only"}`}>
              {selectedProcess.settingsKind === "fdm" ? (
                <>
                  <label className="field">
                    <HelpLabel helpId="infillDensity">Infill density</HelpLabel>
                    <span className="input-with-unit">
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={manufacturingParameters.infillDensity ?? 100}
                        onChange={(event) => updateManufacturingParameters({ infillDensity: Number(event.currentTarget.value) })}
                      />
                      <span>%</span>
                    </span>
                  </label>
                  <label className="field">
                    <HelpLabel helpId="wallCount">Wall count</HelpLabel>
                    <span className="input-with-unit">
                      <input
                        type="number"
                        min="1"
                        max="12"
                        value={manufacturingParameters.wallCount ?? 1}
                        onChange={(event) => updateManufacturingParameters({ wallCount: Number(event.currentTarget.value) })}
                      />
                      <span>walls</span>
                    </span>
                  </label>
                </>
              ) : null}
              <label className="field">
                <HelpLabel helpId="layerDirection">Build direction</HelpLabel>
                <select
                  value={manufacturingParameters.layerOrientation ?? "z"}
                  onChange={(event) => updateManufacturingParameters({ layerOrientation: event.currentTarget.value as ManufacturingParameters["layerOrientation"] })}
                >
                  <option value="z">Z build direction</option>
                  <option value="x">X build direction</option>
                  <option value="y">Y build direction</option>
                </select>
              </label>
            </div>
          </div>
        </>
      ) : null}

      {processAltersProperties && (
        <>
          <SectionTitle helpId="simulationProperties">Simulation Properties</SectionTitle>
          <div className="summary-box material-simulation-properties">
            {fdmFactors ? <Info label="Governing load path" value={fdmFactors.criticalAxis ? `${fdmFactors.criticalAxis.toUpperCase()} axis` : "Conservative"} /> : null}
            {fdmFactors ? <Info label="Layer response" value={fdmLayerResponseLabel(fdmFactors.loadPathRelation)} /> : null}
            <Info label="Effective modulus" value={formatMaterialStress(effectiveMaterial.youngsModulus, project.unitSystem)} />
            <Info label="Effective density" value={formatDensity(effectiveMaterial.density, "kg/m^3", project.unitSystem)} />
            <Info label="Effective yield" value={formatMaterialStress(effectiveMaterial.yieldStrength, project.unitSystem)} />
          </div>
        </>
      )}

      {!selectionMatchesAssignment && (
        <button className="primary wide material-apply-button" type="button" onClick={() => onAssignMaterial(selectedMaterialId, pendingParameters)}>Apply material &amp; process</button>
      )}
      <MaterialLibraryModal
        open={showLibrary}
        selectedMaterialId={selectedMaterialId}
        assignedSelectionLabel={assignedSelectionLabel}
        unitSystem={project.unitSystem}
        materials={materials}
        customMaterialIds={project.customMaterials?.map((material) => material.id)}
        assignedMaterialIds={project.studies.flatMap((candidate) => candidate.materialAssignments.map((assignment) => assignment.materialId))}
        onSaveCustomMaterial={onSaveCustomMaterial}
        onDeleteCustomMaterial={onDeleteCustomMaterial}
        onApply={(materialId) => {
          handleMaterialChange(materialId);
          setShowLibrary(false);
        }}
        onClose={() => setShowLibrary(false)}
      />
      {currentAssignment && !resolvedAssignedMaterial ? <Callout>Unknown material “{currentAssignment.materialId}”. Choose a valid material before solving.</Callout> : null}
    </Panel>
  );
}

function differs(a: number, b: number) {
  return Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/* Key order and explicit undefineds are storage noise, not a different setup. */
function sameManufacturingParameters(a: ManufacturingParameters | undefined, b: ManufacturingParameters | undefined) {
  const entries = (value: ManufacturingParameters | undefined) =>
    Object.entries(value ?? {}).filter(([, item]) => item !== undefined).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(entries(a)) === JSON.stringify(entries(b));
}

function fdmLayerResponseLabel(relation: "within_layers" | "across_layers" | "conservative") {
  if (relation === "within_layers") return "Within layers";
  if (relation === "across_layers") return "Across layers · weakest";
  return "Across layers · conservative";
}

function ManufacturingProcessIcon({ processId }: { processId: ManufacturingProcessId }) {
  if (processId === "cnc_machining") return <Wrench size={18} aria-hidden="true" />;
  if (processId === "injection_molding") return <Factory size={18} aria-hidden="true" />;
  return <Layers3 size={18} aria-hidden="true" />;
}
