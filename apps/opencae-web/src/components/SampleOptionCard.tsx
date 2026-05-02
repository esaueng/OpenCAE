import type { KeyboardEvent } from "react";
import type { SampleModelId } from "../lib/api";
import type { SampleOption } from "./sampleOptions";

interface SampleOptionCardProps {
  option: SampleOption;
  selected: boolean;
  compact?: boolean;
  onSelect: (sample: SampleModelId) => void;
  onOpen: (sample: SampleModelId) => void;
}

export function SampleOptionCard({ option, selected, compact = false, onSelect, onOpen }: SampleOptionCardProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(option.id);
  }

  return (
    <button
      className={`sample-option-card ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      type="button"
      aria-pressed={selected}
      aria-label={`Select ${option.title} sample`}
      onClick={() => onSelect(option.id)}
      onDoubleClick={() => onOpen(option.id)}
      onKeyDown={handleKeyDown}
    >
      <SampleThumbnail option={option} />
      <span className="sample-option-copy">
        <strong>{option.title}</strong>
        <small>{option.description}</small>
      </span>
      <span className="sample-option-meta">
        <span>{option.support}</span>
        <span>{option.load}</span>
      </span>
    </button>
  );
}

function SampleThumbnail({ option }: { option: SampleOption }) {
  if (option.imageSrc) {
    return (
      <span className={`sample-thumbnail sample-thumbnail-${option.thumbnail}`} aria-hidden="true">
        <img src={option.imageSrc} alt="" />
      </span>
    );
  }

  return (
    <span className={`sample-thumbnail sample-thumbnail-${option.thumbnail}`} aria-hidden="true">
      <svg viewBox="0 0 160 104" role="img">
        <defs>
          <linearGradient id={`sample-top-${option.id}`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#b8c5cf" />
            <stop offset="100%" stopColor="#73818b" />
          </linearGradient>
          <linearGradient id={`sample-side-${option.id}`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#7f8d97" />
            <stop offset="100%" stopColor="#4f5c66" />
          </linearGradient>
        </defs>
        <ThumbnailGeometry option={option} />
        <g className="sample-marker support-marker">
          <circle cx={option.thumbnail === "bracket" ? 49 : 31} cy={option.thumbnail === "bracket" ? 68 : 60} r="5" />
          <circle cx={option.thumbnail === "bracket" ? 67 : 31} cy={option.thumbnail === "bracket" ? 57 : 74} r="4" />
        </g>
        <g className="sample-marker load-marker">
          <path d={option.thumbnail === "bracket" ? "M104 26 L104 48" : "M128 20 L128 48"} />
          <path d={option.thumbnail === "bracket" ? "M96 42 L104 55 L112 42" : "M120 42 L128 55 L136 42"} />
        </g>
      </svg>
    </span>
  );
}

function ThumbnailGeometry({ option }: { option: SampleOption }) {
  if (option.thumbnail === "bracket") {
    return (
      <g>
        <path className="sample-face side" d="M40 69 L100 42 L120 52 L59 82 Z" />
        <path className="sample-face top" d="M40 58 L100 31 L120 41 L59 70 Z" />
        <path className="sample-face side" d="M59 70 L120 41 L120 52 L59 82 Z" />
        <path className="sample-face top" d="M78 52 L98 43 L98 22 L78 31 Z" />
        <path className="sample-face side" d="M98 22 L113 31 L113 54 L98 43 Z" />
        <path className="sample-face rib" d="M74 62 L96 49 L96 67 Z" />
        <circle className="sample-hole" cx="51" cy="62" r="4" />
        <circle className="sample-hole" cx="67" cy="55" r="4" />
      </g>
    );
  }

  return (
    <g>
      <path className="sample-face top" d="M26 56 L118 26 L138 38 L46 71 Z" />
      <path className="sample-face side" d="M46 71 L138 38 L136 56 L46 88 Z" />
      <path className="sample-face side dark" d="M26 56 L46 71 L46 88 L27 73 Z" />
      {option.thumbnail === "beam" && (
        <path className="sample-face payload" d="M112 18 L137 27 L137 42 L112 33 Z" />
      )}
      {option.thumbnail === "cantilever" && (
        <path className="sample-face rib" d="M34 51 L46 56 L46 82 L34 75 Z" />
      )}
    </g>
  );
}
