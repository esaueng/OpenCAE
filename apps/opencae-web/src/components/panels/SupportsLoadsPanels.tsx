/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Gauge, Plus, ScanLine, Weight, X } from "lucide-react";

import { massKgForPayloadMaterial, payloadMaterialForId, payloadMaterials, type PayloadMaterialCategory } from "@opencae/materials";

import type { Constraint, DisplayFace, DisplayModel, Load, LoadCase, LoadCombination, Study } from "@opencae/schema";

import { applicationPointForLoad, createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, equivalentForceForLoad, LOAD_DIRECTION_LABELS, loadMagnitudeError, loadMarkerOrdinalLabel, payloadObjectForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata, type PayloadMassMode } from "../../loadPreview";
import { type PayloadObjectSelection } from "../../workspaceViewTypes";

import { supportDisplayLabel } from "../../supportLabels";

import { formatDensity, formatMass, formatVolume, loadValueForUnits, type UnitSystem } from "../../unitDisplay";

import type { RightPanelProps } from "./RightPanelProps";
import { noopDraftPayloadPreviewChange } from "./RightPanelProps";
import { Panel, sameLoadDirection, structuralLoadCasesForPanel } from "./PanelChrome";
import { Callout, Collapsible, EmptyEditableList, HelpLabel, Info, PlacementReadout, SectionTitle, SupportIcon, defaultValueForLoadType, directionOptionLabel, formatEquivalentForce, formatInputValue, formatNumber, loadTypeLabel, selectionForFace } from "./PanelChrome";
export function SupportsPanel({ selectedFace, study, draftSupportTemperature, onDraftSupportTemperatureChange, onAddSupport, onUpdateSupport, onRemoveSupport }: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const thermal = study.type === "steady_state_thermal";
  const modal = study.type === "modal_analysis";
  // Multi-face BCs (Decision 2): the viewer pick seeds the first face;
  // additional faces toggle on from the selection list below.
  const [extraSelectionRefs, setExtraSelectionRefs] = useState<string[]>([]);
  // The draft temperature lives in the workspace so a viewer pick uses the
  // typed value too (2026-09 review D12); fall back to local state for callers
  // that do not supply it.
  const [localTemperature, setLocalTemperature] = useState(20);
  const temperature = draftSupportTemperature ?? localTemperature;
  const setTemperature = onDraftSupportTemperatureChange ?? setLocalTemperature;
  // Prescribed displacement: imposed motion in display mm along one axis.
  // Zero behaves as a fixed component; the solver treats it as a Dirichlet value.
  const [displacementKind, setDisplacementKind] = useState<"fixed" | "prescribed_displacement">("fixed");
  const [displacementValueMm, setDisplacementValueMm] = useState(0);
  const [displacementComponent, setDisplacementComponent] = useState<"x" | "y" | "z">("z");
  const prescribedDisplacement = displacementKind === "prescribed_displacement" && !thermal && !modal;
  const displacementValid = Number.isFinite(displacementValueMm);
  const addLabel = thermal ? "Add prescribed temperature" : prescribedDisplacement ? "Add prescribed displacement" : study.constraints.length ? "Add another fixed support" : "Add fixed support";
  // The panel button used to stack a second support on a face that already
  // had one; the viewer-click path already refused that (2026-09 review D2).
  const existingOnSelection = selectedFromViewport ? study.constraints.find((support) => support.selectionRef === selectedFromViewport.id) : undefined;
  const duplicateSupportError = existingOnSelection
    ? `${thermal ? "A temperature boundary" : "A support"} already exists on ${selectedFromViewport?.name ?? "this face"}. Edit or remove it below.`
    : null;
  const faceOptions = study.namedSelections.filter((selection) => selection.entityType === "face");
  const appliedRefs = [selectedFromViewport?.id, ...extraSelectionRefs].filter((ref): ref is string => Boolean(ref));
  const toggleExtraRef = (ref: string) => setExtraSelectionRefs((current) =>
    current.includes(ref) ? current.filter((candidate) => candidate !== ref) : [...current, ref]
  );
  return (
    <Panel title={thermal ? "Temperature boundaries" : "Supports"} step="supports" helper={thermal ? "Select a face and prescribe its steady boundary temperature." : "Choose where the part is held fixed. Select a face, or click inside a cylindrical hole to constrain its wall. You can add more than one support."} study={study}>
      <PlacementReadout selectedRef={selectedFromViewport} fallbackLabel={selectedFace?.label} helpId="supportPlacement" />
      {thermal && <label className="field">Temperature<span className="input-with-unit"><input type="number" value={temperature} onChange={(event) => setTemperature(Number(event.currentTarget.value))} /><span>°C</span></span></label>}
      {!thermal && !modal && (
        <label className="field">Support type
          <select value={displacementKind} onChange={(event) => setDisplacementKind(event.currentTarget.value as "fixed" | "prescribed_displacement")}>
            <option value="fixed">Fixed support</option>
            <option value="prescribed_displacement">Prescribed displacement</option>
          </select>
        </label>
      )}
      {prescribedDisplacement && (
        <>
          <label className="field">Displacement<span className="input-with-unit"><input type="number" value={displacementValueMm} onChange={(event) => setDisplacementValueMm(Number(event.currentTarget.value))} /><span>mm</span></span></label>
          <label className="field">Component
            <select value={displacementComponent} onChange={(event) => setDisplacementComponent(event.currentTarget.value as "x" | "y" | "z")}>
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
          </label>
        </>
      )}
      {duplicateSupportError && <p className="field-error" role="alert">{duplicateSupportError}</p>}
      {!thermal && !modal && faceOptions.length > 1 && (
        <AdditionalFacesPicker
          options={faceOptions.filter((selection) => selection.id !== selectedFromViewport?.id)}
          selectedRefs={extraSelectionRefs}
          onToggle={toggleExtraRef}
        />
      )}
      <button className="outline-action wide" disabled={!selectedFromViewport || Boolean(duplicateSupportError) || (thermal && !Number.isFinite(temperature)) || (prescribedDisplacement && !displacementValid)} title={duplicateSupportError ?? undefined} onClick={() => selectedFromViewport && !duplicateSupportError && onAddSupport(selectedFromViewport.id, thermal ? { type: "prescribed_temperature", value: temperature } : prescribedDisplacement ? { type: "prescribed_displacement", value: displacementValueMm, component: displacementComponent } : { type: "fixed" }, extraSelectionRefs.length ? { selectionRefs: extraSelectionRefs } : undefined)}><Plus size={18} />{addLabel}{appliedRefs.length > 1 ? ` (${appliedRefs.length} faces)` : ""}</button>
      <SupportEditorList study={study} retargetFace={selectedFace} onUpdateSupport={onUpdateSupport} onRemoveSupport={onRemoveSupport} />
      <Callout>{thermal ? "At least one prescribed temperature is required to make the conduction system unique." : "Fixed supports prevent any motion of the selected face."}</Callout>
    </Panel>
  );
}

/**
 * Extra faces for a multi-face support or load. A bounded, scrolling list so a
 * model with many faces cannot push the Add button off the panel.
 */
function AdditionalFacesPicker({ options, selectedRefs, onToggle }: { options: ReadonlyArray<{ id: string; name: string }>; selectedRefs: readonly string[]; onToggle: (ref: string) => void }) {
  const selectedCount = options.filter((option) => selectedRefs.includes(option.id)).length;
  return (
    <fieldset className="field face-picker">
      <legend>
        Additional faces
        <span className="face-picker-meta">{selectedCount ? `${selectedCount} selected` : "Optional"}</span>
      </legend>
      <div className="face-picker-list">
        {options.map((selection) => (
          <label className="face-picker-row" key={selection.id}>
            <input type="checkbox" checked={selectedRefs.includes(selection.id)} onChange={() => onToggle(selection.id)} />
            <span>{selection.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function LoadsPanel({
  project,
  displayModel,
  selectedFace,
  study,
  draftLoadType,
  draftLoadValue,
  draftLoadDirection,
  selectedLoadPoint,
  selectedPayloadObject,
  onDraftLoadTypeChange,
  onDraftLoadValueChange,
  onDraftLoadDirectionChange,
  onDraftPayloadPreviewChange = noopDraftPayloadPreviewChange,
  onAddLoad,
  onUpdateLoad,
  onPreviewLoadEdit,
  onRemoveLoad,
  onLoadCasesChange
}: RightPanelProps) {
  const [editingLoadId, setEditingLoadId] = useState<string | null>(null);
  const thermal = study.type === "steady_state_thermal";
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const bodySelection = study.namedSelections.find((selection) => selection.entityType === "body");
  const placementSelection = draftLoadType === "gravity" ? undefined : draftLoadType === "volume_force" || draftLoadType === "heat_generation" ? bodySelection : selectedFromViewport;
  const units = unitsForLoadType(draftLoadType);
  const valueLabel = draftLoadType === "gravity" ? "Payload mass" : draftLoadType === "heat_flux" ? "Inward heat flux" : draftLoadType === "heat_generation" ? "Volumetric heat generation" : "Magnitude";
  const addLabel = draftLoadType === "gravity" ? "Add payload mass" : thermal ? "Add thermal load" : "Add load";
  const [payloadMaterialId, setPayloadMaterialId] = useState("payload-steel");
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>("material");
  const [remotePoint, setRemotePoint] = useState<LoadApplicationPoint>(() => selectedLoadPoint ?? selectedFace?.center ?? [0, 0, 0]);
  const secondaryFaceOptions = useMemo(
    () => study.namedSelections.filter((selection) => selection.entityType === "face" && selection.id !== selectedFromViewport?.id),
    [selectedFromViewport?.id, study.namedSelections]
  );
  // Multi-face loads (Decision 2): extra faces share the same magnitude and
  // direction; pressure/traction distribute by area, forces split evenly.
  const [extraLoadRefs, setExtraLoadRefs] = useState<string[]>([]);
  const faceOptionsForLoad = study.namedSelections.filter((selection) => selection.entityType === "face");
  const toggleExtraLoadRef = (ref: string) => setExtraLoadRefs((current) =>
    current.includes(ref) ? current.filter((candidate) => candidate !== ref) : [...current, ref]
  );
  const [secondarySelectionRef, setSecondarySelectionRef] = useState(secondaryFaceOptions[0]?.id ?? "");
  const payloadVolumeM3 = selectedPayloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const effectiveDraftValue = draftLoadType === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : draftLoadValue;
  const displayDraftLoad = loadValueForUnits(effectiveDraftValue, units, project.unitSystem);
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const canAddPayloadMass = payloadMassMode === "manual" ? draftLoadValue > 0 : calculatedPayloadMass > 0;
  const draftMagnitudeError = loadMagnitudeError(effectiveDraftValue, study.type);
  const hasDraftPlacement = draftLoadType === "gravity"
    ? Boolean(selectedPayloadObject) && canAddPayloadMass
    : draftLoadType === "volume_force" || draftLoadType === "heat_generation"
      ? Boolean(bodySelection)
      : draftLoadType === "bolt_preload"
        ? Boolean(selectedFace && secondarySelectionRef)
        : Boolean(selectedFace);
  // A second click on Add stacked an identical load on the same face and
  // silently doubled the applied force (2026-09 review D2). Refuse the exact
  // duplicate and point at the edit form instead.
  const duplicateLoad = placementSelection
    ? study.loads.find((load) => load.selectionRef === placementSelection.id && load.type === draftLoadType
        && (thermal || !selectedFace || sameLoadDirection(load.parameters.direction, directionVectorForLabel(draftLoadDirection, selectedFace, displayModel)))
        && Number(load.parameters.value) === effectiveDraftValue)
    : undefined;
  const duplicateLoadError = duplicateLoad
    ? `A ${loadTypeLabel(draftLoadType).toLowerCase()} of ${formatNumber(displayDraftLoad.value)} ${displayDraftLoad.units} is already applied to ${placementSelection?.name ?? "this face"}. Edit it to change the magnitude.`
    : null;
  const draftAddError = draftMagnitudeError ?? duplicateLoadError;
  const canAddDraftLoad = hasDraftPlacement && !draftAddError;
  const payloadMetadata: PayloadLoadMetadata = draftLoadType === "gravity"
    ? {
      payloadMaterialId,
      ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}),
      payloadMassMode
    }
    : {};
  function handleDraftValueChange(displayValue: number) {
    const baseValue = loadValueForUnits(displayValue, displayDraftLoad.units, "SI");
    onDraftLoadValueChange(baseValue.value);
  }
  useEffect(() => {
    if (thermal && draftLoadType !== "heat_flux" && draftLoadType !== "heat_generation") {
      onDraftLoadTypeChange("heat_flux");
      onDraftLoadValueChange(defaultValueForLoadType("heat_flux"));
    } else if (!thermal && (draftLoadType === "heat_flux" || draftLoadType === "heat_generation")) {
      onDraftLoadTypeChange("force");
      onDraftLoadValueChange(defaultValueForLoadType("force"));
    }
  }, [draftLoadType, onDraftLoadTypeChange, onDraftLoadValueChange, thermal]);
  useEffect(() => {
    onDraftPayloadPreviewChange(
      draftLoadType === "gravity"
        ? { value: effectiveDraftValue, metadata: payloadMetadata }
        : null
    );
  }, [draftLoadType, effectiveDraftValue, onDraftPayloadPreviewChange, payloadMassMode, payloadMaterialId, payloadVolumeM3]);
  useEffect(() => {
    if (draftLoadType === "remote_force" && selectedLoadPoint) setRemotePoint(selectedLoadPoint);
  }, [draftLoadType, selectedLoadPoint]);
  useEffect(() => {
    if (!secondaryFaceOptions.some((selection) => selection.id === secondarySelectionRef)) {
      setSecondarySelectionRef(secondaryFaceOptions[0]?.id ?? "");
    }
  }, [secondaryFaceOptions, secondarySelectionRef]);
  const structuralStudy = study.type === "static_stress" || study.type === "dynamic_structural" ? study : null;
  const loadCases = structuralStudy ? structuralLoadCasesForPanel(structuralStudy) : [];
  const loadCombinations = study.type === "static_stress" ? study.loadCombinations ?? [] : [];
  function assignLoadToCase(loadId: string, caseId: string) {
    if (!onLoadCasesChange) return;
    onLoadCasesChange(loadCases.map((loadCase) => ({
      ...loadCase,
      loadIds: loadCase.id === caseId
        ? [...loadCase.loadIds.filter((id) => id !== loadId), loadId]
        : loadCase.loadIds.filter((id) => id !== loadId)
    })), loadCombinations);
  }
  return (
    <Panel title={thermal ? "Thermal loads" : "Loads"} step="loads" helper={thermal ? (draftLoadType === "heat_generation" ? "Apply uniform heat generation throughout the selected body." : "Select a face and apply inward surface heat flux.") : draftLoadType === "gravity" ? "Choose the object carrying payload mass, then add its weight as a load." : draftLoadType === "volume_force" ? "Apply a force density to the selected structural body." : "Select a face on the model, then add the load."} study={study}>
      <div hidden={editingLoadId !== null}>
      <PlacementReadout
        helpId="loadPlacement"
        selectedRef={placementSelection}
        fallbackLabel={selectedPayloadObject?.label ?? selectedFace?.label}
        detail={selectedPayloadObject ? "object selected" : selectedLoadPoint ? "point picked" : undefined}
      />
      <label className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <select
          value={draftLoadType}
          onChange={(event) => {
            const type = event.currentTarget.value as LoadType;
            onDraftLoadTypeChange(type);
            if (type !== draftLoadType) onDraftLoadValueChange(defaultValueForLoadType(type));
          }}
        >
          {thermal ? <><option value="heat_flux">Surface heat flux</option><option value="heat_generation">Volumetric heat generation</option></> : <>
            <option value="force">Face force (total)</option>
            <option value="pressure">Pressure</option>
            <option value="surface_traction">Surface traction</option>
            <option value="volume_force">Volume force</option>
            <option value="remote_force">Remote force</option>
            {study.type === "static_stress" ? <option value="bolt_preload">Equivalent bolt preload</option> : null}
            <option value="gravity">Payload mass</option>
          </>}
        </select>
      </label>
      {draftLoadType === "gravity" ? (
        <PayloadMassControls
          unitSystem={project.unitSystem}
          payloadObject={selectedPayloadObject}
          payloadMaterialId={payloadMaterialId}
          payloadMassMode={payloadMassMode}
          manualMassKg={draftLoadValue}
          onPayloadMaterialChange={setPayloadMaterialId}
          onPayloadMassModeChange={setPayloadMassMode}
          onManualMassChange={handleDraftValueChange}
        />
      ) : (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">{valueLabel}</HelpLabel>
          <span className="input-with-unit">
            <input
              id="load-value"
              type="number"
              value={formatInputValue(displayDraftLoad.value)}
              onChange={(event) => handleDraftValueChange(Number(event.currentTarget.value))}
            />
            <span>{displayDraftLoad.units}</span>
          </span>
        </label>
      )}
      {draftLoadType === "gravity" && (
        <>
          <Info label="Selected density" value={formatDensity(selectedPayloadMaterial.density, "kg/m^3", project.unitSystem)} />
          <Info label="Calculated mass" value={formatMass(calculatedPayloadMass, "kg", project.unitSystem)} />
          <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: effectiveDraftValue } }), project.unitSystem)} equivalent weight.</Callout>
        </>
      )}
      {draftLoadType === "force" ? <Callout>Face force is a total force distributed over the selected face. Its visual point does not affect the solve.</Callout> : null}
      {draftLoadType === "remote_force" ? (
        <fieldset className="field">
          <legend>Remote point coordinates</legend>
          <div className="vector-inputs">
            {(["X", "Y", "Z"] as const).map((axis, index) => (
              <label key={axis}>{axis}<input type="number" value={remotePoint[index]} onChange={(event) => {
                const next = [...remotePoint] as LoadApplicationPoint;
                next[index] = Number(event.currentTarget.value);
                setRemotePoint(next);
              }} /></label>
            ))}
          </div>
          <small>Distributed force and moment only; this is not a rigid MPC coupling.</small>
        </fieldset>
      ) : null}
      {draftLoadType === "bolt_preload" ? (
        <>
          <label className="field">Opposing face<select value={secondarySelectionRef} onChange={(event) => setSecondarySelectionRef(event.currentTarget.value)}>
            <option value="">Choose a different face</option>
            {secondaryFaceOptions.map((selection) => <option key={selection.id} value={selection.id}>{selection.name}</option>)}
          </select></label>
          <Callout>Bonded-linear approximation only: no contact, slip, or fastener stiffness.</Callout>
        </>
      ) : null}
      {!thermal && <label className="field">
        <HelpLabel helpId="loadDirection">Direction</HelpLabel>
        <select value={draftLoadDirection} onChange={(event) => onDraftLoadDirectionChange(event.currentTarget.value as LoadDirectionLabel)}>
          {LOAD_DIRECTION_LABELS.map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>}
      {hasDraftPlacement && draftAddError && <p className="field-error" role="alert">{draftAddError}</p>}
      {!thermal && draftLoadType !== "gravity" && draftLoadType !== "volume_force" && draftLoadType !== "heat_generation" && draftLoadType !== "bolt_preload" && faceOptionsForLoad.length > 1 && (
        <AdditionalFacesPicker
          options={faceOptionsForLoad.filter((selection) => selection.id !== placementSelection?.id)}
          selectedRefs={extraLoadRefs}
          onToggle={toggleExtraLoadRef}
        />
      )}
      <button className="outline-action wide" disabled={!canAddDraftLoad} title={draftAddError ?? undefined} onClick={() => canAddDraftLoad && onAddLoad(
        draftLoadType,
        effectiveDraftValue,
        placementSelection?.id,
        draftLoadDirection,
        {
          ...payloadMetadata,
          ...(draftLoadType === "remote_force" ? { remotePoint } : {}),
          ...(draftLoadType === "bolt_preload" ? { secondarySelectionRef } : {}),
          ...(extraLoadRefs.length ? { selectionRefs: extraLoadRefs } : {})
        }
      )}>{/* selectionRefs travel in payloadMetadata and are split out by the workspace handler. */}<Plus size={18} />{addLabel}{extraLoadRefs.length ? ` (${extraLoadRefs.length + 1} faces)` : ""}</button>
      </div>
      {structuralStudy && (
        <Collapsible
          title="Load cases"
          subtitle={`${loadCases.length} case${loadCases.length === 1 ? "" : "s"}${loadCombinations.length ? ` · ${loadCombinations.length} combination${loadCombinations.length === 1 ? "" : "s"}` : ""}`}
          helpId="loadCases"
          defaultOpen={loadCases.length > 1 || loadCombinations.length > 0}
        >
          <LoadCasesEditor
            studyType={structuralStudy.type}
            loadCases={loadCases}
            loadCombinations={loadCombinations}
            onChange={(cases, combinations) => onLoadCasesChange?.(cases, combinations)}
          />
        </Collapsible>
      )}
      <LoadEditorList editingId={editingLoadId} onEditingIdChange={setEditingLoadId} study={study} displayModel={displayModel} unitSystem={project.unitSystem} loadCases={loadCases} retargetFace={selectedFace} onAssignLoadToCase={assignLoadToCase} onUpdateLoad={onUpdateLoad} onPreviewLoadEdit={onPreviewLoadEdit} onRemoveLoad={onRemoveLoad} />
    </Panel>
  );
}

const PAYLOAD_CATEGORY_ORDER: PayloadMaterialCategory[] = ["metal", "plastic", "composite", "resin", "ceramic-glass", "semiconductor", "rubber", "wood", "concrete-stone", "liquid", "misc"];

function PayloadMassControls({
  unitSystem,
  payloadObject,
  payloadMaterialId,
  payloadMassMode,
  manualMassKg,
  onPayloadMaterialChange,
  onPayloadMassModeChange,
  onManualMassChange
}: {
  unitSystem: UnitSystem;
  payloadObject: PayloadObjectSelection | null;
  payloadMaterialId: string;
  payloadMassMode: PayloadMassMode;
  manualMassKg: number;
  onPayloadMaterialChange: (materialId: string) => void;
  onPayloadMassModeChange: (mode: PayloadMassMode) => void;
  onManualMassChange: (displayValue: number) => void;
}) {
  const materialListId = useId();
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const [materialQuery, setMaterialQuery] = useState(selectedPayloadMaterial.name);
  const displayManualMass = loadValueForUnits(manualMassKg, "kg", unitSystem);
  const volumeSource = payloadObject?.volumeStatus === "estimated" ? "estimated from bounds" : payloadObject?.volumeSource ?? "not available";

  useEffect(() => {
    setMaterialQuery(selectedPayloadMaterial.name);
  }, [selectedPayloadMaterial.name]);

  function handleMaterialInput(value: string) {
    setMaterialQuery(value);
    const exactMaterial = payloadMaterials.find((material) => material.name.toLowerCase() === value.trim().toLowerCase());
    if (exactMaterial && exactMaterial.id !== payloadMaterialId) {
      onPayloadMaterialChange(exactMaterial.id);
    }
  }

  return (
    <>
      <label className="field">
        <HelpLabel helpId="loadMagnitude">Payload material</HelpLabel>
        <input
          list={materialListId}
          value={materialQuery}
          onChange={(event) => handleMaterialInput(event.currentTarget.value)}
          onBlur={() => setMaterialQuery(payloadMaterialForId(payloadMaterialId).name)}
        />
        <datalist id={materialListId}>
          {PAYLOAD_CATEGORY_ORDER.flatMap((category) =>
            payloadMaterials
              .filter((material) => material.category === category)
              .map((material) => (
                <option key={material.id} value={material.name} />
              ))
          )}
        </datalist>
      </label>
      <Info label="Payload volume" value={payloadObject?.volumeM3 ? `${formatVolume(payloadObject.volumeM3, "m^3", unitSystem)} · ${volumeSource}` : "Select a closed object or use manual mass"} />
      <Callout>Disconnected payload objects are carried weight, not bonded structure. Add each rod or carried part separately; unselected objects do not add weight to the solve.</Callout>
      <label className="toggle material-print-toggle">
        <input
          type="checkbox"
          checked={payloadMassMode === "manual"}
          onChange={(event) => onPayloadMassModeChange(event.currentTarget.checked ? "manual" : "material")}
        />
        <span>
          <strong>Manual mass override</strong>
          <small>Use a measured mass instead of material density times model volume.</small>
        </span>
      </label>
      {payloadMassMode === "manual" && (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">Payload mass</HelpLabel>
          <span className="input-with-unit">
            <input type="number" value={formatInputValue(displayManualMass.value)} onChange={(event) => onManualMassChange(Number(event.currentTarget.value))} />
            <span>{displayManualMass.units}</span>
          </span>
        </label>
      )}
    </>
  );
}

function LoadCasesEditor({ studyType, loadCases, loadCombinations, onChange }: {
  studyType: "static_stress" | "dynamic_structural";
  loadCases: LoadCase[];
  loadCombinations: LoadCombination[];
  onChange: (loadCases: LoadCase[], loadCombinations: LoadCombination[]) => void;
}) {
  const referencedCaseIds = new Set(loadCombinations.flatMap((combination) => combination.factors.map((factor) => factor.caseId)));
  const updateCase = (caseId: string, patch: Partial<LoadCase>) => onChange(
    loadCases.map((loadCase) => loadCase.id === caseId ? { ...loadCase, ...patch } : loadCase),
    loadCombinations
  );
  const updateCombination = (combinationId: string, patch: Partial<LoadCombination>) => onChange(
    loadCases,
    loadCombinations.map((combination) => combination.id === combinationId ? { ...combination, ...patch } : combination)
  );
  return (
    <section className="load-case-editor" aria-label="Load cases">
      {loadCases.map((loadCase) => {
        const canDelete = loadCases.length > 1 && loadCase.loadIds.length === 0 && !referencedCaseIds.has(loadCase.id);
        return (
          <div className="load-case-row" key={loadCase.id}>
            <input aria-label={`Load case name ${loadCase.name}`} value={loadCase.name} onChange={(event) => updateCase(loadCase.id, { name: event.currentTarget.value || "Untitled case" })} />
            <label className="toggle compact-toggle">
              <input type="checkbox" aria-label={`Enable load case ${loadCase.name}`} checked={loadCase.enabled} onChange={(event) => updateCase(loadCase.id, { enabled: event.currentTarget.checked })} />
              <span>Enabled</span>
            </label>
            <small>{loadCase.loadIds.length} load{loadCase.loadIds.length === 1 ? "" : "s"}</small>
            <button type="button" className="remove-glyph" aria-label={`Delete load case ${loadCase.name}`} disabled={!canDelete} onClick={() => onChange(loadCases.filter((candidate) => candidate.id !== loadCase.id), loadCombinations)}><X size={15} /></button>
          </div>
        );
      })}
      <button className="secondary wide" type="button" onClick={() => onChange([
        ...loadCases,
        { id: `case-${crypto.randomUUID()}`, name: `Case ${loadCases.length + 1}`, enabled: true, loadIds: [] }
      ], loadCombinations)}><Plus size={16} />Add load case</button>
      {studyType === "static_stress" && (
        <>
          <SectionTitle helpId="loadCombinations">Combinations</SectionTitle>
          {loadCombinations.map((combination) => (
            <div className="load-combination-row" key={combination.id}>
              <input aria-label={`Combination name ${combination.name}`} value={combination.name} onChange={(event) => updateCombination(combination.id, { name: event.currentTarget.value || "Untitled combination" })} />
              <label className="toggle compact-toggle">
                <input type="checkbox" aria-label={`Enable combination ${combination.name}`} checked={combination.enabled} onChange={(event) => updateCombination(combination.id, { enabled: event.currentTarget.checked })} />
                <span>Enabled</span>
              </label>
              {combination.factors.map((factor) => (
                <label className="combination-factor" key={factor.caseId}>
                  <span>{loadCases.find((loadCase) => loadCase.id === factor.caseId)?.name ?? factor.caseId}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={factor.factor}
                    onChange={(event) => updateCombination(combination.id, {
                      factors: combination.factors.map((candidate) => candidate.caseId === factor.caseId
                        ? { ...candidate, factor: Number.isFinite(Number(event.currentTarget.value)) ? Number(event.currentTarget.value) : 0 }
                        : candidate)
                    })}
                  />
                </label>
              ))}
              <button type="button" className="secondary" onClick={() => onChange(loadCases, loadCombinations.filter((candidate) => candidate.id !== combination.id))}>Delete combination</button>
            </div>
          ))}
          <button className="secondary wide" type="button" disabled={!loadCases.length} onClick={() => onChange(loadCases, [
            ...loadCombinations,
            {
              id: `combination-${crypto.randomUUID()}`,
              name: `Combination ${loadCombinations.length + 1}`,
              enabled: true,
              factors: loadCases.slice(0, 2).map((loadCase) => ({ caseId: loadCase.id, factor: 1 }))
            }
          ])}><Plus size={16} />Add combination</button>
        </>
      )}
    </section>
  );
}

function LoadEditorList({ editingId, onEditingIdChange, study, displayModel, unitSystem, loadCases, retargetFace, onAssignLoadToCase, onUpdateLoad, onPreviewLoadEdit, onRemoveLoad }: { editingId: string | null; onEditingIdChange: (loadId: string | null) => void; study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; loadCases: LoadCase[]; retargetFace?: DisplayFace | null; onAssignLoadToCase: (loadId: string, caseId: string) => void; onUpdateLoad: (load: Load, targetFace?: DisplayFace) => void; onPreviewLoadEdit: (load: Load | null) => void; onRemoveLoad: (loadId: string) => void }) {
  const loadItemRefs = useRef(new Map<string, HTMLButtonElement>());
  if (!study.loads.length) return <EmptyEditableList title="Loads" />;
  const loadLabelsById = new Map(createViewerLoadMarkers({ study, displayModel }).map((marker) => [marker.id, loadMarkerOrdinalLabel(marker)]));

  function finishEditing(loadId: string) {
    onEditingIdChange(null);
    window.requestAnimationFrame(() => loadItemRefs.current.get(loadId)?.focus());
  }

  return (
    <div className="editable-list">
      <h3>Loads</h3>
      {study.loads.map((load) => {
        const editing = editingId === load.id;
        const units = String(load.parameters.units ?? unitsForLoadType(load.type));
        const displayLoad = loadValueForUnits(Number(load.parameters.value ?? 0), units, unitSystem);
        const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
        const selectedFace = displayModel.faces.find((candidate) => candidate.id === selection?.geometryRefs[0]?.entityId);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        const payloadObject = payloadObjectForLoad(load);
        const payloadMaterial = load.type === "gravity" && typeof load.parameters.payloadMaterialId === "string" ? payloadMaterialForId(load.parameters.payloadMaterialId).name : "";
        const pointLabel = payloadObject
          ? ` · ${payloadObject.label}${payloadMaterial ? ` · ${payloadMaterial}` : ""}`
          : applicationPointForLoad(load) ? " · point load" : "";
        const equivalentForce = load.type === "gravity" ? ` · ${formatEquivalentForce(equivalentForceForLoad(load), unitSystem)} weight` : "";
        const loadLabel = loadLabelsById.get(load.id);
        const loadCaseId = loadCases.find((loadCase) => loadCase.loadIds.includes(load.id))?.id ?? loadCases[0]?.id ?? "";
        const editLabel = `Edit ${loadLabel ? `${loadLabel} ` : ""}${load.type} load`;
        const beginEdit = () => onEditingIdChange(load.id);
        return (
          <div className="editable-item load-item" key={load.id}>
            {/* The row's summary is a real button, sibling to Remove and to the
                load-case select. It used to be a div[role=button] wrapping
                them, which nests interactive content inside a control. */}
            <div className="editable-summary">
              <button
                className="editable-summary-trigger"
                type="button"
                ref={(node) => {
                  if (node) loadItemRefs.current.set(load.id, node);
                  else loadItemRefs.current.delete(load.id);
                }}
                aria-label={editLabel}
                aria-expanded={editing}
                disabled={editing}
                onClick={beginEdit}
              >
                <span className={`item-icon load-type-icon ${load.type}`}><LoadTypeIcon type={load.type} /></span>
                <strong>{loadLabel ? `${loadLabel} · ` : ""}{loadTypeLabel(load.type)} · {formatNumber(displayLoad.value)} {displayLoad.units}</strong>
                <small>{load.type === "heat_flux" || load.type === "heat_generation"
                  ? label
                  : `${label}${pointLabel} · ${directionOptionLabel(directionLabelForLoad(load, displayModel, selectedFace))} direction${equivalentForce}`}</small>
              </button>
              {loadCases.length > 1 && (
                <label className="load-case-assignment">
                  <span>Case</span>
                  <select value={loadCaseId} onChange={(event) => onAssignLoadToCase(load.id, event.currentTarget.value)}>
                    {loadCases.map((loadCase) => <option key={loadCase.id} value={loadCase.id}>{loadCase.name}</option>)}
                  </select>
                </label>
              )}
              <button
                className="remove-glyph"
                type="button"
                aria-label={`Remove ${loadTypeLabel(load.type)} load`}
                onClick={() => onRemoveLoad(load.id)}
              >
                <X size={16} />
              </button>
            </div>
            {editing ? (
              <LoadEditForm
                load={load}
                study={study}
                displayModel={displayModel}
                unitSystem={unitSystem}
                accessibleName={`${loadLabel ?? loadTypeLabel(load.type)} load editor`}
                retargetFace={retargetFace}
                onPreviewChange={onPreviewLoadEdit}
                onCancel={() => finishEditing(load.id)}
                onSave={(nextLoad, targetFace) => {
                  onPreviewLoadEdit(null);
                  onUpdateLoad(nextLoad, targetFace);
                  finishEditing(load.id);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function LoadEditForm({ load, study, displayModel, unitSystem, accessibleName, retargetFace, onSave, onCancel, onPreviewChange }: { load: Load; study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; accessibleName: string; retargetFace?: DisplayFace | null; onSave: (load: Load, targetFace?: DisplayFace) => void; onCancel: () => void; onPreviewChange: (load: Load | null) => void }) {
  const [type, setType] = useState<LoadType>(load.type);
  // Re-targeting (2026-09 review D3): a face picked while editing can become
  // the new target; the direction preview follows it.
  const [moveToPicked, setMoveToPicked] = useState(false);
  const [value, setValue] = useState(() => {
    const initialUnits = String(load.parameters.units ?? unitsForLoadType(load.type));
    return formatInputValue(loadValueForUnits(Number(load.parameters.value ?? 500), initialUnits, unitSystem).value);
  });
  const selectedRef = study.namedSelections.find((selection) => selection.id === load.selectionRef);
  const selectionIsBody = selectedRef?.entityType === "body";
  const selectedFace = selectedRef?.geometryRefs[0];
  const selectedDisplayFace = displayModel.faces.find((face) => face.id === selectedFace?.entityId);
  const [direction, setDirection] = useState<LoadDirectionLabel>(directionLabelForLoad(load, displayModel, selectedDisplayFace));
  const [payloadMaterialId, setPayloadMaterialId] = useState(String(load.parameters.payloadMaterialId ?? "payload-steel"));
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>(load.parameters.payloadMassMode === "manual" ? "manual" : "material");
  const [remotePoint, setRemotePoint] = useState<LoadApplicationPoint>(() => finiteVector3(load.parameters.remotePoint) ?? selectedDisplayFace?.center ?? [0, 0, 0]);
  const secondaryFaceOptions = useMemo(
    () => study.namedSelections.filter((selection) => selection.entityType === "face" && selection.id !== load.selectionRef),
    [load.selectionRef, study.namedSelections]
  );
  const [secondarySelectionRef, setSecondarySelectionRef] = useState(typeof load.parameters.secondarySelectionRef === "string" ? load.parameters.secondarySelectionRef : secondaryFaceOptions[0]?.id ?? "");
  const units = unitsForLoadType(type);
  const displayUnits = loadValueForUnits(defaultValueForLoadType(type), units, unitSystem).units;
  const payloadObject = payloadObjectForLoad(load) ?? null;
  const payloadVolumeM3 = positiveNumber(load.parameters.payloadVolumeM3) ? load.parameters.payloadVolumeM3 : payloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const manualMassKg = loadValueForUnits(Number(value), displayUnits, "SI").value;
  const editedValue = type === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : manualMassKg;
  // Memoized on scalar inputs: a fresh object here would retrigger the preview effect every render and loop with the parent setState.
  const payloadMetadata = useMemo<PayloadLoadMetadata>(() => type === "gravity"
    ? { payloadMaterialId, ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}), payloadMassMode }
    : type === "remote_force"
      ? { remotePoint }
      : type === "bolt_preload"
        ? { secondarySelectionRef }
        : {}, [payloadMassMode, payloadMaterialId, payloadVolumeM3, remotePoint, secondarySelectionRef, type]);
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const pickedElsewhere = retargetFace && !selectionIsBody && retargetFace.id !== selectedFace?.entityId ? retargetFace : null;
  const targetFace = moveToPicked && pickedElsewhere ? pickedElsewhere : undefined;
  const directionFace: DisplayFace = useMemo(() => targetFace ?? selectedDisplayFace ?? ({
    id: selectedFace?.entityId ?? "selected-face",
    label: selectedFace?.label ?? "selected face",
    color: "#fff",
    center: [0, 0, 0],
    normal: [0, 1, 0],
    stressValue: 0
  }), [selectedDisplayFace, selectedFace?.entityId, selectedFace?.label, targetFace]);
  const previewLoad = useMemo(() => editedLoadForForm(load, type, value, displayUnits, units, direction, directionFace, displayModel, payloadMetadata, editedValue), [direction, directionFace, displayModel, displayUnits, editedValue, load, payloadMetadata, type, units, value]);
  const magnitudeError = loadMagnitudeError(editedValue, study.type);
  const opposingFaceError = type === "bolt_preload" && (!secondarySelectionRef || secondarySelectionRef === load.selectionRef)
    ? "Choose a different opposing face."
    : null;
  const remotePointError = type === "remote_force" && !remotePoint.every((component) => Number.isFinite(component))
    ? "Remote point coordinates must be numbers."
    : null;
  const saveBlockedBy = magnitudeError ?? opposingFaceError ?? remotePointError;
  const magnitudeErrorId = `${load.id}-magnitude-error`;

  useEffect(() => {
    onPreviewChange(previewLoad);
    return () => onPreviewChange(null);
  }, [onPreviewChange, previewLoad]);

  return (
    <div className="edit-form" role="group" aria-label={accessibleName}>
      <label className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <select value={type} onChange={(event) => setType(event.currentTarget.value as LoadType)}>
          {selectionIsBody ? (
            <>
              <option value="volume_force">Volume force</option>
              <option value="gravity">Payload mass</option>
            </>
          ) : (
            <>
              <option value="force">Face force (total)</option>
              <option value="pressure">Pressure</option>
              <option value="surface_traction">Surface traction</option>
              <option value="remote_force">Remote force</option>
              {study.type === "static_stress" ? <option value="bolt_preload">Equivalent bolt preload</option> : null}
            </>
          )}
        </select>
      </label>
      {type === "gravity" ? (
        <>
          <PayloadMassControls
            unitSystem={unitSystem}
            payloadObject={payloadObject}
            payloadMaterialId={payloadMaterialId}
            payloadMassMode={payloadMassMode}
            manualMassKg={manualMassKg}
            onPayloadMaterialChange={setPayloadMaterialId}
            onPayloadMassModeChange={setPayloadMassMode}
            onManualMassChange={(displayValue) => setValue(formatInputValue(displayValue))}
          />
          <Info label="Selected density" value={formatDensity(selectedPayloadMaterial.density, "kg/m^3", unitSystem)} />
          <Info label="Calculated mass" value={formatMass(calculatedPayloadMass, "kg", unitSystem)} />
          <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: editedValue } }), unitSystem)} equivalent weight.</Callout>
        </>
      ) : (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">Magnitude</HelpLabel>
          <span className="input-with-unit">
            <input
              type="number"
              value={value}
              aria-invalid={magnitudeError ? true : undefined}
              aria-describedby={magnitudeError ? magnitudeErrorId : undefined}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <span>{displayUnits}</span>
          </span>
        </label>
      )}
      {magnitudeError && <p className="field-error" id={magnitudeErrorId} role="alert">{magnitudeError}</p>}
      <PlacementReadout selectedRef={selectedRef} />
      {type === "remote_force" ? (
        <fieldset className="field"><legend>Remote point coordinates</legend><div className="vector-inputs">
          {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}>{axis}<input type="number" value={remotePoint[index]} onChange={(event) => {
            const next = [...remotePoint] as LoadApplicationPoint;
            next[index] = Number(event.currentTarget.value);
            setRemotePoint(next);
          }} /></label>)}
        </div></fieldset>
      ) : null}
      {type === "bolt_preload" ? (
        <label className="field">Opposing face<select value={secondarySelectionRef} onChange={(event) => setSecondarySelectionRef(event.currentTarget.value)}>
          <option value="">Choose a different face</option>
          {secondaryFaceOptions.map((selection) => <option key={selection.id} value={selection.id}>{selection.name}</option>)}
        </select></label>
      ) : null}
      <label className="field">
        <HelpLabel helpId="loadDirection">Direction</HelpLabel>
        <select value={direction} onChange={(event) => setDirection(event.currentTarget.value as LoadDirectionLabel)}>
          {LOAD_DIRECTION_LABELS.map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>
      {pickedElsewhere && (
        <label className="toggle">
          <input type="checkbox" aria-label={`Move to ${pickedElsewhere.label}`} checked={moveToPicked} onChange={(event) => setMoveToPicked(event.currentTarget.checked)} />
          <span>Move to {pickedElsewhere.label} (picked in the viewer)</span>
        </label>
      )}
      <div className="edit-actions">
        <button
          className="primary"
          type="button"
          disabled={Boolean(saveBlockedBy)}
          title={saveBlockedBy ?? undefined}
          onClick={() => !saveBlockedBy && onSave(previewLoad, targetFace)}
        >
          Save
        </button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function editedLoadForForm(load: Load, type: LoadType, value: string, displayUnits: string, units: string, direction: LoadDirectionLabel, directionFace: DisplayFace, displayModel: DisplayModel, payloadMetadata: PayloadLoadMetadata = {}, overrideValue?: number): Load {
  return {
    ...load,
    type,
    parameters: {
      ...load.parameters,
      value: overrideValue ?? loadValueForUnits(Number(value), displayUnits, "SI").value,
      units,
      direction: directionVectorForLabel(direction, directionFace, displayModel),
      directionMode: direction,
      ...(type === "gravity" || type === "remote_force" || type === "bolt_preload" ? payloadMetadata : {})
    }
  };
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteVector3(value: unknown): LoadApplicationPoint | null {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0], value[1], value[2]]
    : null;
}

function SupportEditorList({ study, retargetFace, onUpdateSupport, onRemoveSupport }: { study: Study; retargetFace?: DisplayFace | null; onUpdateSupport: (support: Constraint, targetFace?: DisplayFace) => void; onRemoveSupport: (supportId: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Mirrors the load rows: closing the form must return focus to the control
  // that opened it, or the form's unmount drops focus to <body>.
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  if (!study.constraints.length) return <EmptyEditableList title="Supports" />;

  function finishEditing(supportId: string) {
    setEditingId(null);
    window.requestAnimationFrame(() => editButtonRefs.current.get(supportId)?.focus());
  }

  let fixedSupportCount = 0;
  let prescribedSupportCount = 0;
  let thermalSupportCount = 0;
  const supportItems = study.constraints.map((support) => {
    const supportOrdinal = support.type === "fixed" ? ++fixedSupportCount : support.type === "prescribed_temperature" ? ++thermalSupportCount : ++prescribedSupportCount;
    return { support, displayLabel: supportDisplayLabel(support, supportOrdinal) };
  });

  return (
    <div className="editable-list">
      <h3>Supports</h3>
      {supportItems.map(({ support, displayLabel }) => {
        const editing = editingId === support.id;
        const selection = study.namedSelections.find((candidate) => candidate.id === support.selectionRef);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        return (
          <div className="editable-item" key={support.id}>
            <div className="editable-summary">
              <span className="item-icon warning"><SupportIcon /></span>
              <strong>{displayLabel} · {support.type === "fixed" ? "Fixed support" : support.type === "prescribed_temperature" ? `Prescribed temperature (${Number(support.parameters.value ?? 0)} °C)` : `Prescribed displacement (${Number(support.parameters.value ?? 0)} mm ${String(support.parameters.component ?? "z")})`}</strong>
              <small>{label}</small>
              <button className="remove-glyph" type="button" aria-label="Remove support" onClick={() => onRemoveSupport(support.id)}><X size={16} /></button>
            </div>
            {editing ? (
              <SupportEditForm
                support={support}
                study={study}
                retargetFace={retargetFace}
                onCancel={() => finishEditing(support.id)}
                onSave={(nextSupport, targetFace) => {
                  onUpdateSupport(nextSupport, targetFace);
                  finishEditing(support.id);
                }}
              />
            ) : (
              <button
                className="secondary wide"
                type="button"
                ref={(node) => {
                  if (node) editButtonRefs.current.set(support.id, node);
                  else editButtonRefs.current.delete(support.id);
                }}
                onClick={() => setEditingId(support.id)}
              >
                Edit support
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LoadTypeIcon({ type }: { type: LoadType }) {
  if (type === "pressure" || type === "surface_traction") return <Gauge size={16} />;
  if (type === "gravity") return <Weight size={16} />;
  return <ScanLine size={16} />;
}

function SupportEditForm({ support, study, retargetFace, onSave, onCancel }: { support: Constraint; study: Study; retargetFace?: DisplayFace | null; onSave: (support: Constraint, targetFace?: DisplayFace) => void; onCancel: () => void }) {
  const thermal = study.type === "steady_state_thermal";
  const [type, setType] = useState<Constraint["type"]>(support.type);
  const [temperature, setTemperature] = useState(Number(support.parameters.value ?? 20));
  const [displacementValueMm, setDisplacementValueMm] = useState(Number(support.parameters.value ?? 0));
  const [displacementComponent, setDisplacementComponent] = useState<"x" | "y" | "z">(
    support.parameters.component === "x" || support.parameters.component === "y" || support.parameters.component === "z"
      ? support.parameters.component
      : "z"
  );
  const selectedRef = study.namedSelections.find((selection) => selection.id === support.selectionRef);
  // Re-targeting (2026-09 review D3): a face picked while editing can become
  // the new target; before, the pick added a second support instead.
  const [moveToPicked, setMoveToPicked] = useState(false);
  const pickedElsewhere = retargetFace && !selectedRef?.geometryRefs.some((ref) => ref.entityId === retargetFace.id) ? retargetFace : null;
  const targetFace = moveToPicked && pickedElsewhere ? pickedElsewhere : undefined;
  return (
    <div className="edit-form">
      {pickedElsewhere && (
        <label className="toggle">
          <input type="checkbox" aria-label={`Move to ${pickedElsewhere.label}`} checked={moveToPicked} onChange={(event) => setMoveToPicked(event.currentTarget.checked)} />
          <span>Move to {pickedElsewhere.label} (picked in the viewer)</span>
        </label>
      )}
      <label className="field">
        <HelpLabel helpId="supportType">Support type</HelpLabel>
        <select value={type} onChange={(event) => setType(event.currentTarget.value as Constraint["type"])}>
          {thermal
            ? <option value="prescribed_temperature">Prescribed temperature</option>
            : <>
              <option value="fixed">Fixed support</option>
              <option value="prescribed_displacement">Prescribed displacement</option>
            </>}
        </select>
      </label>
      {thermal && <label className="field">Temperature<span className="input-with-unit"><input type="number" value={temperature} onChange={(event) => setTemperature(Number(event.currentTarget.value))} /><span>°C</span></span></label>}
      {!thermal && type === "prescribed_displacement" && (
        <>
          <label className="field">Displacement<span className="input-with-unit"><input type="number" value={displacementValueMm} onChange={(event) => setDisplacementValueMm(Number(event.currentTarget.value))} /><span>mm</span></span></label>
          <label className="field">Component
            <select value={displacementComponent} onChange={(event) => setDisplacementComponent(event.currentTarget.value as "x" | "y" | "z")}>
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
          </label>
        </>
      )}
      <PlacementReadout selectedRef={selectedRef} />
      <div className="edit-actions">
        <button className="primary" type="button" disabled={(thermal && !Number.isFinite(temperature)) || (!thermal && type === "prescribed_displacement" && !Number.isFinite(displacementValueMm))} onClick={() => onSave({ ...support, type, parameters: thermal ? { ...support.parameters, value: temperature, units: "°C" } : type === "prescribed_displacement" ? { ...support.parameters, value: displacementValueMm, units: "mm", component: displacementComponent } : support.parameters }, targetFace)}>Save</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
