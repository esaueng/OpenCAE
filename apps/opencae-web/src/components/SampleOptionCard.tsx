import type { KeyboardEvent } from "react";
import type { SampleAnalysisType, SampleModelId } from "../lib/api";
import type { SampleOption } from "./sampleOptions";

interface SampleOptionCardProps {
  option: SampleOption;
  selected: boolean;
  compact?: boolean;
  analysisType?: SampleAnalysisType;
  onSelect: (sample: SampleModelId) => void;
  onOpen: (sample: SampleModelId) => void;
}

export function SampleOptionCard({ option, selected, compact = false, analysisType = "static_stress", onSelect, onOpen }: SampleOptionCardProps) {
  const meta = sampleMetaForAnalysis(option, analysisType);

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
      <SampleThumbnail option={option} analysisType={analysisType} />
      <span className="sample-option-copy">
        <strong>{option.title}</strong>
        <small>{option.description}</small>
      </span>
      <span className="sample-option-meta">
        <span>{meta.support}</span>
        <span>{meta.action}</span>
      </span>
    </button>
  );
}

function SampleThumbnail({ option, analysisType }: { option: SampleOption; analysisType: SampleAnalysisType }) {
  const vibrating = analysisType === "dynamic_structural" || analysisType === "modal_analysis";
  const dynamicLoad = analysisType === "dynamic_structural";
  const showLoad = analysisType !== "modal_analysis";
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
        <ThumbnailDefs id={option.id} />
        {option.thumbnail === "bracket" && <BracketArt id={option.id} vibrating={vibrating} dynamicLoad={dynamicLoad} showLoad={showLoad} />}
        {option.thumbnail === "beam" && <BeamArt id={option.id} vibrating={vibrating} dynamicLoad={dynamicLoad} showLoad={showLoad} />}
        {option.thumbnail === "cantilever" && <CantileverArt id={option.id} vibrating={vibrating} dynamicLoad={dynamicLoad} showLoad={showLoad} />}
      </svg>
    </span>
  );
}

function ThumbnailDefs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`oc-top-${id}`} x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stopColor="#ccd8e1" />
        <stop offset="100%" stopColor="#8494a0" />
      </linearGradient>
      <linearGradient id={`oc-side-${id}`} x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stopColor="#90a0ac" />
        <stop offset="100%" stopColor="#54616c" />
      </linearGradient>
      <linearGradient id={`oc-end-${id}`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor="#6c7a86" />
        <stop offset="100%" stopColor="#3c4853" />
      </linearGradient>
      <linearGradient id={`oc-pay-top-${id}`} x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stopColor="#fcd34d" />
        <stop offset="100%" stopColor="#f59e0b" />
      </linearGradient>
      <linearGradient id={`oc-pay-side-${id}`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor="#f59e0b" />
        <stop offset="100%" stopColor="#b45309" />
      </linearGradient>
      <linearGradient id={`oc-pay-end-${id}`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor="#d97706" />
        <stop offset="100%" stopColor="#92400e" />
      </linearGradient>
      <radialGradient id={`oc-shadow-${id}`}>
        <stop offset="0%" stopColor="#000000" stopOpacity="0.42" />
        <stop offset="100%" stopColor="#000000" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

function LoadArrow({ x, tipY, length, dynamic }: { x: number; tipY: number; length: number; dynamic: boolean }) {
  const topY = tipY - length;
  if (!dynamic) {
    return (
      <g className="sample-load">
        <line x1={x} y1={topY} x2={x} y2={tipY - 8} />
        <path d={`M${x - 6} ${tipY - 9} L${x + 6} ${tipY - 9} L${x} ${tipY} Z`} />
      </g>
    );
  }
  return (
    <g className="sample-load">
      <line x1={x} y1={topY + 8} x2={x} y2={tipY - 8} />
      <path d={`M${x - 6} ${tipY - 9} L${x + 6} ${tipY - 9} L${x} ${tipY} Z`} />
      <path d={`M${x - 6} ${topY + 9} L${x + 6} ${topY + 9} L${x} ${topY} Z`} />
    </g>
  );
}

function VibrationArcs({ x, y }: { x: number; y: number }) {
  return (
    <g className="sample-ghost">
      <path d={`M${x - 14} ${y - 7} q -5 7 0 14`} />
      <path d={`M${x + 14} ${y - 7} q 5 7 0 14`} />
    </g>
  );
}

function DynamicWaveBadge() {
  return <path className="sample-wave" d="M118 92 q4 -8 8 0 q4 8 8 0 q4 -8 8 0" />;
}

interface SampleArtProps {
  id: string;
  vibrating: boolean;
  dynamicLoad: boolean;
  showLoad: boolean;
}

function BracketArt({ id, vibrating, dynamicLoad, showLoad }: SampleArtProps) {
  return (
    <g>
      <ellipse className="sample-shadow" cx="74" cy="92" rx="52" ry="9" fill={`url(#oc-shadow-${id})`} />
      {/* base flange */}
      <path className="sample-face" fill={`url(#oc-end-${id})`} d="M28 67 L55 80 L55 88 L28 75 Z" />
      <path className="sample-face" fill={`url(#oc-side-${id})`} d="M55 80 L119 52 L119 60 L55 88 Z" />
      <path className="sample-face" fill={`url(#oc-top-${id})`} d="M28 67 L92 39 L119 52 L55 80 Z" />
      {/* vertical wall at the far end */}
      <path className="sample-face" fill={`url(#oc-end-${id})`} d="M75.8 29.5 L67.7 25.6 L67.7 49.6 L75.8 53.5 Z" />
      <path className="sample-face" fill={`url(#oc-end-${id})`} d="M100.1 18.9 L92 15 L92 39 L100.1 42.9 Z" />
      <path className="sample-face" fill={`url(#oc-side-${id})`} d="M75.8 53.5 L100.1 42.9 L100.1 18.9 L75.8 29.5 Z" />
      <path className="sample-face" fill={`url(#oc-top-${id})`} d="M75.8 29.5 L100.1 18.9 L92 15 L67.7 25.6 Z" />
      {/* gusset running down to the base */}
      <path className="sample-face" fill={`url(#oc-top-${id})`} d="M75.8 33 L50.2 64.7 L75.8 53.5 Z" />
      {/* bolt holes with support rings */}
      <ellipse className="sample-hole" cx="50.6" cy="70.8" rx="5" ry="2.8" transform="rotate(-24 50.6 70.8)" />
      <ellipse className="sample-hole" cx="68.5" cy="63" rx="5" ry="2.8" transform="rotate(-24 68.5 63)" />
      <ellipse className="sample-support-ring" cx="50.6" cy="70.8" rx="7.6" ry="4.4" transform="rotate(-24 50.6 70.8)" />
      <ellipse className="sample-support-ring" cx="68.5" cy="63" rx="7.6" ry="4.4" transform="rotate(-24 68.5 63)" />
      {vibrating && <VibrationArcs x={84} y={11} />}
      {vibrating && <DynamicWaveBadge />}
      {showLoad && <LoadArrow x={84} tipY={22} length={dynamicLoad ? 18 : 16} dynamic={dynamicLoad} />}
    </g>
  );
}

function BeamArt({ id, vibrating, dynamicLoad, showLoad }: SampleArtProps) {
  return (
    <g>
      <ellipse className="sample-shadow" cx="78" cy="90" rx="58" ry="9" fill={`url(#oc-shadow-${id})`} />
      {/* beam */}
      <path className="sample-face" fill={`url(#oc-side-${id})`} d="M42 69 L134 41 L134 59 L42 87 Z" />
      <path className="sample-face" fill={`url(#oc-top-${id})`} d="M20 57 L112 29 L134 41 L42 69 Z" />
      {/* fixed end face */}
      <path className="sample-face" fill={`url(#oc-end-${id})`} d="M20 57 L42 69 L42 87 L20 75 Z" />
      <path className="sample-fixed-face" d="M20 57 L42 69 L42 87 L20 75 Z" />
      <g className="sample-hatch">
        <path d="M24 75 L34 64" />
        <path d="M27 81 L40 69" />
        <path d="M33 86 L42 77" />
      </g>
      {/* payload mass at free end */}
      <path className="sample-face" fill={`url(#oc-pay-end-${id})`} d="M92.1 23.5 L104.2 30.1 L104.2 45.1 L92.1 38.5 Z" />
      <path className="sample-face" fill={`url(#oc-pay-side-${id})`} d="M104.2 30.1 L122.6 24.5 L122.6 39.5 L104.2 45.1 Z" />
      <path className="sample-face" fill={`url(#oc-pay-top-${id})`} d="M92.1 23.5 L110.5 17.9 L122.6 24.5 L104.2 30.1 Z" />
      {vibrating && <VibrationArcs x={107} y={10} />}
      {vibrating && <DynamicWaveBadge />}
      {showLoad && <LoadArrow x={107} tipY={16} length={dynamicLoad ? 14 : 12} dynamic={dynamicLoad} />}
    </g>
  );
}

function CantileverArt({ id, vibrating, dynamicLoad, showLoad }: SampleArtProps) {
  return (
    <g>
      <ellipse className="sample-shadow" cx="82" cy="93" rx="56" ry="8" fill={`url(#oc-shadow-${id})`} />
      {/* fixed wall */}
      <path className="sample-face" fill={`url(#oc-top-${id})`} d="M24 22 L50 38 L42.3 40.3 L16.3 24.3 Z" />
      <path className="sample-face" fill={`url(#oc-side-${id})`} d="M24 22 L50 38 L50 92 L24 76 Z" />
      <path className="sample-fixed-face" d="M24 22 L50 38 L50 92 L24 76 Z" />
      <g className="sample-hatch">
        <path d="M27 33 L45 51" />
        <path d="M27 49 L45 67" />
        <path d="M27 65 L45 83" />
      </g>
      {/* beam */}
      <path className="sample-face" fill={`url(#oc-end-${id})`} d="M122 27 L138 36 L138 54 L122 45 Z" />
      <path className="sample-face" fill={`url(#oc-side-${id})`} d="M50 60 L138 36 L138 54 L50 78 Z" />
      <path className="sample-face" fill={`url(#oc-top-${id})`} d="M34 51 L122 27 L138 36 L50 60 Z" />
      {vibrating && <VibrationArcs x={130} y={15} />}
      {vibrating && <DynamicWaveBadge />}
      {showLoad && <LoadArrow x={130} tipY={29} length={dynamicLoad ? 23 : 21} dynamic={dynamicLoad} />}
    </g>
  );
}

function sampleMetaForAnalysis(option: SampleOption, analysisType: SampleAnalysisType): { support: string; action: string } {
  if (analysisType === "modal_analysis") return { support: option.support, action: "6 natural modes" };
  if (analysisType === "steady_state_thermal") return { support: "20 °C reference", action: "10 kW/m² heat flux" };
  return { support: option.support, action: option.load };
}
