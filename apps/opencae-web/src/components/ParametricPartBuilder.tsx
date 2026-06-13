import { useMemo, useState } from "react";
import { Box, Download, Plus } from "lucide-react";
import {
  PARAMETRIC_PARTS,
  buildParametricPartStep,
  defaultPartParameters,
  parametricPartFor,
  validatePartParameters,
  type ParametricPartId
} from "@opencae/step";

interface ParametricPartBuilderProps {
  /** Receives the generated STEP file so it imports through the normal upload path. */
  onCreatePart: (file: File) => void;
}

/**
 * Builds an exact analytic STEP solid from a few millimetre dimensions. The
 * generated file uses CYLINDRICAL_SURFACE / TOROIDAL_SURFACE / PLANE B-rep
 * faces, so it imports as a smooth, dimension-editable body here and in
 * external CAD tools (Shapr3D, Fusion, FreeCAD) instead of a faceted mesh.
 */
export function ParametricPartBuilder({ onCreatePart }: ParametricPartBuilderProps) {
  const [partId, setPartId] = useState<ParametricPartId>("coat-hook");
  const [valuesByPart, setValuesByPart] = useState<Record<ParametricPartId, Record<string, number>>>(() => ({
    "coat-hook": defaultPartParameters("coat-hook"),
    cylinder: defaultPartParameters("cylinder"),
    ring: defaultPartParameters("ring"),
    plate: defaultPartParameters("plate")
  }));

  const part = parametricPartFor(partId);
  const values = valuesByPart[partId];
  const problems = useMemo(() => validatePartParameters(partId, values), [partId, values]);
  const isValid = problems.length === 0;

  function setValue(key: string, nextValue: number) {
    setValuesByPart((current) => ({ ...current, [partId]: { ...current[partId], [key]: nextValue } }));
  }

  function buildFile(): File | null {
    if (!isValid) return null;
    const { filename, stepText } = buildParametricPartStep(partId, values);
    return new File([stepText], filename, { type: "model/step" });
  }

  function handleAddToProject() {
    const file = buildFile();
    if (file) onCreatePart(file);
  }

  function handleDownload() {
    const file = buildFile();
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="parametric-part-builder">
      <label className="field">
        <span>Part type</span>
        <select value={partId} onChange={(event) => setPartId(event.currentTarget.value as ParametricPartId)}>
          {PARAMETRIC_PARTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="panel-copy parametric-part-summary">{part.summary}</p>
      <div className="parametric-part-fields">
        {part.parameters.map((parameter) => (
          <PartDimensionField
            key={parameter.key}
            label={parameter.label}
            description={parameter.description}
            min={parameter.minMm}
            max={parameter.maxMm}
            value={values[parameter.key] ?? parameter.defaultMm}
            onCommit={(nextValue) => setValue(parameter.key, nextValue)}
          />
        ))}
      </div>
      {!isValid && (
        <ul className="parametric-part-problems" aria-live="polite">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="button-grid">
        <button className="primary" type="button" onClick={handleAddToProject} disabled={!isValid}>
          <Plus size={16} />
          Add to project
        </button>
        <button className="secondary" type="button" onClick={handleDownload} disabled={!isValid}>
          <Download size={16} />
          Download .step
        </button>
      </div>
      <p className="panel-copy parametric-part-note">
        <Box size={14} aria-hidden="true" />
        Exports an analytic STEP solid with smooth, editable surfaces for any CAD tool.
      </p>
    </div>
  );
}

function PartDimensionField({
  label,
  description,
  min,
  max,
  value,
  onCommit
}: {
  label: string;
  description: string;
  min: number;
  max: number;
  value: number;
  onCommit: (value: number) => void;
}) {
  const formatted = formatDimensionValue(value);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);

  function commit(rawValue: string) {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    onCommit(parsed);
  }

  return (
    <label className="field" title={description}>
      <span>{label}</span>
      <span className="input-with-unit">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={0.5}
          value={editing ? draft : formatted}
          onFocus={() => {
            setEditing(true);
            setDraft(formatted);
          }}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            setDraft(nextValue);
            commit(nextValue);
          }}
          onBlur={(event) => {
            setEditing(false);
            const trimmed = event.currentTarget.value.trim();
            const parsed = Number(trimmed);
            setDraft(formatDimensionValue(Number.isFinite(parsed) && trimmed ? parsed : value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span>mm</span>
      </span>
    </label>
  );
}

function formatDimensionValue(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}
