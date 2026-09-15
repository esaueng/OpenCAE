/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Boxes, ChevronDown, ChevronLeft, ChevronRight, FileCode2, FileDown, FileImage, FolderDown, Pause, Play, ShieldCheck, Table2, X } from "lucide-react";

import { assessResultFailure, estimateAllowableLoadForSafetyFactor, isModalResultSummary, isThermalResultSummary } from "@opencae/schema";
import type { ModalResultSummary, ResultField, ResultSummary, StructuralResultSummary, ThermalResultSummary } from "@opencae/schema";

import { type ResultMode } from "../../workspaceViewTypes";
import { availableStressComponents } from "../../resultSelection";

import { getViewportTooltipPosition } from "../../tooltipPosition";
import { formatDisplayNumber, formatMeshSourceLabel, formatResultMetric, formatResultNumber, formatResultProvenanceLabel, hasResultUnit, legacyResultWarningForProvenance, solverMethodForResult, solverRunnerLabelForResult } from "../../unitDisplay";

import { useFocusTrap } from "../../hooks/useFocusTrap";

import { dynamicPlaybackFrames } from "../../resultFields";
import { resultScaleCssGradient, validManualResultRange, type ResultColorScaleSetting } from "../../resultColorScale";
import { INVALID_REACTION_WARNING, PREVIEW_GEOMETRY_WARNING, canShowReverseLoadCapacity, hasInvalidReactionForce, hasUnavailableReactionDiagnostic, shouldBlockPreviewResultsForDisplayModel } from "../../resultProvenance";
import {
  frameIndexForRoundedPlaybackOrdinal,
  playbackOrdinalForSolverFramePosition
} from "../../resultPlaybackTimeline";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
import type { RightPanelProps } from "./RightPanelProps";
import { Panel, formatProbeReading } from "./PanelChrome";
import { STRESS_EXAGGERATION_COMMIT_DELAY_MS, stressComponentLabel } from "./RightPanelProps";
import { Callout, Headline, HelpLabel, Info, SectionTitle, formatLoadCapacity, interpolatedFrameTimeSeconds, peakDisplacementFrame } from "./PanelChrome";
export function ResultsPanel(props: RightPanelProps) {
  if (!props.resultSummary) {
    return (
      <Panel title="Results" step="results" helper="View stress and displacement directly on the 3D model." study={props.study}>
        <Callout>Run a simulation to see results.</Callout>
      </Panel>
    );
  }
  if (isModalResultSummary(props.resultSummary)) {
    return <ModalResultsPanelContent {...props} resultSummary={props.resultSummary} />;
  }
  if (isThermalResultSummary(props.resultSummary)) {
    return <ThermalResultsPanelContent {...props} resultSummary={props.resultSummary} />;
  }
  return <ResultsPanelContent {...props} resultSummary={props.resultSummary} />;
}

export function ThermalResultsPanelContent({
  project,
  study,
  resultSummary,
  resultMode,
  onResultModeChange,
  onGenerateReport,
  onExportResultPng,
  onExportResultHtml,
  onExportResultData,
  reportBusy = false,
  pngExportBusy = false,
  htmlExportBusy = false,
  dataExportBusy = null,
  reportError,
  pngExportError,
  htmlExportError,
  dataExportError,
  reportDisabled = false
}: RightPanelProps & { resultSummary: ThermalResultSummary }) {
  return (
    <Panel title="Thermal results" step="results" helper="Inspect steady temperature and conductive heat-flux fields on the solved mesh." study={study}>
      <div className="segmented" role="group" aria-label="Thermal result field">
        <button type="button" className={resultMode === "temperature" ? "active" : ""} aria-pressed={resultMode === "temperature"} onClick={() => onResultModeChange("temperature")}>Temperature</button>
        <button type="button" className={resultMode === "heat_flux" ? "active" : ""} aria-pressed={resultMode === "heat_flux"} onClick={() => onResultModeChange("heat_flux")}>Heat flux</button>
      </div>
      <Headline items={[
        { label: "Minimum temperature", value: formatResultMetric(resultSummary.minTemperature, resultSummary.temperatureUnits) },
        { label: "Maximum temperature", value: formatResultMetric(resultSummary.maxTemperature, resultSummary.temperatureUnits) },
        { label: "Maximum heat flux", value: formatResultMetric(resultSummary.maxHeatFlux, resultSummary.heatFluxUnits) }
      ]} />
      {project.unitSystem === "US" && (
        <p className="muted">Imperial display converts temperatures only. Heat flux and heat rates stay in {resultSummary.heatFluxUnits} and W.</p>
      )}
      <div className="summary-box">
        <Info label="Energy balance error" value={formatResultMetric(resultSummary.energyBalanceRelativeError * 100, "%")} />
      </div>
      <div className="summary-box">
        <Info label="Applied surface heat" value={formatResultMetric(resultSummary.appliedHeat, "W")} />
        <Info label="Generated heat" value={formatResultMetric(resultSummary.generatedHeat, "W")} />
        <Info label="Boundary reaction" value={formatResultMetric(resultSummary.reactionHeat, "W")} />
        <Info label="Result source" value={resultSourceLabelForPanel(resultSummary)} />
      </div>
      <div className="result-actions">
        <button className="secondary wide" type="button" disabled={reportBusy || reportDisabled} onClick={() => void onGenerateReport?.()}><FileDown size={16} />{reportBusy ? "Generating…" : "Generate report"}</button>
        <button className="secondary wide" type="button" disabled={pngExportBusy || reportDisabled} onClick={() => void onExportResultPng?.()}><FileDown size={16} />{pngExportBusy ? "Exporting…" : "Export PNG"}</button>
        <button className="secondary wide" type="button" disabled={htmlExportBusy || reportDisabled} onClick={() => void onExportResultHtml?.()}><FileDown size={16} />{htmlExportBusy ? "Exporting…" : "Export standalone HTML"}</button>
        {onExportResultData && <button className="secondary wide" type="button" disabled={dataExportBusy !== null || reportDisabled} onClick={() => void onExportResultData("csv")}><FileDown size={16} />{dataExportBusy === "csv" ? "Exporting…" : "Export selected-state CSV"}</button>}
        {onExportResultData && <button className="secondary wide" type="button" disabled={dataExportBusy !== null || reportDisabled} onClick={() => void onExportResultData("vtu")}><FileDown size={16} />{dataExportBusy === "vtu" ? "Exporting…" : "Export selected-state VTU"}</button>}
      </div>
      {reportError && <p className="panel-warning">{reportError}</p>}
      {pngExportError && <p className="panel-warning">{pngExportError}</p>}
      {htmlExportError && <p className="panel-warning">{htmlExportError}</p>}
      {dataExportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{dataExportError}</p>}
    </Panel>
  );
}

export function ModalResultsPanelContent({
  study,
  resultSummary,
  resultFields = [],
  selectedModeIndex = resultSummary.modes[0]?.modeIndex ?? 1,
  showDeformed,
  stressExaggeration,
  resultFrameIndex = 0,
  resultFramePosition = resultFrameIndex,
  resultFrameOrdinalPosition,
  resultPlaybackPlaying = false,
  resultPlaybackFps = 12,
  resultPlaybackReverseLoop = false,
  resultPlaybackCacheLabel = "",
  onSelectedModeIndexChange,
  onResultFrameChange,
  onResultPlaybackToggle,
  onResultPlaybackFpsChange,
  onResultPlaybackReverseLoopChange,
  onToggleDeformed,
  onStressExaggerationChange,
  onExportResultData,
  dataExportBusy = null,
  dataExportError,
  reportDisabled = false
}: RightPanelProps & { resultSummary: ModalResultSummary }) {
  const frames = dynamicPlaybackFrames(resultFields);
  const frameIndexes = frames.map((frame) => frame.frameIndex);
  const activeFramePosition = resultPlaybackPlaying ? resultFramePosition : resultFrameIndex;
  const sliderPosition = resultPlaybackPlaying && typeof resultFrameOrdinalPosition === "number"
    ? resultFrameOrdinalPosition
    : playbackOrdinalForSolverFramePosition(frameIndexes, activeFramePosition);
  const phaseDegrees = frames.length ? ((activeFramePosition / frames.length) * 360 + 360) % 360 : 0;
  const activeMode = resultSummary.modes.find((mode) => mode.modeIndex === selectedModeIndex) ?? resultSummary.modes[0];
  const resultProvenance = resultSummary.provenance;
  return (
    <Panel title="Results" step="results" helper="Inspect converged natural frequencies and normalized mode shapes." study={study}>
      {resultSummary.warning && <p className="panel-warning" role="status"><AlertTriangle size={16} />{resultSummary.warning}</p>}
      <Headline items={[
        { label: "Converged modes", value: `${resultSummary.convergedModeCount} / ${resultSummary.requestedModeCount}` }
      ]} />
      <div className="summary-box">
        <Info label="Solver method" value="Block shift-invert" />
        <Info label="Result source" value={resultSourceLabelForPanel(resultSummary)} />
        <Info label="Runner" value={solverRunnerLabelForResult(resultProvenance)} />
      </div>
      <SectionTitle helpId="modalModes">Modes</SectionTitle>
      <div className="modal-mode-table" role="group" aria-label="Converged modes">
        {resultSummary.modes.map((mode) => (
          <button
            key={mode.modeIndex}
            type="button"
            aria-pressed={mode.modeIndex === selectedModeIndex}
            aria-label={`Mode ${mode.modeIndex}, ${Number(mode.frequencyHz.toPrecision(6))} Hz`}
            className={mode.modeIndex === selectedModeIndex ? "primary" : "secondary"}
            onClick={() => onSelectedModeIndexChange?.(mode.modeIndex)}
          >
            <strong>{`Mode ${mode.modeIndex}`}</strong>
            <span>{`${Number(mode.frequencyHz.toPrecision(6))} Hz`}</span>
            <small>{`Residual ${mode.scaledResidual.toExponential(2)}`}</small>
          </button>
        ))}
      </div>
      {activeMode && (
        <div className="summary-box">
          <Info label="Frequency" value={`${Number(activeMode.frequencyHz.toPrecision(6))} Hz`} />
          <Info label="Eigenvalue" value={Number(activeMode.eigenvalue.toPrecision(6)).toString()} />
          <Info label="Scaled residual" value={activeMode.scaledResidual.toExponential(3)} />
          <Info label="Shape units" value="normalized" />
        </div>
      )}
      {frames.length > 1 && (
        <div className="dynamic-playback">
          <SectionTitle helpId="modePhase">Phase</SectionTitle>
          <label className="field range-field">
            <span className="range-label"><span>Phase</span><strong>{`${phaseDegrees.toFixed(0)}°`}</strong></span>
            <input
              className="playback-time-range"
              type="range"
              aria-label="Mode phase"
              min="0"
              max={Math.max(frames.length - 1, 0)}
              step={resultPlaybackPlaying ? "0.01" : "1"}
              value={sliderPosition}
              onChange={(event) => onResultFrameChange?.(frameIndexForRoundedPlaybackOrdinal(frameIndexes, Number(event.currentTarget.value)))}
            />
          </label>
          <label className="field range-field">
            <span className="range-label"><span>Animation speed</span><strong>{Math.round(resultPlaybackFps)} fps</strong></span>
            <input type="range" min="1" max="30" step="1" value={resultPlaybackFps} onChange={(event) => onResultPlaybackFpsChange?.(Number(event.currentTarget.value))} />
          </label>
          <label className="toggle playback-loop-toggle">
            <input type="checkbox" checked={resultPlaybackReverseLoop} onChange={(event) => onResultPlaybackReverseLoopChange?.(event.currentTarget.checked)} />
            <span>Reverse loop</span>
          </label>
          <button className="secondary wide" type="button" onClick={onResultPlaybackToggle}>{resultPlaybackPlaying ? <Pause size={16} /> : <Play size={16} />}{resultPlaybackPlaying ? "Pause" : "Play"}</button>
          {resultPlaybackCacheLabel && <small className="playback-cache-status">{resultPlaybackCacheLabel}</small>}
        </div>
      )}
      <label className="toggle"><input type="checkbox" checked={showDeformed} onChange={onToggleDeformed} /> Animate mode shape</label>
      <label className="field range-field">
        <span className="range-label"><span>Visualization amplitude</span><strong>{stressExaggeration.toFixed(1)}x</strong></span>
        <input type="range" min="0.5" max="4" step="0.1" value={stressExaggeration} onChange={(event) => onStressExaggerationChange(Number(event.currentTarget.value))} />
      </label>
      <p className="panel-copy">Amplitude and phase are visualization-only. Normalized mode shapes are not physical displacements.</p>
      {onExportResultData && (
        <div className="result-actions">
          <button className="secondary wide" type="button" disabled={dataExportBusy !== null || reportDisabled} onClick={() => void onExportResultData("csv")}><FileDown size={16} />{dataExportBusy === "csv" ? "Exporting…" : "Export selected-mode CSV"}</button>
          <button className="secondary wide" type="button" disabled={dataExportBusy !== null || reportDisabled} onClick={() => void onExportResultData("vtu")}><FileDown size={16} />{dataExportBusy === "vtu" ? "Exporting…" : "Export selected-mode VTU"}</button>
        </div>
      )}
      {dataExportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{dataExportError}</p>}
      <div className="legend"><small>Node</small><span /><small>Antinode</small></div>
    </Panel>
  );
}

type ResultExportItem = {
  id: string;
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled?: boolean;
  icon: ReactNode;
  run: () => void;
};

/**
 * Collapses the result download actions into one "Export" trigger plus a
 * popover menu so the Results panel keeps a single primary action ("Generate
 * report") instead of a column of five equally weighted buttons. While an
 * export is running the trigger itself carries that item's busy label, so the
 * state stays visible without reopening the menu.
 */
function ResultExportMenu({ items }: { items: ResultExportItem[] }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false));
  const busyItem = items.find((item) => item.busy) ?? null;
  const allDisabled = items.every((item) => item.disabled);

  const updateMenuPosition = useCallback(() => {
    const trigger = containerRef.current;
    if (!trigger || typeof window === "undefined") return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuWidth = triggerRect.width;
    const position = getViewportTooltipPosition({
      triggerRect,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tooltip: { width: menuWidth, height: menuRect?.height || 188 },
      gap: 4,
      margin: 12
    });
    setMenuStyle({ top: position.top, left: position.left, width: menuWidth });
  }, [menuRef]);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuRef, open]);

  if (items.length === 0) return null;

  return (
    <div className="export-menu" ref={containerRef}>
      <button
        className="secondary wide export-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={allDisabled}
        onClick={() => setOpen((current) => !current)}
      >
        <FileDown size={18} />
        {busyItem ? busyItem.busyLabel : "Export"}
        <ChevronDown className="export-menu-caret" size={16} />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          className="export-menu-popover export-menu-popover--floating"
          role="menu"
          aria-label="Export formats"
          ref={menuRef}
          style={menuStyle}
        >
          {items.map((item) => (
            <button
              key={item.id}
              className="export-menu-item"
              type="button"
              role="menuitem"
              disabled={item.disabled || busyItem !== null}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.icon}
              {item.busy ? item.busyLabel : item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

export function ResultsPanelContent({
  displayModel,
  resultControlsBusy = false,
  resultMode,
  stressComponent = "von_mises",
  showDeformed,
  stressExaggeration,
  resultSummary,
  resultFields = [],
  resultColorScale,
  resultColorScaleControl,
  resultVariants = [],
  activeResultVariantId = resultVariants[0]?.id ?? "",
  resultProbes = [],
  resultProbeLimitReached = false,
  study,
  resultFrameIndex = 0,
  resultFramePosition = resultFrameIndex,
  resultFrameOrdinalPosition,
  resultPlaybackPlaying = false,
  resultPlaybackFps = 12,
  resultPlaybackReverseLoop = false,
  resultPlaybackCacheLabel = "",
  onResultFrameChange,
  onResultPlaybackToggle,
  onResultPlaybackFpsChange,
  onResultPlaybackReverseLoopChange,
  onResultModeChange,
  onStressComponentChange,
  onResultColorScaleSettingChange,
  onResultVariantChange,
  onRemoveResultProbe,
  onClearResultProbes,
  onToggleDeformed,
  onStressExaggerationChange,
  onGenerateReport,
  onExportResultPng,
  onExportResultHtml,
  onExportResultData,
  onSaveProject,
  reportBusy = false,
  reportError,
  reportDisabled = false,
  pngExportBusy = false,
  pngExportError,
  htmlExportBusy = false,
  htmlExportError,
  dataExportBusy = null,
  dataExportError
}: RightPanelProps & { resultSummary: StructuralResultSummary }) {
  const [targetSafetyFactor, setTargetSafetyFactor] = useState(1.5);
  const [draftStressExaggeration, setDraftStressExaggeration] = useState(stressExaggeration);
  const [draftScaleMin, setDraftScaleMin] = useState(() => String(resultColorScaleControl?.displayMin ?? 0));
  const [draftScaleMax, setDraftScaleMax] = useState(() => String(resultColorScaleControl?.displayMax ?? 1));
  const stressExaggerationCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedStressExaggerationRef = useRef(stressExaggeration);
  const assessment = assessResultFailure(resultSummary);
  const loadCapacity = estimateAllowableLoadForSafetyFactor(resultSummary, targetSafetyFactor);
  const loadCapacityAtOne = estimateAllowableLoadForSafetyFactor(resultSummary, 1);
  const blockPreviewResults = shouldBlockPreviewResultsForDisplayModel(displayModel, resultSummary, resultFields, study);
  const reactionForceInvalid = hasInvalidReactionForce(resultSummary, study) || hasUnavailableReactionDiagnostic(resultSummary);
  const resultContractInvalid = resultContractHasMissingUnits(resultSummary, resultFields);
  const unitMissingDiagnostic = resultContractInvalid ? "Unit missing" : null;
  const canEstimateLoad = !resultContractInvalid && loadCapacity.status === "available" && canShowReverseLoadCapacity(resultSummary, displayModel, resultFields, study);
  const AssessmentIcon = assessment.status === "pass" ? ShieldCheck : AlertTriangle;
  const frames = dynamicPlaybackFrames(resultFields);
  const hasPlayback = frames.length > 1;
  const activeFrame = frames.find((frame) => frame.frameIndex === resultFrameIndex) ?? frames[0];
  const activeFramePosition = resultPlaybackPlaying ? resultFramePosition : activeFrame?.frameIndex ?? resultFrameIndex;
  const activeTimeSeconds = interpolatedFrameTimeSeconds(frames, activeFramePosition);
  const frameIndexes = frames.map((frame) => frame.frameIndex);
  const sliderPosition = resultPlaybackPlaying && typeof resultFrameOrdinalPosition === "number"
    ? resultFrameOrdinalPosition
    : playbackOrdinalForSolverFramePosition(frameIndexes, activeFramePosition);
  const currentFrameNumber = frames.length ? Math.min(frames.length, Math.max(1, Math.floor(sliderPosition) + 1)) : 0;
  const peakDisplacement = peakDisplacementFrame(resultFields, resultSummary);
  const peakMarkerPercent = peakDisplacement && hasPlayback ? playbackPeakMarkerPercent(frames, peakDisplacement.timeSeconds) : null;
  const peakMarkerLabel = peakDisplacement ? `Peak displacement at ${peakDisplacement.timeSeconds.toFixed(4)} s` : "";
  const resultProvenance = resultSummary.provenance;
  const legacyResultWarning = legacyResultWarningForProvenance(resultProvenance);
  const stressComponents = availableStressComponents(resultFields);

  useEffect(() => {
    committedStressExaggerationRef.current = stressExaggeration;
    setDraftStressExaggeration(stressExaggeration);
  }, [stressExaggeration]);

  useEffect(() => {
    setDraftScaleMin(String(resultColorScaleControl?.displayMin ?? 0));
    setDraftScaleMax(String(resultColorScaleControl?.displayMax ?? 1));
  }, [resultColorScaleControl?.displayMax, resultColorScaleControl?.displayMin, resultColorScaleControl?.units]);

  useEffect(() => () => {
    if (stressExaggerationCommitTimerRef.current) clearTimeout(stressExaggerationCommitTimerRef.current);
  }, []);

  function commitStressExaggeration(value: number) {
    const nextValue = Number(value.toFixed(1));
    if (stressExaggerationCommitTimerRef.current) {
      clearTimeout(stressExaggerationCommitTimerRef.current);
      stressExaggerationCommitTimerRef.current = null;
    }
    if (Math.abs(nextValue - committedStressExaggerationRef.current) < 0.001) return;
    committedStressExaggerationRef.current = nextValue;
    onStressExaggerationChange(nextValue);
  }

  function scheduleStressExaggerationCommit(value: number) {
    if (stressExaggerationCommitTimerRef.current) clearTimeout(stressExaggerationCommitTimerRef.current);
    stressExaggerationCommitTimerRef.current = setTimeout(() => {
      commitStressExaggeration(value);
    }, STRESS_EXAGGERATION_COMMIT_DELAY_MS);
  }

  function updateDraftStressExaggeration(value: number) {
    const nextValue = Number(value.toFixed(1));
    setDraftStressExaggeration(nextValue);
    scheduleStressExaggerationCommit(nextValue);
  }

  const parsedScaleMin = draftScaleMin.trim() ? Number(draftScaleMin) : Number.NaN;
  const parsedScaleMax = draftScaleMax.trim() ? Number(draftScaleMax) : Number.NaN;
  const manualScaleValid = validManualResultRange(parsedScaleMin, parsedScaleMax);

  function updateColorScaleSetting(patch: Partial<ResultColorScaleSetting>) {
    if (!resultColorScaleControl || !onResultColorScaleSettingChange) return;
    onResultColorScaleSettingChange({ ...resultColorScaleControl.setting, ...patch });
  }

  function enableManualScale() {
    if (!resultColorScaleControl) return;
    const min = manualScaleValid ? parsedScaleMin : resultColorScaleControl.automaticMin;
    const max = manualScaleValid ? parsedScaleMax : resultColorScaleControl.automaticMax;
    setDraftScaleMin(String(min));
    setDraftScaleMax(String(max));
    updateColorScaleSetting({ rangeMode: "manual", manualMin: min, manualMax: max });
  }

  function commitManualScale() {
    if (!manualScaleValid) return;
    updateColorScaleSetting({ rangeMode: "manual", manualMin: parsedScaleMin, manualMax: parsedScaleMax });
  }

  const exportMenuItems: ResultExportItem[] = [
    ...(onExportResultPng ? [{
      id: "png",
      label: "PNG image",
      busyLabel: "Exporting PNG…",
      busy: pngExportBusy,
      disabled: reportDisabled,
      icon: <FileImage size={16} />,
      run: () => void onExportResultPng()
    }] : []),
    ...(onExportResultHtml ? [{
      id: "html",
      label: "Offline HTML",
      busyLabel: "Packaging HTML…",
      busy: htmlExportBusy,
      disabled: reportDisabled,
      icon: <FileCode2 size={16} />,
      run: () => void onExportResultHtml()
    }] : []),
    ...(onExportResultData ? [{
      id: "csv",
      label: "Selected-state CSV",
      busyLabel: "Exporting CSV…",
      busy: dataExportBusy === "csv",
      disabled: reportDisabled,
      icon: <Table2 size={16} />,
      run: () => void onExportResultData("csv")
    }, {
      id: "vtu",
      label: "Selected-state VTU",
      busyLabel: "Exporting VTU…",
      busy: dataExportBusy === "vtu",
      disabled: reportDisabled,
      icon: <Boxes size={16} />,
      run: () => void onExportResultData("vtu")
    }] : []),
    // The project file bundles geometry, study setup and the stored results, so
    // it stays available while a run is in flight (unlike the result exports,
    // which need a settled result state).
    ...(onSaveProject ? [{
      id: "project",
      label: "Full project file",
      busyLabel: "Saving project…",
      busy: false,
      icon: <FolderDown size={16} />,
      run: () => void onSaveProject()
    }] : [])
  ];

  return (
    <Panel title="Results" step="results" helper="View stress and displacement directly on the 3D model." study={study}>
      {resultVariants.length > 1 && (
        <label className="field result-variant-selector">
          <span>Run variant</span>
          <select value={activeResultVariantId} onChange={(event) => void onResultVariantChange?.(event.currentTarget.value)}>
            {resultVariants.map((variant) => (
              <option key={variant.id} value={variant.id}>{variant.name}{variant.kind === "envelope" && !/envelope/i.test(variant.name) ? " · envelope" : ""}</option>
            ))}
          </select>
        </label>
      )}
      <div className={`failure-assessment ${assessment.status}`}>
        <span className="assessment-icon"><AssessmentIcon size={20} /></span>
        <span>
          <strong>{assessment.title}</strong>
          <small>{assessment.message}</small>
        </span>
      </div>
      <Headline items={[
        { label: "Max stress", value: formatResultMetric(resultSummary.maxStress, resultSummary.maxStressUnits) },
        { label: "Max displacement", value: formatResultMetric(resultSummary.maxDisplacement, resultSummary.maxDisplacementUnits) },
        { label: "Safety factor", value: formatResultNumber(resultSummary.safetyFactor) },
        { label: "Reaction force", value: formatResultMetric(resultSummary.reactionForce, resultSummary.reactionForceUnits) }
      ]} />
      {hasPlayback && (
        <div className="dynamic-playback">
          <SectionTitle helpId="resultFrame">Frame</SectionTitle>
          <label className="field range-field">
            <span className="range-label"><span>Current time</span><strong>{`${activeTimeSeconds.toFixed(4)} s · Frame ${currentFrameNumber} / ${frames.length}`}</strong></span>
            <span
              className="playback-time-track"
              style={peakMarkerPercent !== null ? ({ "--playback-peak-position": `${peakMarkerPercent}%` } as CSSProperties) : undefined}
            >
              <input
                className="playback-time-range"
                type="range"
                aria-label="Playback time position"
                min="0"
                max={Math.max(frames.length - 1, 0)}
                step={resultPlaybackPlaying ? "0.01" : "1"}
                value={sliderPosition}
                onChange={(event) => onResultFrameChange?.(frameIndexForRoundedPlaybackOrdinal(frameIndexes, Number(event.currentTarget.value)))}
              />
              {peakMarkerPercent !== null && (
                <span
                  className="playback-peak-marker"
                  role="img"
                  aria-label={peakMarkerLabel}
                  title={peakMarkerLabel}
                />
              )}
            </span>
          </label>
          <label className="field range-field">
            <span className="range-label"><span>Animation speed</span><strong>{Math.round(resultPlaybackFps)} fps</strong></span>
            <input
              type="range"
              min="1"
              max="30"
              step="1"
              value={resultPlaybackFps}
              style={{ "--range-progress": `${rangeProgressPercent(resultPlaybackFps, 1, 30)}%` } as CSSProperties}
              onChange={(event) => onResultPlaybackFpsChange?.(Number(event.currentTarget.value))}
            />
          </label>
          <label className="toggle playback-loop-toggle">
            <input
              type="checkbox"
              aria-label="Reverse loop"
              checked={resultPlaybackReverseLoop}
              onChange={(event) => onResultPlaybackReverseLoopChange?.(event.currentTarget.checked)}
            />
            <span>Reverse loop</span>
          </label>
          {/* Frame stepping used to be keyboard-only on the range input (2026-09 review F11). */}
          <div className="playback-transport">
            <button className="secondary" type="button" aria-label="Previous frame" title="Previous frame" disabled={resultPlaybackPlaying || currentFrameNumber <= 1} onClick={() => onResultFrameChange?.(frameIndexes[currentFrameNumber - 2] ?? frameIndexes[0]!)}>
              <ChevronLeft size={16} />
            </button>
            <button className="secondary wide" type="button" onClick={() => {
              onResultPlaybackToggle?.();
            }}>{resultPlaybackPlaying ? <Pause size={16} /> : <Play size={16} />}{resultPlaybackPlaying ? "Pause" : "Play"}</button>
            <button className="secondary" type="button" aria-label="Next frame" title="Next frame" disabled={resultPlaybackPlaying || currentFrameNumber >= frames.length} onClick={() => onResultFrameChange?.(frameIndexes[currentFrameNumber] ?? frameIndexes[frameIndexes.length - 1]!)}>
              <ChevronRight size={16} />
            </button>
          </div>
          {resultPlaybackCacheLabel && <small className="playback-cache-status">{resultPlaybackCacheLabel}</small>}
          <Info label="Peak displacement" value={peakDisplacement ? `${Number(peakDisplacement.value.toPrecision(3))} ${peakDisplacement.units} at ${peakDisplacement.timeSeconds.toFixed(4)} s` : "Unavailable"} />
        </div>
      )}
      <SectionTitle helpId="resultMode">Result mode</SectionTitle>
      <div className="segmented result-mode" role="group" aria-label="Result mode" aria-busy={resultControlsBusy || undefined} title={resultControlsBusy ? "Preparing report figures; the view switches briefly." : undefined}>
        <button type="button" className={resultMode === "stress" ? "active" : ""} aria-pressed={resultMode === "stress"} disabled={resultControlsBusy} onClick={() => onResultModeChange("stress")}>Stress</button>
        <button type="button" className={resultMode === "displacement" ? "active" : ""} aria-pressed={resultMode === "displacement"} disabled={resultControlsBusy} onClick={() => onResultModeChange("displacement")}>Displacement</button>
        {resultFields.some((field) => field.type === "velocity") && <button type="button" className={resultMode === "velocity" ? "active" : ""} aria-pressed={resultMode === "velocity"} onClick={() => onResultModeChange("velocity")}>Velocity</button>}
        {resultFields.some((field) => field.type === "acceleration") && <button type="button" className={resultMode === "acceleration" ? "active" : ""} aria-pressed={resultMode === "acceleration"} onClick={() => onResultModeChange("acceleration")}>Acceleration</button>}
        <button type="button" className={resultMode === "safety_factor" ? "active" : ""} aria-pressed={resultMode === "safety_factor"} onClick={() => onResultModeChange("safety_factor")}>Safety factor</button>
      </div>
      {resultMode === "stress" && stressComponents.length > 0 && (
        <div className="field">
          <SectionTitle helpId="stressMeasure">Stress measure</SectionTitle>
          <div className="segmented stress-measure" role="group" aria-label="Stress measure">
            {stressComponents.map((component) => (
              <button
                key={component}
                className={stressComponent === component ? "active" : ""}
                type="button"
                aria-pressed={stressComponent === component}
                onClick={() => onStressComponentChange?.(component)}
              >{stressComponentLabel(component)}</button>
            ))}
          </div>
        </div>
      )}
      {resultMode === "stress" && (
        <p className="panel-copy">Max stress reports the solver&apos;s peak von Mises stress. Surface averaging or smoothing can lower the legend maximum; changing the stress measure or color range does not change Max stress.</p>
      )}
      {resultColorScaleControl && (
        <section className="result-scale-controls" aria-label="Result color scale">
          <div className="result-probe-list-header">
            <SectionTitle helpId="colorScale">Color scale</SectionTitle>
            <button className="text-button" type="button" onClick={() => {
              setDraftScaleMin(String(resultColorScaleControl.automaticMin));
              setDraftScaleMax(String(resultColorScaleControl.automaticMax));
              updateColorScaleSetting({ rangeMode: "auto", manualMin: undefined, manualMax: undefined });
            }}>Reset</button>
          </div>
          <div className="segmented" role="group" aria-label="Color range mode">
            <button className={resultColorScaleControl.setting.rangeMode === "auto" ? "active" : ""} type="button" aria-pressed={resultColorScaleControl.setting.rangeMode === "auto"} onClick={() => updateColorScaleSetting({ rangeMode: "auto" })}>Auto</button>
            <button className={resultColorScaleControl.setting.rangeMode === "manual" ? "active" : ""} type="button" aria-pressed={resultColorScaleControl.setting.rangeMode === "manual"} onClick={enableManualScale}>Manual</button>
          </div>
          {resultColorScaleControl.setting.rangeMode === "manual" && (
            <div className="result-scale-range-inputs">
              <label className="field">
                <span>Minimum</span>
                <span className="input-with-unit"><input aria-label="Color scale minimum" type="number" value={draftScaleMin} onChange={(event) => setDraftScaleMin(event.currentTarget.value)} onBlur={commitManualScale} /><span>{resultColorScaleControl.units}</span></span>
              </label>
              <label className="field">
                <span>Maximum</span>
                <span className="input-with-unit"><input aria-label="Color scale maximum" type="number" value={draftScaleMax} onChange={(event) => setDraftScaleMax(event.currentTarget.value)} onBlur={commitManualScale} /><span>{resultColorScaleControl.units}</span></span>
              </label>
              {!manualScaleValid && <p className="panel-warning" role="alert">Minimum and maximum must be finite, distinct values with minimum below maximum.</p>}
            </div>
          )}
          <div className="segmented" role="group" aria-label="Color scale bands">
            <button className={resultColorScaleControl.setting.bands === "continuous" ? "active" : ""} type="button" aria-pressed={resultColorScaleControl.setting.bands === "continuous"} onClick={() => updateColorScaleSetting({ bands: "continuous" })}>Continuous</button>
            <button className={resultColorScaleControl.setting.bands === "bands8" ? "active" : ""} type="button" aria-pressed={resultColorScaleControl.setting.bands === "bands8"} onClick={() => updateColorScaleSetting({ bands: "bands8" })}>8 bands</button>
          </div>
          <small>{`Automatic run range: ${formatDisplayNumber(resultColorScaleControl.automaticMin)}–${formatDisplayNumber(resultColorScaleControl.automaticMax)}${resultColorScaleControl.units ? ` ${resultColorScaleControl.units}` : ""}`}</small>
        </section>
      )}
      {(resultProbes.length > 0 || resultProbeLimitReached) && (
        <section className="result-probe-list" aria-label="Pinned result probes">
          <div className="result-probe-list-header">
            <SectionTitle helpId="pinnedProbes">Pinned probes</SectionTitle>
            {resultProbes.length > 0 && onClearResultProbes && <button className="text-button" type="button" onClick={onClearResultProbes}>Clear all</button>}
          </div>
          {resultProbeLimitReached && <p className="panel-warning" role="status">Probe limit reached. Remove a pin to place another.</p>}
          {resultProbes.length > 0 && (
            <ol>
              {resultProbes.map((probe, index) => (
                <li key={probe.id}>
                  <span>
                    <strong>{`P${index + 1}`}</strong>
                    <small>{formatProbeReading(probe)}</small>
                    {probe.governingVariantName && <small>{`Governed near probe by ${probe.governingVariantName}`}</small>}
                  </span>
                  {onRemoveResultProbe && <button className="icon-button" type="button" aria-label={`Remove probe ${index + 1}`} onClick={() => onRemoveResultProbe(probe.id)}><X size={14} /></button>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {/* One deformation control in every structural mode; it used to render only in Stress (2026-09 review D25). */}
      {(
        <label className="field range-field">
          <span className="range-label"><HelpLabel helpId="stressExaggeration">Deformation scale</HelpLabel><strong>{draftStressExaggeration.toFixed(1)}x · multiplies the legend factor</strong></span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.1"
            value={draftStressExaggeration}
            style={{ "--range-progress": `${rangeProgressPercent(draftStressExaggeration, 1, 4)}%` } as CSSProperties}
            onChange={(event) => updateDraftStressExaggeration(Number(event.currentTarget.value))}
            onPointerUp={() => commitStressExaggeration(draftStressExaggeration)}
            onKeyUp={() => commitStressExaggeration(draftStressExaggeration)}
            onBlur={() => commitStressExaggeration(draftStressExaggeration)}
          />
        </label>
      )}
      <label className="toggle"><input type="checkbox" aria-label="Deformed shape" checked={showDeformed && !blockPreviewResults} disabled={blockPreviewResults} onChange={onToggleDeformed} /> <HelpLabel helpId="deformedShape">Deformed shape</HelpLabel></label>
      {blockPreviewResults && <p className="panel-warning">{PREVIEW_GEOMETRY_WARNING}</p>}
      {legacyResultWarning && <p className="panel-warning">{legacyResultWarning}</p>}
      {reactionForceInvalid && <p className="panel-warning">{INVALID_REACTION_WARNING}</p>}
      {unitMissingDiagnostic && <p className="panel-warning">{unitMissingDiagnostic}</p>}
      <p className="panel-copy">{resultModeExplanation(resultMode)}</p>
      <div className="summary-box">
        <Info label="Result source" value={resultSourceLabelForPanel(resultSummary)} />
        <Info label="Mesh source" value={formatMeshSourceLabel(resultProvenance?.meshSource, displayModel)} />
        <Info label="Solver method" value={solverMethodForResult(resultSummary, study)} />
        <Info label="Runner" value={solverRunnerLabelForResult(resultProvenance)} />
      </div>
      {canEstimateLoad && (
        <>
          <SectionTitle helpId="targetSafetyFactor">Reverse Check</SectionTitle>
          {/* The linearity caveat used to appear only in the PDF (2026-09 review F9). */}
          <p className="muted">Linear scaling of this result against the material yield limit. Verify with a run at the target load.</p>
          <div className="load-capacity-tool">
            <label className="field">
              <HelpLabel helpId="targetSafetyFactor">Target factor of safety</HelpLabel>
              <span className="input-with-unit">
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={targetSafetyFactor}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value);
                    setTargetSafetyFactor(Number.isFinite(next) && next > 0 ? next : 1.5);
                  }}
                />
                <span>FoS</span>
              </span>
            </label>
            <div className="capacity-readout">
              <span>Max total load</span>
              <strong>{`${formatLoadCapacity(loadCapacity.allowableLoad)} ${loadCapacity.loadUnits}`}</strong>
              <small>{`Current ${formatLoadCapacity(loadCapacity.currentLoad)} ${loadCapacity.loadUnits} · ${formatLoadCapacity(loadCapacity.loadScale)}x`}</small>
              <small>{`Max force at 1.0 FoS · ${formatLoadCapacity(loadCapacityAtOne.allowableLoad)} ${loadCapacityAtOne.loadUnits}`}</small>
            </div>
          </div>
        </>
      )}
      <div className="legend"><small>Low</small><span style={resultColorScale ? { background: resultScaleCssGradient(resultColorScale) } : undefined} /><small>High</small></div>
      {(onGenerateReport || exportMenuItems.length > 0) && (
        <div className="result-actions">
          {onGenerateReport && (
            <button className="primary wide" type="button" disabled={reportBusy || reportDisabled} onClick={() => void onGenerateReport({ targetSafetyFactor })}>
              <FileDown size={18} />{reportBusy ? "Generating…" : "Generate report"}
            </button>
          )}
          <ResultExportMenu items={exportMenuItems} />
        </div>
      )}
      {reportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{reportError}</p>}
      {pngExportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{pngExportError}</p>}
      {htmlExportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{htmlExportError}</p>}
      {dataExportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{dataExportError}</p>}
    </Panel>
  );
}

function resultSourceLabelForPanel(resultSummary: ResultSummary): string {
  const label = formatResultProvenanceLabel(resultSummary.provenance);
  return label === "OpenCAE Core Local (in-browser)" ? "Local (in-browser)" : label;
}

function resultContractHasMissingUnits(summary: StructuralResultSummary, fields: ResultField[]): boolean {
  return !hasResultUnit(summary.maxStressUnits) ||
    !hasResultUnit(summary.maxDisplacementUnits) ||
    !hasResultUnit(summary.reactionForceUnits) ||
    fields.some((field) => !hasResultUnit(field.units));
}

export function rangeProgressPercent(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export function playbackPeakMarkerPercent(frames: Array<{ frameIndex: number; timeSeconds: number }>, peakTimeSeconds: number) {
  const finiteFrames = frames.filter((frame) => Number.isFinite(frame.timeSeconds));
  if (!Number.isFinite(peakTimeSeconds) || finiteFrames.length < 2) return 0;
  const first = finiteFrames[0]!;
  const last = finiteFrames[finiteFrames.length - 1]!;
  if (peakTimeSeconds <= first.timeSeconds) return 0;
  if (peakTimeSeconds >= last.timeSeconds) return 100;
  for (let index = 0; index < finiteFrames.length - 1; index += 1) {
    const lower = finiteFrames[index]!;
    const upper = finiteFrames[index + 1]!;
    if (peakTimeSeconds < lower.timeSeconds || peakTimeSeconds > upper.timeSeconds) continue;
    const blend = upper.timeSeconds === lower.timeSeconds
      ? 0
      : (peakTimeSeconds - lower.timeSeconds) / (upper.timeSeconds - lower.timeSeconds);
    return rangeProgressPercent(index + Math.max(0, Math.min(1, blend)), 0, finiteFrames.length - 1);
  }
  return 0;
}

export function resultModeExplanation(resultMode: ResultMode): string {
  // The safety-factor ramp runs the other way (SAFETY_RAMP: red at low factors,
  // green at high) and has no blue, so the generic sentence would be inverted.
  if (resultMode === "safety_factor") return "Red areas are closest to yield (low safety factor). Green areas have the most margin.";
  const field = resultMode === "displacement"
    ? "displacement magnitude"
    : resultMode === "velocity"
      ? "velocity magnitude"
      : resultMode === "acceleration"
        ? "acceleration magnitude"
        : resultMode === "temperature"
          ? "temperature"
          : resultMode === "heat_flux"
            ? "heat flux"
            : resultMode === "mode_shape"
              ? "normalized mode-shape amplitude"
              : "stress";
  return `Red areas have higher ${field}. Blue areas have lower ${field}.`;
}

/* Modal studies have no loads step. The rail, the Back/Next pair and the "Step N of M"
   eyebrow must all count the same list, or the panel numbers a step the rail does not show. */
