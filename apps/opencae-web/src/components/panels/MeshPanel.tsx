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
import { Panel, meshPresetDescription, seedProbeCoordinate, structuralLoadCasesForPanel } from "./PanelChrome";
import { MESH_PRESETS } from "./RightPanelProps";
import { Callout, Collapsible, HelpLabel, Info, SectionTitle, capitalize, selectionLabelForPanel } from "./PanelChrome";
export function MeshPanel({ project, displayModel, study, viewMode, onViewModeChange, onGenerateMesh, onConnectionsChange, onCancelMesh, meshPhaseProgress, meshError, onRepairModel, isRepairingModel = false, onRunMeshConvergence, convergenceBusy = false, convergenceProgress = "" }: RightPanelProps) {
  const [preset, setPreset] = useState<MeshQuality>(study.meshSettings.preset);
  const meshing = Boolean(meshPhaseProgress);
  const meshSummary = study.meshSettings.summary;
  const hasVerifiedMeshSummary = meshSummary?.source === "core_solver" || meshSummary?.source === "wasm_gmsh";
  const stepGeometry = stepGeometryMetadataForProject(project);
  const stepGeometryResolvedByMesh = Boolean(study.meshSettings.summary?.artifacts?.actualCoreModel);
  const previewOnlyGeometry = isPreviewOnlyGeometry(displayModel) && !stepGeometryResolvedByMesh;
  const staticStudy = study.type === "static_stress" ? study : null;
  const convergenceCases = staticStudy ? structuralLoadCasesForPanel(staticStudy).filter((loadCase) => loadCase.enabled && loadCase.loadIds.length) : [];
  const [convergenceCaseId, setConvergenceCaseId] = useState(convergenceCases[0]?.id ?? "");
  const initialProbe = staticStudy && convergenceCaseId ? defaultConvergenceProbe(staticStudy, convergenceCaseId, displayModel) : null;
  const [probeCoordinates, setProbeCoordinates] = useState<[string, string, string]>(() => initialProbe
    ? initialProbe.point.map(seedProbeCoordinate) as [string, string, string]
    : ["", "", ""]);
  const [probeEdited, setProbeEdited] = useState(false);
  useEffect(() => {
    if (!staticStudy || !convergenceCases.length) return;
    const caseId = convergenceCases.some((loadCase) => loadCase.id === convergenceCaseId) ? convergenceCaseId : convergenceCases[0]!.id;
    if (caseId !== convergenceCaseId) setConvergenceCaseId(caseId);
    const probe = defaultConvergenceProbe(staticStudy, caseId, displayModel);
    setProbeCoordinates(probe ? probe.point.map(seedProbeCoordinate) as [string, string, string] : ["", "", ""]);
    setProbeEdited(false);
  }, [displayModel, staticStudy?.id, staticStudy?.loads, staticStudy?.loadCases, convergenceCaseId]);
  const probePoint = probeCoordinates.map(Number) as [number, number, number];
  const validProbe = probeCoordinates.every((value) => value.trim() !== "") && probePoint.every(Number.isFinite);
  const latestRecord = [...(project.convergenceRecords ?? [])]
    .reverse()
    .find((record) => record.studyId === study.id && record.caseId === convergenceCaseId);
  const faceSelections = study.namedSelections.filter((selection) => selection.entityType === "face");
  const [connectionType, setConnectionType] = useState<MeshConnection["type"]>("tie");
  const [connectionSource, setConnectionSource] = useState(faceSelections[0]?.id ?? "");
  const [connectionTarget, setConnectionTarget] = useState(faceSelections[1]?.id ?? "");

  function selectConvergenceCase(caseId: string) {
    setConvergenceCaseId(caseId);
    if (!staticStudy) return;
    const probe = defaultConvergenceProbe(staticStudy, caseId, displayModel);
    setProbeCoordinates(probe ? probe.point.map(seedProbeCoordinate) as [string, string, string] : ["", "", ""]);
    setProbeEdited(false);
  }

  function runConvergence() {
    if (!staticStudy || !validProbe || !convergenceCaseId) return;
    const fallback = defaultConvergenceProbe(staticStudy, convergenceCaseId, displayModel);
    onRunMeshConvergence?.(convergenceCaseId, {
      point: probePoint,
      source: probeEdited ? "explicit" : fallback?.source ?? "explicit",
      ...(probeEdited ? { label: "Explicit displacement probe" } : fallback?.label ? { label: fallback.label } : {})
    });
  }

  return (
    <Panel title="Mesh" step="mesh" helper="The mesh breaks the model into small pieces so OpenCAE can calculate results." study={study}>
      <div className="field">
        <HelpLabel helpId="meshQuality">Quality preset</HelpLabel>
        <div className="segmented mesh-quality" role="group" aria-label="Mesh quality">
          {MESH_PRESETS.map((option) => (
            <button key={option} className={preset === option ? "active" : ""} type="button" aria-pressed={preset === option} disabled={meshing || convergenceBusy} onClick={() => setPreset(option)}>{capitalize(option)}</button>
          ))}
        </div>
      </div>
      {displayModel.bodyCount > 1 || study.contacts.length ? (
        <section className="load-case-editor" aria-label="Assembly connections">
          <SectionTitle>Assembly connections</SectionTitle>
          <label className="field">Behavior<select value={connectionType} onChange={(event) => setConnectionType(event.currentTarget.value as MeshConnection["type"])}><option value="tie">Tied</option><option value="contact">Frictionless contact</option><option value="fuse">Boolean fuse</option></select></label>
          <label className="field">Source face<select value={connectionSource} onChange={(event) => setConnectionSource(event.currentTarget.value)}>{faceSelections.map((selection) => <option key={selection.id} value={selection.id}>{selection.name}</option>)}</select></label>
          <label className="field">Target face<select value={connectionTarget} onChange={(event) => setConnectionTarget(event.currentTarget.value)}>{faceSelections.map((selection) => <option key={selection.id} value={selection.id}>{selection.name}</option>)}</select></label>
          <button className="secondary wide" type="button" disabled={!connectionSource || !connectionTarget || connectionSource === connectionTarget || !onConnectionsChange} onClick={() => onConnectionsChange?.([...study.contacts, {
            id: `connection-${crypto.randomUUID()}`,
            type: connectionType,
            source: connectionSource,
            target: connectionTarget,
            ...(connectionType === "contact" ? { formulation: "frictionless" as const } : {}),
            kinematics: "small_sliding",
            status: "ready"
          }])}><Plus size={16} />Add connection</button>
          {study.contacts.map((connection) => <div className="load-case-row" key={connection.id}><span><strong>{connection.type === "tie" ? "Tied" : connection.type === "contact" ? "Frictionless contact" : "Boolean fuse"}</strong><small>{selectionLabelForPanel(study, connection.source)} → {selectionLabelForPanel(study, connection.target)}</small></span><button className="remove-glyph" type="button" aria-label="Remove connection" onClick={() => onConnectionsChange?.(study.contacts.filter((candidate) => candidate.id !== connection.id))}><X size={15} /></button></div>)}
          {connectionType === "contact" && <Callout>Small-sliding, frictionless node-to-surface penalty contact. Large sliding and friction are outside this beta.</Callout>}
        </section>
      ) : null}
      {previewOnlyGeometry && <p className="panel-warning" role="alert">{PREVIEW_ONLY_GEOMETRY_NOTICE}</p>}
      <button
        className="primary wide"
        type="button"
        disabled={convergenceBusy || previewOnlyGeometry || (meshing && !onCancelMesh)}
        aria-label={meshing ? "Stop mesh generation" : "Generate mesh"}
        title={previewOnlyGeometry ? PREVIEW_ONLY_GEOMETRY_NOTICE : undefined}
        onClick={() => meshing ? onCancelMesh?.() : onGenerateMesh(preset)}
      >
        {meshing ? <X size={18} /> : <Grid3X3 size={18} />}
        {meshing ? "Stop meshing" : "Generate mesh"}
      </button>
      {meshError && !meshing && (
        <div className="mesh-failure" role="alert">
          <p className="panel-warning"><AlertTriangle size={16} />{meshError}</p>
          <button className="secondary wide" type="button" disabled={convergenceBusy} onClick={() => onGenerateMesh(preset)}>
            <Grid3X3 size={16} />Try meshing again
          </button>
        </div>
      )}
      {stepGeometry?.status === "repairable" && !stepGeometryResolvedByMesh && (
        <div className="step-repair-card" role="alert" aria-label="Open STEP surfaces detected">
          <p className="panel-warning"><AlertTriangle size={16} />{stepGeometry.message ?? "This STEP model has open or invalid surfaces and is not a closed simulation solid."}</p>
          <button className="outline-action wide" type="button" onClick={onRepairModel} disabled={isRepairingModel || !onRepairModel}>
            <Wrench size={16} />
            {isRepairingModel ? "Fixing model..." : "Fix open surfaces"}
          </button>
          <p className="panel-copy">Fix model sews small gaps and may patch closed boundary loops. Review the repaired shape; face-based setup will be reset.</p>
        </div>
      )}
      {(stepGeometry?.status === "unrepairable" || stepGeometry?.status === "invalid") && !stepGeometryResolvedByMesh && (
        <p className="panel-warning" role="alert"><AlertTriangle size={16} />{stepGeometry.message ?? "Automatic repair cannot close this model. Re-export it from CAD as a solid body."}</p>
      )}
      {meshPhaseProgress && (
        <>
          {/* Honest phase progress: worker phase position, not a synthetic percent —
              phase durations vary with geometry and quality retries revisit phases. */}
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={meshPhaseProgress.phaseCount}
            aria-valuenow={meshPhaseProgress.phaseIndex + 1}
            aria-valuetext={meshPhaseProgress.message}
            aria-label="Mesh generation progress"
          >
            <span style={{ width: `${Math.round(((meshPhaseProgress.phaseIndex + 1) / meshPhaseProgress.phaseCount) * 100)}%` }} />
            <strong className="progress-label">{meshPhaseProgress.phaseIndex + 1} / {meshPhaseProgress.phaseCount}</strong>
          </div>
          <p className="panel-copy mesh-progress-message" aria-live="polite">{meshPhaseProgress.message}</p>
        </>
      )}
      <Callout>{capitalize(preset)} creates {meshPresetDescription(preset)} (target element size {formatDisplayNumber(meshTargetSizeMmForPreset(preset))} mm).</Callout>
      {meshSummary && (
        <div className="summary-box">
          {hasVerifiedMeshSummary ? (
            <>
              <Info label="Nodes" value={meshSummary.nodes.toLocaleString()} />
              <Info label="Elements" value={meshSummary.elements.toLocaleString()} />
            </>
          ) : (
            <>
              {/* Preset-only summaries carry no geometry-specific counts; "--" is the
                  app-wide honest placeholder and the copy below says when real counts arrive. */}
              <Info label="Nodes" value="--" />
              <Info label="Elements" value="--" />
            </>
          )}
          {/* "Analysis samples" meant nothing to a user; the element size does (2026-09 review F5). */}
          <Info label="Target element size" value={`${formatDisplayNumber(typeof meshSummary.density?.requestedMeshSizeMm === "number" ? meshSummary.density.requestedMeshSizeMm : meshTargetSizeMmForPreset(preset))} mm`} />
          {typeof meshSummary.density?.actualMeshSizeMm === "number" && meshSummary.density.actualMeshSizeMm !== meshSummary.density.requestedMeshSizeMm && (
            <Info label="Meshed at" value={`${formatDisplayNumber(meshSummary.density.actualMeshSizeMm)} mm`} />
          )}
          <Info label="Warnings" value={String(meshSummary.warnings.length)} />
        </div>
      )}
      {meshSummary && stepGeometryResolvedByMesh && (
        <button
          type="button"
          className={viewMode === "mesh" ? "primary wide" : "secondary wide"}
          aria-pressed={viewMode === "mesh"}
          onClick={() => onViewModeChange(viewMode === "mesh" ? "model" : "mesh")}
        >
          <Eye size={16} />{viewMode === "mesh" ? "Hide mesh" : "Show mesh in viewer"}
        </button>
      )}
      {meshSummary && meshSummary.warnings.length > 0 && (
        <ul className="mesh-warning-list" aria-label="Mesh warnings">
          {meshSummary.warnings.map((warning) => <li key={warning}><AlertTriangle size={14} aria-hidden="true" />{warning}</li>)}
        </ul>
      )}
      <p className="panel-copy">Meshing runs locally in your browser at the selected quality. Preset-only summaries do not predict solver mesh counts; actual node and element counts appear with the results.</p>
      {staticStudy ? (
        <Collapsible title="Mesh convergence" subtitle="Coarse → fine" defaultOpen={convergenceBusy || Boolean(latestRecord)}>
        <section className="convergence-card" aria-label="Static mesh convergence">
          <p className="panel-copy">Runs an isolated static case at coarse, medium, then fine. Your working mesh and active results stay unchanged.</p>
          <label className="field">
            <span>Static case</span>
            <select value={convergenceCaseId} disabled={convergenceBusy} onChange={(event) => selectConvergenceCase(event.currentTarget.value)}>
              {convergenceCases.map((loadCase) => <option key={loadCase.id} value={loadCase.id}>{loadCase.name}</option>)}
            </select>
          </label>
          <div className="field">
            <span>Displacement probe ({displayModel.dimensions?.units ?? "model units"})</span>
            <div className="convergence-probe-grid">
              {(["X", "Y", "Z"] as const).map((axis, index) => (
                <label key={axis}>
                  <span>{axis}</span>
                  <input
                    type="number"
                    value={probeCoordinates[index]}
                    disabled={convergenceBusy}
                    onChange={(event) => {
                      const next = [...probeCoordinates] as [string, string, string];
                      next[index] = event.currentTarget.value;
                      setProbeCoordinates(next);
                      setProbeEdited(true);
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
          {!validProbe && <p className="panel-warning"><AlertTriangle size={16} />Choose a finite displacement probe point before running convergence.</p>}
          <button className="secondary wide" type="button" disabled={!onRunMeshConvergence || convergenceBusy || meshing || !validProbe || !convergenceCaseId} onClick={runConvergence}>
            <ScanLine size={16} />{convergenceBusy ? "Running convergence…" : "Run coarse → medium → fine"}
          </button>
          {convergenceBusy && <p className="panel-copy" aria-live="polite">{convergenceProgress || "Running convergence study."}</p>}
          {latestRecord && <ConvergenceRecordCard record={latestRecord} />}
        </section>
        </Collapsible>
      ) : (
        <p className="panel-copy">Mesh-convergence studies are available for static load cases only.</p>
      )}
    </Panel>
  );
}

function ConvergenceRecordCard({ record }: { record: MeshConvergenceRecord }) {
  const classification = record.classification === "apparent_convergence"
    ? "Apparent convergence"
    : record.classification === "unconverged"
      ? "Unconverged"
      : "Inconclusive";
  return (
    <div className="convergence-record">
      <strong>{classification}</strong>
      {record.lastStepChanges && (
        <small>Last step: displacement {(record.lastStepChanges.displacement * 100).toFixed(1)}% · stress {(record.lastStepChanges.stress * 100).toFixed(1)}%</small>
      )}
      <ConvergenceChart record={record} />
      <div className="convergence-rungs">
        {record.rungs.map((rung) => (
          <div key={rung.requestedPreset} className={`convergence-rung ${rung.status}`}>
            <span>{capitalize(rung.requestedPreset)}</span>
            <small>{rung.totalDofs?.toLocaleString() ?? "—"} total · {rung.freeDofs?.toLocaleString() ?? "—"} free DOF</small>
            <small>{rung.actualNodeCount?.toLocaleString() ?? "—"} nodes · {rung.actualElementCount?.toLocaleString() ?? "—"} elements · {formatCompact(rung.actualMeshSizeMm)} mm</small>
            <small>{rung.status === "complete"
              ? `${formatCompact(rung.probeDisplacement)} ${rung.displacementUnits} · ${formatCompact(rung.rawElementPeakVonMises)} ${rung.stressUnits}`
              : rung.skipReason ?? capitalize(rung.status)}</small>
          </div>
        ))}
      </div>
      <p className="panel-copy">Apparent convergence requires three increasing-DOF rungs, ≤5% displacement change, and ≤10% raw element stress change.</p>
    </div>
  );
}

function ConvergenceChart({ record }: { record: MeshConvergenceRecord }) {
  const plottable = record.rungs.filter((rung) => rung.totalDofs !== undefined);
  const complete = plottable.filter((rung) => rung.status === "complete" && rung.probeDisplacement !== undefined && rung.rawElementPeakVonMises !== undefined);
  if (!plottable.length) return null;
  const dofs = plottable.map((rung) => rung.totalDofs!);
  const minDof = Math.min(...dofs);
  const maxDof = Math.max(...dofs);
  const x = (dof: number) => 18 + ((dof - minDof) / Math.max(1, maxDof - minDof)) * 204;
  const normalizedY = (value: number, values: number[]) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    return 82 - ((value - min) / Math.max(Number.EPSILON, max - min)) * 58;
  };
  const displacementValues = complete.map((rung) => rung.probeDisplacement!);
  const stressValues = complete.map((rung) => rung.rawElementPeakVonMises!);
  const displacementPoints = complete.map((rung) => `${x(rung.totalDofs!)},${normalizedY(rung.probeDisplacement!, displacementValues)}`).join(" ");
  const stressPoints = complete.map((rung) => `${x(rung.totalDofs!)},${normalizedY(rung.rawElementPeakVonMises!, stressValues)}`).join(" ");
  return (
    <svg className="convergence-chart" viewBox="0 0 240 112" role="img" aria-label="Probe displacement and raw element peak stress versus actual degrees of freedom">
      <title>Convergence metrics versus actual degrees of freedom</title>
      <line x1="18" y1="86" x2="222" y2="86" className="chart-axis" />
      <line x1="18" y1="18" x2="18" y2="86" className="chart-axis" />
      {displacementPoints && <polyline points={displacementPoints} className="chart-displacement" />}
      {stressPoints && <polyline points={stressPoints} className="chart-stress" />}
      {complete.map((rung) => (
        <g key={`point-${rung.requestedPreset}`}>
          <circle cx={x(rung.totalDofs!)} cy={normalizedY(rung.probeDisplacement!, displacementValues)} r="3" className="chart-displacement" />
          <circle cx={x(rung.totalDofs!)} cy={normalizedY(rung.rawElementPeakVonMises!, stressValues)} r="3" className="chart-stress" />
        </g>
      ))}
      {plottable.filter((rung) => rung.status !== "complete").map((rung) => (
        <g key={`skip-${rung.requestedPreset}`} className="chart-skipped" aria-label={`${rung.requestedPreset} ${rung.status}`}>
          <line x1={x(rung.totalDofs!) - 4} y1="78" x2={x(rung.totalDofs!) + 4} y2="86" />
          <line x1={x(rung.totalDofs!) + 4} y1="78" x2={x(rung.totalDofs!) - 4} y2="86" />
        </g>
      ))}
      <text x="22" y="104" className="chart-displacement-label">Displacement</text>
      <text x="100" y="104" className="chart-stress-label">Stress</text>
      <text x="190" y="104" className="chart-axis-label">DOF</text>
    </svg>
  );
}

function formatCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(1) : Math.abs(value) >= 1 ? value.toFixed(3) : value.toExponential(3);
}
