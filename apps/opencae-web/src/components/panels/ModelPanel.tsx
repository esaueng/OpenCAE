/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useEffect, useRef, useState } from "react";

import { AlertTriangle, ArrowDown, Atom, Eye, Factory, Maximize2, RotateCcw, Ruler, ScanLine, Upload, Wrench } from "lucide-react";

import { GEOMETRY_FILE_ACCEPT, PREVIEW_ONLY_GEOMETRY_NOTICE, SUPPORTED_GEOMETRY_FORMAT_LABEL } from "../../geometryFormats";

import { DEFAULT_SECTION_PLANE } from "../../workspaceViewTypes";

import { type SampleAnalysisType, type SampleModelId } from "../../lib/api";

import { stepGeometryMetadataForProject } from "../../stepGeometryState";

import { formatModelOrientation, getModelOrientation } from "../../modelOrientation";
import { shouldShowSampleModelPicker } from "../../modelPanelState";

import { formatMass, formatVolume } from "../../unitDisplay";

import { ParametricPartBuilder } from "../ParametricPartBuilder";
import { SampleOptionCard } from "../SampleOptionCard";
import { SAMPLE_ANALYSIS_OPTIONS, sampleAnalysisOptionFor } from "../sampleAnalysisOptions";
import { SAMPLE_OPTIONS, sampleOptionFor } from "../sampleOptions";

import type { RightPanelProps } from "./RightPanelProps";
import { Panel } from "./PanelChrome";
import { Callout, Collapsible, ConceptCard, HelpLabel, HelpNote, Info, ModelDimensions, SectionTitle, SupportIcon, formatEquivalentForce } from "./PanelChrome";
export function ModelPanel({ project, displayModel, study, viewMode, showDimensions, sectionPlane = DEFAULT_SECTION_PLANE, sampleModel, sampleAnalysisType = "static_stress", onFitView, onRotateModel, onResetModelOrientation, onViewModeChange, onToggleDimensions, onSectionPlaneChange, onLoadSample, onUploadModel, onRepairModel, isRepairingModel = false }: RightPanelProps) {
  const [confirmSampleLoad, setConfirmSampleLoad] = useState(false);
  const [pendingSampleModel, setPendingSampleModel] = useState<SampleModelId>(sampleModel);
  const [pendingAnalysisType, setPendingAnalysisType] = useState<SampleAnalysisType>(sampleAnalysisType);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setPendingSampleModel(sampleModel);
    setConfirmSampleLoad(false);
  }, [sampleModel]);
  useEffect(() => {
    setPendingAnalysisType(sampleAnalysisType);
    setConfirmSampleLoad(false);
  }, [sampleAnalysisType]);
  const geometry = project.geometryFiles[0];
  const isBlankProject = !geometry;
  const isUploadedProject = geometry?.metadata.source === "local-upload";
  const showSampleModelPicker = shouldShowSampleModelPicker(project);
  const uploadPreviewFormat = typeof geometry?.metadata.previewFormat === "string" ? geometry.metadata.previewFormat.toUpperCase() : "";
  const isNativeCadImport = Boolean(geometry?.metadata.nativeCadImport);
  const faceCount = Number(geometry?.metadata.faceCount ?? 0);
  const bodyCount = Number(geometry?.metadata.bodyCount ?? 0);
  const stepGeometry = stepGeometryMetadataForProject(project);
  const stepGeometryResolvedByMesh = Boolean(study.meshSettings.summary?.artifacts?.actualCoreModel);
  const sampleLabel = sampleOptionFor(pendingSampleModel).title;
  const sampleAnalysis = sampleAnalysisOptionFor(pendingAnalysisType);
  const sampleAnalysisLabel = sampleAnalysis.fullLabel;
  const sampleForceLabel = formatEquivalentForce(500, project.unitSystem);
  // The beam summary describes the structural body only. The separate
  // 0.498 kg payload is reported below as a load and must not be counted as
  // beam material mass.
  const sampleSummaryVolumeMm3 = pendingSampleModel === "plate" ? 28_590 : 41_280;
  const sampleSummaryMassG = pendingSampleModel === "plate" ? 77 : 111;
  const sampleLoadTitle = pendingSampleModel === "plate" ? `Payload mass · ${formatMass(0.497664, "kg", project.unitSystem)}` : `Force · ${sampleForceLabel}`;
  const orientation = getModelOrientation(displayModel);
  const hasCustomOrientation = orientation.x !== 0 || orientation.y !== 0 || orientation.z !== 0;
  const preconfigured =
    pendingSampleModel === "bracket"
      ? { support: "2 mounting holes · flange", load: "top face · -Z direction", callout: "An L-bracket is bolted at the flange; a vertical load on the top face creates a peak stress at the inside corner, reduced by the gusset rib." }
      : pendingSampleModel === "plate"
        ? { support: "fixed end face", load: "end payload mass · -Y direction", callout: "A simple beam is fixed at one end and carries a payload mass sitting on the free end, producing bending stress along the span." }
        : { support: "fixed end face", load: "free end face · -Z direction", callout: "A cantilever beam is fixed at one end and loaded at the free end, producing bending stress along the beam span." };
  const sampleSetup = pendingAnalysisType === "modal_analysis"
    ? {
        boundaryTitle: "Fixed support",
        boundaryDetail: preconfigured.support,
        actionTitle: "6 natural modes",
        actionDetail: "Natural frequencies and mode shapes",
        actionIcon: <Atom size={18} />,
        callout: `The ${sampleLabel.toLowerCase()} is supported without an external load so its first six natural frequencies and mode shapes can be calculated.`
      }
    : pendingAnalysisType === "steady_state_thermal"
      ? {
          boundaryTitle: "20 °C reference",
          boundaryDetail: preconfigured.support,
          actionTitle: "Heat flux · 10 kW/m²",
          actionDetail: pendingSampleModel === "bracket" ? "Top face" : "Free-end face",
          actionIcon: <Factory size={18} />,
          callout: `A 20 °C reference temperature and an inward 10 kW/m² heat flux create a steady conduction gradient through the ${sampleLabel.toLowerCase()}.`
        }
      : {
          boundaryTitle: "Fixed support",
          boundaryDetail: preconfigured.support,
          actionTitle: sampleLoadTitle,
          actionDetail: preconfigured.load,
          actionIcon: <ArrowDown size={18} />,
          callout: preconfigured.callout
        };

  function handleLoadSampleClick() {
    if (!confirmSampleLoad) {
      setConfirmSampleLoad(true);
      return;
    }
    setConfirmSampleLoad(false);
    onLoadSample(pendingSampleModel, pendingAnalysisType);
  }

  function handleSampleSelect(sample: SampleModelId) {
    setPendingSampleModel(sample);
    setConfirmSampleLoad(false);
  }

  function handleSampleOpen(sample: SampleModelId) {
    setPendingSampleModel(sample);
    setConfirmSampleLoad(true);
  }

  function handleAnalysisSelect(analysisType: SampleAnalysisType) {
    setPendingAnalysisType(analysisType);
    setConfirmSampleLoad(false);
  }

  const uploadInput = (
    <input
      ref={uploadInputRef}
      className="hidden-file-input"
      type="file"
      tabIndex={-1}
      aria-hidden="true"
      accept={GEOMETRY_FILE_ACCEPT}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) onUploadModel(file);
      }}
    />
  );
  const uploadAction = (
    <>
      <button className={isBlankProject ? "primary wide" : "secondary wide"} type="button" onClick={() => uploadInputRef.current?.click()}>
        <Upload size={16} />
        {isBlankProject ? "Upload model" : "Replace model"}
      </button>
      {isBlankProject ? (
        <Callout>Upload {SUPPORTED_GEOMETRY_FORMAT_LABEL} to import a model. STL and OBJ files use the mesh preview; STEP files import as a selectable CAD body.</Callout>
      ) : isUploadedProject ? (
        <Callout>{isNativeCadImport ? `${geometry.filename} is loaded as a selectable STEP import.` : uploadPreviewFormat ? `${geometry.filename} is loaded with a ${uploadPreviewFormat} viewport preview. ${PREVIEW_ONLY_GEOMETRY_NOTICE}` : `${geometry.filename} cannot be previewed in this local viewer. Replace it with ${SUPPORTED_GEOMETRY_FORMAT_LABEL}.`}</Callout>
      ) : null}
    </>
  );
  const parametricBuilder = (
    <Collapsible title="Create parametric part" subtitle="Analytic STEP solid" defaultOpen={isBlankProject}>
      <ParametricPartBuilder onCreatePart={onUploadModel} />
    </Collapsible>
  );

  /* Plan 027 B: the panel leads with the state of THIS model. Alternatives
     (other samples, other analysis types) and the parametric builder sit in
     closed collapsibles below the actions; a blank project inverts that, since
     getting a model in is its only state. */
  return (
    <Panel title="Model" step="model" helper="Inspect the 3D part. Orbit with left-drag, pan with right-drag, zoom with scroll." study={study}>
      {uploadInput}
      {isBlankProject && uploadAction}
      {isBlankProject && parametricBuilder}
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
        <p className="panel-warning" role="alert"><AlertTriangle size={16} />{stepGeometry.message ?? "This STEP model is not a closed solid and automatic repair could not produce one. Repair it in CAD and upload it again."}</p>
      )}
      {(stepGeometry?.status === "repaired" || (stepGeometryResolvedByMesh && stepGeometry?.status === "repairable")) && (
        <Callout>Geometry repair complete. Open boundaries were converted into a closed solid for simulation; review the shape before relying on results.</Callout>
      )}
      <div className="summary-box">
        <Info label="Project" value={project.name} />
        <Info label="Study" value={study.name} />
        <Info label="Model" value={geometry?.filename ?? "No model loaded"} />
        <Info label="Bodies" value={String(bodyCount)} />
        <Info label="Faces" value={String(faceCount)} />
        {showSampleModelPicker && (
          <>
            <Info label="Volume" value={formatVolume(sampleSummaryVolumeMm3, "mm^3", project.unitSystem)} />
            <Info label="Mass" value={formatMass(sampleSummaryMassG, "g", project.unitSystem)} />
            <Info label="Sample analysis" value={sampleAnalysisLabel} />
          </>
        )}
        <Info label="Units" value={project.unitSystem === "US" ? "in" : "mm"} />
      </div>
      <button className={showDimensions ? "primary wide" : "secondary wide"} type="button" onClick={onToggleDimensions}>
        <Ruler size={16} />
        {showDimensions ? "Hide dimensions" : "Show dimensions"}
      </button>
      <HelpNote helpId="dimensions" />
      {showDimensions && <ModelDimensions displayModel={displayModel} />}
      <SectionTitle helpId="sectionPlane">Open section</SectionTitle>
      <button
        className={sectionPlane.enabled ? "primary wide" : "secondary wide"}
        type="button"
        aria-pressed={sectionPlane.enabled}
        onClick={() => onSectionPlaneChange?.({ ...sectionPlane, enabled: !sectionPlane.enabled })}
      >
        <ScanLine size={16} />
        {sectionPlane.enabled ? "Close section" : "Open section"}
      </button>
      {sectionPlane.enabled ? (
        <div className="section-plane-controls">
          <div className="segmented" role="group" aria-label="Section plane axis">
            {(["x", "y", "z"] as const).map((axis) => (
              <button
                key={axis}
                className={sectionPlane.axis === axis ? "active" : ""}
                type="button"
                aria-pressed={sectionPlane.axis === axis}
                onClick={() => onSectionPlaneChange?.({ ...sectionPlane, axis })}
              >{axis.toUpperCase()}</button>
            ))}
          </div>
          <label className="field">
            <span>Normalized offset · {Math.round(sectionPlane.offset * 100)}%</span>
            <input type="range" min="0" max="1" step="0.01" value={sectionPlane.offset} onChange={(event) => onSectionPlaneChange?.({ ...sectionPlane, offset: Number(event.currentTarget.value) })} />
          </label>
          <button className="secondary wide" type="button" aria-pressed={sectionPlane.flipped} onClick={() => onSectionPlaneChange?.({ ...sectionPlane, flipped: !sectionPlane.flipped })}>
            <RotateCcw size={15} />Flip cut side
          </button>
          <p className="panel-copy">Geometry, mesh, result contours, feature edges, and the undeformed outline are clipped. Loads, supports, probes, and annotations stay visible.</p>
        </div>
      ) : null}
      <SectionTitle helpId="orientation">Orientation</SectionTitle>
      <div className="orientation-controls" role="group" aria-label="Axis view">
        {(["x", "y", "z"] as const).map((axis) => (
          <button key={axis} className="secondary" type="button" onClick={() => onRotateModel(axis)} title={`View perpendicular to ${axis.toUpperCase()} axis`}>
            <Eye size={15} />
            {axis.toUpperCase()}
          </button>
        ))}
        <button className="secondary" type="button" onClick={onResetModelOrientation} disabled={!hasCustomOrientation} title="Reset model orientation">
          <RotateCcw size={15} />
          Reset
        </button>
      </div>
      <p className="orientation-readout">{formatModelOrientation(displayModel)}</p>
      <div className="button-grid">
        <button className="secondary" onClick={onFitView}><Maximize2 size={16} />Fit view</button>
        <button type="button" className={viewMode === "mesh" ? "primary" : "secondary"} aria-pressed={viewMode === "mesh"} onClick={() => onViewModeChange(viewMode === "mesh" ? "model" : "mesh")}><Eye size={16} />Toggle mesh</button>
      </div>
      {!isBlankProject && !isUploadedProject && (
        <>
          <SectionTitle helpId="preconfigured">Preconfigured</SectionTitle>
          <div className="concept-card-list">
            <ConceptCard icon={<SupportIcon />} title={sampleSetup.boundaryTitle} detail={sampleSetup.boundaryDetail} tone="warning" />
            <ConceptCard icon={sampleSetup.actionIcon} title={sampleSetup.actionTitle} detail={sampleSetup.actionDetail} tone="accent" />
          </div>
          <Callout>{sampleSetup.callout}</Callout>
        </>
      )}
      {!isBlankProject && uploadAction}
      {showSampleModelPicker && (
        <Collapsible title="Change model" subtitle="Sample and analysis type" helpId="sampleModel">
          <div className="field">
            <div className="sample-option-grid panel-sample-grid" role="group" aria-label="Sample model">
              {SAMPLE_OPTIONS.map((option) => (
                <SampleOptionCard
                  key={option.id}
                  option={option}
                  selected={pendingSampleModel === option.id}
                  compact
                  analysisType={pendingAnalysisType}
                  onSelect={handleSampleSelect}
                  onOpen={handleSampleOpen}
                />
              ))}
            </div>
            <HelpLabel helpId="sampleModel">Analysis type</HelpLabel>
            <div className="segmented analysis-type sample-analysis-type-grid" role="group" aria-label="Analysis type">
              {SAMPLE_ANALYSIS_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={pendingAnalysisType === option.id ? "active" : ""}
                  type="button"
                  aria-pressed={pendingAnalysisType === option.id}
                  onClick={() => handleAnalysisSelect(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              className={confirmSampleLoad ? "primary wide" : "secondary wide"}
              type="button"
              onClick={handleLoadSampleClick}
              title={confirmSampleLoad ? "Click again to reload the sample project" : "Prepare to reload the sample project"}
            >
              <RotateCcw size={16} />
              {confirmSampleLoad ? "Click again to load sample" : `Load ${sampleAnalysis.label.toLowerCase()} sample`}
            </button>
            {confirmSampleLoad && <span className="panel-copy confirm-copy">This will reload {sampleLabel} as {sampleAnalysisLabel} and reset the sample setup.</span>}
          </div>
        </Collapsible>
      )}
      {!isBlankProject && parametricBuilder}
    </Panel>
  );
}
