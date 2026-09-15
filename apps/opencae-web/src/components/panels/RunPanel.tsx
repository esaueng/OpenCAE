/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useCallback, useEffect, useId, useState } from "react";

import { AlertTriangle, Check, Play, X } from "lucide-react";

import type { DisplayModel, DynamicSolverSettings, SimulationFidelity, Study } from "@opencae/schema";

import { STUDY_TYPE_LABELS, studyTypeSwitchConsequence } from "../../studyTypeSwitch";

import { type SettingHelpId } from "../../settingHelp";

import { defaultSolverMethodForStudy } from "../../unitDisplay";

import type { RightPanelProps, SolverSettingsPatch } from "./RightPanelProps";
import { Panel } from "./PanelChrome";
import { DEFAULT_DYNAMIC_LOAD_PROFILE_HELPER, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS, DYNAMIC_LOAD_PROFILE_OPTIONS, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS, SIMULATION_FIDELITIES } from "./RightPanelProps";
import { HelpLabel, Info, SectionTitle, capitalize, dynamicFrameEstimate, formatSeconds, isDynamicLoadProfile, normalizedDynamicOutputInterval } from "./PanelChrome";
export function RunPanel({ study, displayModel, runProgress, runError, runTiming, solveElapsedMs, onRunSimulation, onCancelSimulation, canCancelSimulation, onUpdateSolverSettings, onChangeStudyType, canRunSimulation, missingRunItems, runReadiness }: RightPanelProps) {
  const progressPercent = Math.max(0, Math.min(100, Math.round(runProgress)));
  const isRunning = canCancelSimulation ?? (progressPercent > 0 && progressPercent < 100);
  const remainingLabel = formatSimulationEta(runTiming?.estimatedRemainingMs, isRunning);
  const elapsedLabel = formatSimulationElapsed(runTiming?.elapsedMs);
  const [invalidSettingFields, setInvalidSettingFields] = useState<readonly string[]>([]);
  /* Forward warning (plan 027): structural ↔ thermal clears supports and loads. The
     first click on such a type shows what will be lost; only the second click switches. */
  const [pendingStudyType, setPendingStudyType] = useState<Study["type"] | null>(null);
  const pendingSwitchId = useId();
  useEffect(() => { setPendingStudyType(null); }, [study.type]);
  const pendingConsequence = pendingStudyType ? studyTypeSwitchConsequence(study, pendingStudyType) : null;
  function requestStudyType(type: Study["type"]) {
    if (study.type === type) return;
    if (studyTypeSwitchConsequence(study, type) && pendingStudyType !== type) {
      setPendingStudyType(type);
      return;
    }
    setPendingStudyType(null);
    onChangeStudyType?.(type);
  }
  const trackSettingValidity = useCallback((field: string, invalid: boolean) => {
    setInvalidSettingFields((current) => {
      const has = current.includes(field);
      if (invalid === has) return current;
      return invalid ? [...current, field] : current.filter((item) => item !== field);
    });
  }, []);
  const hasInvalidSettingDraft = invalidSettingFields.length > 0;
  const dynamic = study.type === "dynamic_structural" ? study.solverSettings : null;
  const modal = study.type === "modal_analysis" ? study.solverSettings : null;
  const thermal = study.type === "steady_state_thermal";
  const fidelity = solverFidelityForStudy(study);
  const updateSolverChoice = (settings: SolverSettingsPatch) => {
    onUpdateSolverSettings?.(settings);
  };
  const updateDynamicNumber = (key: keyof Pick<DynamicSolverSettings, "startTime" | "endTime" | "timeStep" | "outputInterval" | "dampingRatio">, value: number) => {
    if (!Number.isFinite(value)) return;
    onUpdateSolverSettings?.({ [key]: value });
  };
  const updateDynamicLoadProfile = (value: string) => {
    if (!isDynamicLoadProfile(value)) return;
    onUpdateSolverSettings?.({ loadProfile: value });
  };
  const frameEstimate = dynamic ? dynamicFrameEstimate(dynamic) : null;
  const outputIntervalMinimum = MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
  const outputIntervalValue = dynamic?.outputInterval ?? DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
  const loadProfile = isDynamicLoadProfile(dynamic?.loadProfile) ? dynamic.loadProfile : "ramp";
  const loadProfileHelper = DYNAMIC_LOAD_PROFILE_OPTIONS.find((option) => option.value === loadProfile)?.helper ?? DEFAULT_DYNAMIC_LOAD_PROFILE_HELPER;
  return (
    <Panel title="Run" step="run" helper={modal ? "Solve for natural frequencies and normalized mode shapes." : thermal ? "Solve for steady temperature and heat-flux fields." : "Run the simulation to estimate stress and displacement."} study={study}>
      <SectionTitle helpId="runReadiness">Readiness</SectionTitle>
      <div className="checklist">
        {runReadiness.map(({ label, done, blockers }) => (
          <div key={label} className={done ? "check done" : "check"}>
            <span>{done ? <Check size={18} /> : null}</span>
            <span className="check-copy">
              {label}
              {/* Blockers used to live only in a title tooltip (2026-09 review F7). */}
              {!done && blockers.length > 0 && <small className="check-blockers">{blockers.join(" ")}</small>}
            </span>
          </div>
        ))}
      </div>
      {/* B5: the backend picker is gone — every simulation runs locally in the
          browser, so a choice would be routing theater. The Solver info block
          below states the backend; solverSettings.backend stays in the schema
          so older project files (including retired cloud selections) still
          round-trip. */}
      <SectionTitle helpId="simulationSettings">Simulation settings</SectionTitle>
      <div className="field">
        <span>Analysis type</span>
        <div className="segmented analysis-type run-analysis-type" role="group" aria-label="Analysis type">
          {(["static_stress", "dynamic_structural", "modal_analysis", "steady_state_thermal"] as const).map((type) => {
            const consequence = studyTypeSwitchConsequence(study, type);
            return (
              <button
                key={type}
                className={study.type === type ? "active" : ""}
                type="button"
                aria-pressed={study.type === type}
                aria-describedby={pendingStudyType === type ? pendingSwitchId : undefined}
                disabled={isRunning}
                title={consequence ? `${consequence.message} Click twice to confirm.` : undefined}
                onClick={() => requestStudyType(type)}
              >{STUDY_TYPE_LABELS[type]}</button>
            );
          })}
        </div>
        {pendingStudyType && pendingConsequence && (
          <p className="panel-warning study-type-warning" role="alert" id={pendingSwitchId}>
            <AlertTriangle size={16} />
            {pendingConsequence.message} Click {STUDY_TYPE_LABELS[pendingStudyType]} again to switch, or{" "}
            <button className="text-button" type="button" onClick={() => setPendingStudyType(null)}>keep the current setup</button>.
          </p>
        )}
      </div>
      <label className="field">
        <span>Fidelity</span>
        <select value={fidelity} onChange={(event) => updateSolverChoice({ fidelity: event.currentTarget.value as SimulationFidelity })}>
          {SIMULATION_FIDELITIES.map((option) => <option key={option} value={option}>{capitalize(option)}</option>)}
        </select>
      </label>
      {dynamic && (
        <>
          <SectionTitle>Dynamic settings</SectionTitle>
          <DynamicNumberField label="Start time" helpId="dynamicStartTime" unit="s" value={dynamic.startTime} min={0} step={dynamic.timeStep} onCommit={(value) => updateDynamicNumber("startTime", value)} onValidityChange={trackSettingValidity} />
          <DynamicNumberField label="End time" helpId="dynamicEndTime" unit="s" value={dynamic.endTime} min={dynamic.startTime + dynamic.timeStep} step={dynamic.timeStep} onCommit={(value) => updateDynamicNumber("endTime", value)} onValidityChange={trackSettingValidity} />
          <DynamicNumberField label="Time step" helpId="dynamicTimeStep" unit="s" value={dynamic.timeStep} min={0.0001} step="0.0005" onCommit={(value) => updateDynamicNumber("timeStep", value)} onValidityChange={trackSettingValidity} />
          <DynamicNumberField label="Output interval" helpId="dynamicOutputInterval" unit="s" value={outputIntervalValue} min={outputIntervalMinimum} step={outputIntervalMinimum} onCommit={(value) => updateDynamicNumber("outputInterval", value)} onValidityChange={trackSettingValidity} />
          <label className="field">
            <HelpLabel helpId="dynamicLoadProfile">Load profile</HelpLabel>
            <select value={loadProfile} onChange={(event) => updateDynamicLoadProfile(event.currentTarget.value)}>
              {DYNAMIC_LOAD_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <p className="panel-copy">{loadProfileHelper}</p>
          <DynamicNumberField label="Damping ratio" helpId="dynamicDampingRatio" unit="ζ" value={dynamic.dampingRatio} min={0} step="0.01" onCommit={(value) => updateDynamicNumber("dampingRatio", value)} onValidityChange={trackSettingValidity} />
          <div className="summary-box">
            <Info label="Estimated frames" value={frameEstimate ? frameEstimate.count.toLocaleString() : "--"} />
            <Info label="Output cadence" value={`Every ${formatSeconds(normalizedDynamicOutputInterval(dynamic))}`} />
          </div>
          {hasInvalidSettingDraft && <p className="field-error" role="alert">Estimated frames use the last saved settings until every field holds a valid value.</p>}
          {frameEstimate && frameEstimate.count > 1000 && <p className="panel-copy">Large frame counts may slow result loading and playback.</p>}
          {frameEstimate?.hasFinalPartialStep && <p className="panel-copy">Final frame is clamped to the selected end time.</p>}
        </>
      )}
      {modal && (
        <>
          <SectionTitle helpId="modalSettings">Modal settings</SectionTitle>
          <label className="field">
            <span>Requested modes</span>
            <select
              value={modal.modeCount}
              onChange={(event) => onUpdateSolverSettings?.({ modeCount: Number(event.currentTarget.value) })}
            >
              {Array.from({ length: 10 }, (_, index) => index + 1).map((modeCount) => <option key={modeCount} value={modeCount}>{modeCount}</option>)}
            </select>
          </label>
          <p className="panel-copy">Mode shapes are normalized for visualization. Applied loads are not used in modal analysis.</p>
        </>
      )}
      <button
        className="primary wide"
        type="button"
        onClick={isRunning ? onCancelSimulation : onRunSimulation}
        disabled={isRunning ? !onCancelSimulation : (!canRunSimulation || hasInvalidSettingDraft)}
        title={isRunning ? "Stop simulation" : hasInvalidSettingDraft ? "Correct the highlighted simulation settings" : (missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}` : "Run simulation")}
        aria-label={isRunning ? "Stop simulation" : "Run simulation"}
      >
        {isRunning ? <X size={16} /> : <Play size={16} />}
        {isRunning ? "Stop simulation" : "Run simulation"}
      </button>
      {/* Same phrasing as the top-bar tooltip and status message; no lowercasing, which
          turned "STEP" into "step". */}
      {missingRunItems.length > 0 && <p className="panel-copy">Complete before running: {missingRunItems.join(", ")}.</p>}
      {runError && !isRunning && <p className="panel-warning" role="alert">{runError}</p>}
      {isRunning && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} aria-label="Simulation progress">
          <span style={{ width: `${progressPercent}%` }} />
          <strong className="progress-label">{progressPercent}%</strong>
        </div>
      )}
      {isRunning && (
        <div className="summary-box">
          <Info label="Time remaining" value={remainingLabel} />
          <Info label="Elapsed" value={elapsedLabel} />
        </div>
      )}
      <SectionTitle helpId="solver">Solver</SectionTitle>
      <div className="summary-box">
        <Info label="Backend" value={solverBackendLabelForRunPanel(study, displayModel)} />
        <Info label="Version" value="0.1.0" />
        <Info label="Solver method" value={defaultSolverMethodForStudy(study)} />
        <Info label="Runner" value={solverRunnerLabelForStudy(study, displayModel)} />
        {typeof solveElapsedMs === "number" && !isRunning && <Info label="Solved in" value={formatSimulationElapsed(solveElapsedMs)} />}
      </div>
    </Panel>
  );
}

function DynamicNumberField({
  label,
  helpId,
  unit,
  value,
  min,
  step,
  onCommit,
  onValidityChange
}: {
  label: string;
  helpId: SettingHelpId;
  unit: string;
  value: number;
  min: number;
  step: number | string;
  onCommit: (value: number) => void;
  onValidityChange?: (field: SettingHelpId, invalid: boolean) => void;
}) {
  const formattedValue = formatEditableNumberValue(value);
  const [draftValue, setDraftValue] = useState(formattedValue);
  const [editing, setEditing] = useState(false);
  // A draft that will not commit stays on screen while the solver keeps using
  // the last committed value. Reporting the disagreement is the whole point:
  // silently returning from commitDraft left "-1" in the field with Estimated
  // frames still computed from the previous end time, and Run still enabled.
  const invalid = editing && editableNumberCommitValue(draftValue, min) === null;
  const errorId = `${helpId}-error`;

  useEffect(() => {
    if (!editing) setDraftValue(formattedValue);
  }, [editing, formattedValue]);

  useEffect(() => {
    onValidityChange?.(helpId, invalid);
    // Leaving the field with an uncommitted draft must not leave the Run
    // button disabled by a control that is no longer on screen.
    return () => onValidityChange?.(helpId, false);
  }, [helpId, invalid, onValidityChange]);

  function commitDraft(rawValue: string) {
    const parsed = editableNumberCommitValue(rawValue, min);
    if (parsed === null) return;
    onCommit(parsed);
  }

  return (
    <label className="field">
      <HelpLabel helpId={helpId}>{label}</HelpLabel>
      <span className="input-with-unit">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={editing ? draftValue : formattedValue}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          onFocus={() => {
            setEditing(true);
            setDraftValue(formattedValue);
          }}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            setDraftValue(nextValue);
            commitDraft(nextValue);
          }}
          onBlur={(event) => {
            setEditing(false);
            const parsed = editableNumberCommitValue(event.currentTarget.value, min);
            setDraftValue(formatEditableNumberValue(parsed ?? value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span>{unit}</span>
      </span>
      {invalid && (
        <span className="field-error" id={errorId} role="alert">
          {dynamicSettingConstraintMessage(min, unit)} Settings below still use {formatEditableNumberValue(value)} {unit}.
        </span>
      )}
    </label>
  );
}

export function dynamicSettingConstraintMessage(min: number, unit: string): string {
  return `Enter a number of at least ${formatEditableNumberValue(min)} ${unit}.`;
}

export function editableNumberCommitValue(rawValue: string, min: number): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min) return null;
  return parsed;
}

function formatEditableNumberValue(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function solverFidelityForStudy(study: Study): SimulationFidelity {
  const fidelity = (study.solverSettings as { fidelity?: unknown }).fidelity;
  return fidelity === "detailed" || fidelity === "ultra" ? fidelity : "standard";
}

// Solver info rows show the backend the run will actually use. Every run
// executes locally in the browser since the cloud retirement (B5), so the
// label is constant and there is nothing to pick.
function solverBackendLabelForRunPanel(study: Study, displayModel: DisplayModel): string {
  void study;
  void displayModel;
  return "Local (in-browser)";
}

function solverRunnerLabelForStudy(study: Study, displayModel: DisplayModel): string {
  void study;
  void displayModel;
  return "local core worker";
}

export function formatSimulationEta(remainingMs: number | undefined, isRunning = true): string {
  if (!isRunning) return "Complete";
  if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs)) return "Estimating...";
  if (remainingMs <= 1500) return "Almost done";
  return `About ${formatDurationSeconds(remainingMs)} remaining`;
}

function formatSimulationElapsed(elapsedMs: number | undefined): string {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return "--";
  return formatDurationSeconds(elapsedMs);
}

function formatDurationSeconds(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

/**
 * Convergence probe inputs are seeded from face centroids, which carry float
 * dust (-4.549e-12). A narrow number input clips that to "-4.5494", which reads
 * as a real coordinate; seed at display precision instead.
 */
/** Two stored load directions count as the same when their unit vectors agree within ~2.5°. */

