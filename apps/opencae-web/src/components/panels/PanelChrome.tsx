/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Anchor, ChevronDown, CircleHelp, X } from "lucide-react";
import { finiteExtrema } from "@opencae/core";

import type { DisplayModel, DynamicSolverSettings, LoadCase, Material, MeshQuality, ResultField, StructuralResultSummary, Study } from "@opencae/schema";

import type { WorkspaceNotice } from "../../workspaceNotice";

import type { StepId } from "../StepBar";
import { type LoadDirectionLabel, type LoadType } from "../../loadPreview";

import { type ResolvedResultProbe } from "../../resultSelection";

import { dimensionValuesForDisplayModel } from "../../modelDimensions";

import { SETTING_HELP, type SettingHelpId, type SettingHelpVisual } from "../../settingHelp";

import { getViewportTooltipPosition } from "../../tooltipPosition";
import { displayUnitText, forceForUnits, formatDisplayNumber, type UnitSystem } from "../../unitDisplay";
import { canNavigateToStep } from "../../appShellState";

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Where floating layers portal to. The theme class lives on `.app-shell`, not
 * on <body>, so a layer portalled to <body> always rendered with the dark
 * tokens — the export menu and every help tooltip stayed dark in light mode.
 * `.app-shell` has no transform or containment, so `position: fixed` inside it
 * still resolves against the viewport.
 */
export function themedPortalRoot(anchor: Element | null): Element {
  return anchor?.closest(".app-shell") ?? document.body;
}

import { DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS } from "./RightPanelProps";
export function WorkspaceNoticeBanner({ notice, activeStep, onDismiss, onGoToStep }: { notice: WorkspaceNotice; activeStep: StepId; onDismiss?: () => void; onGoToStep?: (step: StepId) => void }) {
  const showStepLink = Boolean(notice.step && notice.step !== activeStep && onGoToStep);
  return (
    <div className={`workspace-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="workspace-notice-body">
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
        {showStepLink && (
          <button type="button" className="text-button" onClick={() => notice.step && onGoToStep?.(notice.step)}>
            Go to {notice.stepLabel ?? notice.step}
          </button>
        )}
      </div>
      {onDismiss && <button type="button" className="remove-glyph" aria-label="Dismiss notice" onClick={onDismiss}><X size={16} /></button>}
    </div>
  );
}

export function EmptyEditableList({ title }: { title: string }) {
  return (
    <div className="editable-list">
      <h3>{title}</h3>
      <p className="muted">None yet</p>
    </div>
  );
}

export function selectionForFace(study: Study, faceId: string) {
  return study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === faceId));
}

export function selectionLabelForPanel(study: Study, selectionRef: string): string {
  return study.namedSelections.find((selection) => selection.id === selectionRef)?.name ?? selectionRef;
}

export function Panel({ title, step, helper, study, children }: { title: string; step: StepId; helper: string; study: Study; children: ReactNode }) {
  const workflowSteps = workflowStepsForStudy(study);
  const stepNumber = workflowSteps.findIndex((workflowStep) => workflowStep.id === step) + 1;
  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{title}</h2>
          <div className="panel-eyebrow">Step {stepNumber} of {workflowSteps.length}</div>
        </div>
        <p className="helper">{helper}</p>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function meshPresetDescription(preset: MeshQuality) {
  if (preset === "coarse") return "a fast preview mesh for early setup checks";
  if (preset === "medium") return "a good balance between accuracy and speed";
  if (preset === "fine") return "a denser mesh for more detailed result gradients";
  return "an ultra-dense mesh for the finest contour gradients";
}

export function seedProbeCoordinate(value: number): string {
  if (!Number.isFinite(value)) return "";
  const rounded = Number(value.toPrecision(4));
  return String(Math.abs(rounded) < 1e-9 ? 0 : rounded);
}

export function formatProbeReading(probe: ResolvedResultProbe): string {
  const value = Number.isFinite(probe.value) ? formatDisplayNumber(probe.value) : "Unavailable";
  return `${value}${probe.units ? ` ${probe.units}` : ""}`;
}

export function sameLoadDirection(stored: unknown, draft: readonly number[]): boolean {
  if (!Array.isArray(stored) || stored.length !== 3 || !stored.every((value) => Number.isFinite(value))) return false;
  const norm = (vector: readonly number[]) => Math.hypot(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0) || 1;
  const dot = ((stored[0] as number) * (draft[0] ?? 0) + (stored[1] as number) * (draft[1] ?? 0) + (stored[2] as number) * (draft[2] ?? 0)) / (norm(stored as number[]) * norm(draft));
  return dot > 0.999;
}

export function structuralLoadCasesForPanel(study: Extract<Study, { type: "static_stress" | "dynamic_structural" }>): LoadCase[] {
  return study.loadCases?.length
    ? study.loadCases
    : [{ id: "case-default", name: "Default", enabled: true, loadIds: study.loads.map((load) => load.id) }];
}

export const WORKFLOW_STEPS: Array<{ id: StepId; label: string }> = [
  { id: "model", label: "Model" },
  { id: "material", label: "Material" },
  { id: "supports", label: "Supports" },
  { id: "loads", label: "Loads" },
  { id: "mesh", label: "Mesh" },
  { id: "run", label: "Run" },
  { id: "results", label: "Results" }
];

export function workflowStepsForStudy(study: Study) {
  return study.type === "modal_analysis" ? WORKFLOW_STEPS.filter((step) => step.id !== "loads") : WORKFLOW_STEPS;
}

export function WorkflowNav({ activeStep, study, onStepSelect }: { activeStep: StepId; study: Study; onStepSelect: (step: StepId) => void }) {
  const workflowSteps = workflowStepsForStudy(study);
  const index = workflowSteps.findIndex((step) => step.id === activeStep);
  const previousStep = index > 0 ? workflowSteps[index - 1] : undefined;
  const nextStep = index >= 0 && index < workflowSteps.length - 1 ? workflowSteps[index + 1] : undefined;
  const canGoNext = Boolean(nextStep && canNavigateToStep(nextStep.id, { meshStatus: study.meshSettings.status }));
  const backLabel = previousStep ? `Back: ${previousStep.label}` : "Back";
  const nextLabel = nextStep ? `Next: ${nextStep.label}` : "Next";
  const backAriaLabel = previousStep ? `Previous workflow step: ${previousStep.label}. Shortcut B` : "Previous workflow step. Shortcut B";
  const nextAriaLabel = nextStep ? `Next workflow step: ${nextStep.label}. Shortcut N` : "Next workflow step. Shortcut N";

  return (
    <div className="workflow-nav" aria-label="Workflow navigation">
      <button className="secondary" type="button" title="Previous workflow step (B)" aria-label={backAriaLabel} disabled={!previousStep} onClick={() => previousStep && onStepSelect(previousStep.id)}>
        <span className="workflow-nav-label">{backLabel}</span>
        <kbd>B</kbd>
      </button>
      <button className="primary" type="button" title="Next workflow step (N)" aria-label={nextAriaLabel} disabled={!canGoNext} onClick={() => nextStep && canGoNext && onStepSelect(nextStep.id)}>
        <span className="workflow-nav-label">{nextLabel}</span>
        <kbd>N</kbd>
      </button>
    </div>
  );
}

export function HelpLabel({ children, helpId }: { children: ReactNode; helpId: SettingHelpId }) {
  return (
    <span className="field-label-with-help">
      {children}
      <SettingHelpTrigger helpId={helpId} />
    </span>
  );
}

export const TOOLTIP_CLOSE_DELAY_MS = 140;

export function SettingHelpTrigger({ helpId }: { helpId: SettingHelpId }) {
  const tooltipId = useId();
  const help = SETTING_HELP[helpId];
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties | undefined>();
  const closeTimerRef = useRef(0);

  /* WCAG 1.4.13 Hoverable: the panel portals ~8px from the trigger, so moving the pointer
     toward it left the trigger and closed the tooltip before it could be reached — and
     .field-tooltip's `pointer-events: none` meant it could not be hovered anyway. The
     grace period spans the gap; the portaled node cancels it on enter. */
  const cancelClose = () => window.clearTimeout(closeTimerRef.current);
  const closeSoon = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setIsTooltipOpen(false), TOOLTIP_CLOSE_DELAY_MS);
  };

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  useEffect(() => {
    if (!isTooltipOpen || typeof window === "undefined") return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      cancelClose();
      setIsTooltipOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isTooltipOpen]);

  const updateTooltipPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const position = getViewportTooltipPosition({
      triggerRect: trigger.getBoundingClientRect(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tooltip: { width: tooltipRect?.width || 340, height: tooltipRect?.height || 142 }
    });
    setTooltipStyle({ top: position.top, left: position.left });
  };

  useIsomorphicLayoutEffect(() => {
    if (!isTooltipOpen) return;
    updateTooltipPosition();
  }, [isTooltipOpen, helpId]);

  useEffect(() => {
    if (!isTooltipOpen || typeof window === "undefined") return;
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [isTooltipOpen]);

  return (
    <span
      ref={triggerRef}
      className="tooltip-trigger"
      tabIndex={0}
      role="button"
      aria-label={`${help.title} help`}
      aria-describedby={isTooltipOpen ? tooltipId : undefined}
      onMouseEnter={() => { cancelClose(); setIsTooltipOpen(true); }}
      onMouseLeave={closeSoon}
      onFocus={() => { cancelClose(); setIsTooltipOpen(true); }}
      onBlur={() => { cancelClose(); setIsTooltipOpen(false); }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsTooltipOpen((current) => !current);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <CircleHelp size={15} aria-hidden="true" />
      {isTooltipOpen &&
        createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            className="field-tooltip field-tooltip--floating"
            role="tooltip"
            style={tooltipStyle}
            onMouseEnter={cancelClose}
            onMouseLeave={closeSoon}
          >
            <HelpVisual kind={help.visual} />
            <strong>{help.title}</strong>
            <span>{help.body}</span>
          </span>,
          themedPortalRoot(triggerRef.current)
        )}
    </span>
  );
}

export function HelpVisual({ kind }: { kind: SettingHelpVisual }) {
  return (
    <span className={`help-visual ${kind}`} aria-hidden="true">
      <span className="help-part" />
      <span className="help-force" />
      <span className="help-grid" />
    </span>
  );
}

export function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong>{displayUnitText(value)}</strong></div>;
}

/** Splits "0.001433 mm" into its number and a trailing unit, so the unit can be set smaller. */
export function splitHeadlineValue(value: string): { number: string; unit: string | null } {
  const match = /^(.*\d\S*)\s+([^\d\s]\S*)$/.exec(value);
  return match ? { number: match[1]!, unit: match[2]! } : { number: value, unit: null };
}

/* The one display level in the app. --fs-xl was defined in tokens.css and used nowhere,
   so the largest type in the workspace was 16px and the number a user ran the solve for
   rendered at the same size and weight as the solver-runner string. Every result panel
   states its headline figures through this, so the answer reads as the answer. */
export function Headline({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="result-headline">
      {items.map((item) => {
        // At 22px mono the unit made "0.001433 mm" wrap in a half-width column.
        const { number, unit } = splitHeadlineValue(displayUnitText(item.value));
        return (
          <div className="result-headline-item" key={item.label}>
            <span>{item.label}</span>
            <strong aria-label={displayUnitText(item.value)}>{number}{unit && <small className="result-headline-unit">{unit}</small>}</strong>
          </div>
        );
      })}
    </div>
  );
}

export function ModelDimensions({ displayModel }: { displayModel: DisplayModel }) {
  const dimensions = dimensionValuesForDisplayModel(displayModel);
  if (!dimensions) {
    return (
      <div className="summary-box dimension-box">
        <Info label="Dimensions" value="Unavailable" />
        <p>Real model extents are not available for this imported preview.</p>
      </div>
    );
  }

  return (
    <div className="summary-box dimension-box">
      <Info label="Overall" value={`${formatDimension(dimensions.x)} x ${formatDimension(dimensions.y)} x ${formatDimension(dimensions.z)} ${dimensions.units}`} />
      <Info label="X length" value={`${formatDimension(dimensions.x)} ${dimensions.units}`} />
      <Info label="Y depth" value={`${formatDimension(dimensions.y)} ${dimensions.units}`} />
      <Info label="Z height" value={`${formatDimension(dimensions.z)} ${dimensions.units}`} />
    </div>
  );
}

export function SectionTitle({ children, helpId }: { children: ReactNode; helpId?: SettingHelpId }) {
  return <h3 className="section-title">{helpId ? <HelpLabel helpId={helpId}>{children}</HelpLabel> : children}</h3>;
}

export function Callout({ children }: { children: ReactNode }) {
  return <p className="callout">{children}</p>;
}

export function Collapsible({ title, subtitle, helpId, defaultOpen = false, children }: { title: string; subtitle?: string; helpId?: SettingHelpId; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="collapsible-section" open={defaultOpen}>
      <summary className="collapsible-summary">
        {/* The help trigger stops click propagation, so opening the tooltip does not toggle the section. */}
        <span className="collapsible-title">{helpId ? <HelpLabel helpId={helpId}>{title}</HelpLabel> : title}</span>
        {subtitle && <span className="collapsible-subtitle">{subtitle}</span>}
        <ChevronDown className="collapsible-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

export function ConceptCard({ icon, title, detail, tone = "accent" }: { icon: ReactNode; title: string; detail: string; tone?: "accent" | "warning" }) {
  return (
    <div className="concept-card">
      <span className={`concept-icon ${tone}`}>{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}

export function PlacementReadout({ selectedRef, fallbackLabel, detail, helpId }: { selectedRef: ReturnType<typeof selectionForFace> | undefined; fallbackLabel?: string; detail?: string; helpId?: SettingHelpId }) {
  const label = selectedRef?.geometryRefs[0]?.label ?? fallbackLabel;
  const chip = (
    <div className={label ? "placement-chip ready" : "placement-chip"}>
      {label ? `Selected ${label}${detail ? ` · ${detail}` : ""}` : "Select a face in the model viewport"}
    </div>
  );
  if (!helpId) return chip;
  // The placement help used to render as a lone (?) on its own row above the chip.
  return (
    <div className="field placement-field">
      <HelpLabel helpId={helpId}>Placement</HelpLabel>
      {chip}
    </div>
  );
}

export function materialForId(materialId: string, materials: readonly Material[]): Material | undefined {
  return materials.find((material) => material.id === materialId);
}

export function SupportIcon() {
  return <Anchor size={18} strokeWidth={1.8} aria-hidden="true" />;
}

export function formatDimension(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatLoadCapacity(value: number) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 });
}

export function formatEquivalentForce(valueNewtons: number, unitSystem: UnitSystem) {
  const converted = forceForUnits(valueNewtons, "N", unitSystem);
  return `${formatNumber(converted.value)} ${converted.units}`;
}

export function interpolatedFrameTimeSeconds(frames: Array<{ frameIndex: number; timeSeconds: number }>, framePosition: number): number {
  if (!frames.length) return 0;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (framePosition <= first.frameIndex) return first.timeSeconds;
  if (framePosition >= last.frameIndex) return last.timeSeconds;
  const lower = [...frames].reverse().find((frame) => frame.frameIndex <= framePosition) ?? first;
  const upper = frames.find((frame) => frame.frameIndex >= framePosition) ?? last;
  if (lower.frameIndex === upper.frameIndex) return lower.timeSeconds;
  const blend = (framePosition - lower.frameIndex) / (upper.frameIndex - lower.frameIndex);
  return lower.timeSeconds + (upper.timeSeconds - lower.timeSeconds) * Math.max(0, Math.min(1, blend));
}

export function peakDisplacementFrame(fields: ResultField[], summary: StructuralResultSummary): { value: number; units: string; timeSeconds: number } | null {
  const displacementFields = fields.filter((field) => field.type === "displacement");
  if (!displacementFields.length) {
    if (!summary.transient || !Number.isFinite(summary.maxDisplacement)) return null;
    return {
      value: summary.maxDisplacement,
      units: summary.maxDisplacementUnits,
      timeSeconds: summary.transient.peakDisplacementTimeSeconds
    };
  }
  const peak = displacementFields
    .map((field) => ({ field, value: activeFieldAbsMax(field) }))
    .reduce((best, item) => item.value > best.value ? item : best, { field: displacementFields[0]!, value: activeFieldAbsMax(displacementFields[0]!) });
  return { value: peak.value, units: peak.field.units, timeSeconds: peak.field.timeSeconds ?? summary.transient?.peakDisplacementTimeSeconds ?? 0 };
}

export function activeFieldAbsMax(field: ResultField): number {
  const valueExtent = finiteExtrema(field.values, (value) => Math.abs(value));
  const sampleExtent = finiteExtrema(field.samples ?? [], (sample) => Math.abs(sample.value));
  const maximum = Math.max(valueExtent?.max ?? 0, sampleExtent?.max ?? 0);
  if (valueExtent || sampleExtent) return maximum;
  return Math.max(Math.abs(Number(field.min) || 0), Math.abs(Number(field.max) || 0));
}

export function dynamicFrameEstimate(settings: DynamicSolverSettings): { count: number; hasFinalPartialStep: boolean } {
  const duration = Math.max(0, settings.endTime - settings.startTime);
  const outputInterval = normalizedDynamicOutputInterval(settings);
  const wholeSteps = Math.floor(duration / outputInterval);
  const remainder = duration - wholeSteps * outputInterval;
  const hasFinalPartialStep = remainder > outputInterval * 1e-9;
  return {
    count: Math.max(1, wholeSteps + 1 + (hasFinalPartialStep ? 1 : 0)),
    hasFinalPartialStep
  };
}

export function normalizedDynamicOutputInterval(settings: DynamicSolverSettings) {
  const requestedOutputInterval = Number.isFinite(settings.outputInterval) ? settings.outputInterval : DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
  const backendMinimum = Math.max(DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  return Math.max(requestedOutputInterval, settings.timeStep, backendMinimum);
}

export function isDynamicLoadProfile(value: unknown): value is DynamicSolverSettings["loadProfile"] {
  return value === "ramp" || value === "step" || value === "quasi_static" || value === "sinusoidal";
}

export function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 1 });
}

export function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} s`;
}

export function formatInputValue(value: number) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toFixed(3)).toString();
}

export function loadTypeLabel(type: LoadType) {
  if (type === "heat_flux") return "Surface heat flux";
  if (type === "heat_generation") return "Volumetric heat generation";
  if (type === "gravity") return "Payload mass";
  if (type === "force") return "Face force (total)";
  if (type === "surface_traction") return "Surface traction";
  if (type === "volume_force") return "Volume force";
  if (type === "remote_force") return "Remote force";
  if (type === "bolt_preload") return "Equivalent bolt preload";
  return capitalize(type);
}

export function defaultValueForLoadType(type: LoadType) {
  if (type === "heat_flux") return 10_000;
  if (type === "heat_generation") return 1_000_000;
  if (type === "pressure" || type === "surface_traction") return 100;
  if (type === "volume_force") return 1000;
  if (type === "gravity") return 5;
  return 500;
}

export function directionOptionLabel(direction: LoadDirectionLabel) {
  if (direction === "Normal") return "Face normal";
  if (direction === "Opposite normal") return "Opposite face normal";
  return `Global ${direction}`;
}

export function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
