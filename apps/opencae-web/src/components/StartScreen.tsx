import { useRef, useState } from "react";
import type { SampleAnalysisType, SampleModelId } from "../lib/api";
import { OpenCaeLogoMark } from "./OpenCaeLogoMark";
import { SampleOptionCard } from "./SampleOptionCard";
import { SAMPLE_OPTIONS } from "./sampleOptions";

interface StartScreenProps {
  onLoadSample: (sample?: SampleModelId, analysisType?: SampleAnalysisType) => void;
  onCreateProject: () => void;
  onOpenProject: (file: File) => void;
}

export function StartScreen({ onLoadSample, onCreateProject, onOpenProject }: StartScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedSample, setSelectedSample] = useState<SampleModelId>("bracket");
  const [selectedAnalysisType, setSelectedAnalysisType] = useState<SampleAnalysisType>("static_stress");
  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);

  function loadSelectedSample(sample = selectedSample) {
    onLoadSample(sample, selectedAnalysisType);
  }

  return (
    <main
      className="start-screen"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Escape" && sampleMenuOpen) {
          event.preventDefault();
          setSampleMenuOpen(false);
        }
        if (event.key === "Enter" && event.target === event.currentTarget) {
          if (sampleMenuOpen) loadSelectedSample();
          else setSampleMenuOpen(true);
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "n") {
          event.preventDefault();
          onCreateProject();
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "o") {
          event.preventDefault();
          fileInputRef.current?.click();
        }
      }}
    >
      <section className={`start-brand ${sampleMenuOpen ? "sample-menu-open" : ""}`} aria-labelledby="opencae-title">
        <OpenCaeLogoMark className="start-mark" title="OpenCAE mark" />
        <h1 id="opencae-title">OpenCAE</h1>
        <p className="start-tagline">open structural simulation</p>
        {sampleMenuOpen ? (
          <SampleProjectMenu
            selectedSample={selectedSample}
            selectedAnalysisType={selectedAnalysisType}
            onBack={() => setSampleMenuOpen(false)}
            onLoadSample={(sample) => loadSelectedSample(sample)}
            onSelectAnalysisType={setSelectedAnalysisType}
            onSelectSample={setSelectedSample}
          />
        ) : (
          <>
            <div className="start-actions">
              <button className="start-action secondary" onClick={() => onCreateProject()}>
                <span>Create new project</span>
                <kbd>N</kbd>
              </button>
              <button className="start-action secondary" onClick={() => fileInputRef.current?.click()}>
                <span>Open local project</span>
                <kbd>O</kbd>
              </button>
              <button className="start-action primary sample-action" aria-label="Open sample menu" onClick={() => setSampleMenuOpen(true)}>
                <span>
                  <strong>Load sample project</strong>
                  <small>Choose a sample model and analysis type</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept=".json,.opencae,.opencae.json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) onOpenProject(file);
                }}
              />
            </div>
            <p className="start-caption">
              <span>OpenCAE helps you test how parts respond to forces.</span>
              <span>Start with the sample project to see a complete example.</span>
            </p>
          </>
        )}
      </section>
      <footer className="start-footer">
        <span className="local-runtime">Runs locally</span>
        <a className="start-credit" href="https://esauengineering.com/" target="_blank" rel="noreferrer">
          Built by Esau Engineering
        </a>
        <a className="start-github" href="https://github.com/esaueng/OpenCAE" target="_blank" rel="noreferrer">github</a>
      </footer>
    </main>
  );
}

interface SampleProjectMenuProps {
  selectedSample: SampleModelId;
  selectedAnalysisType: SampleAnalysisType;
  onBack: () => void;
  onLoadSample: (sample?: SampleModelId) => void;
  onSelectAnalysisType: (analysisType: SampleAnalysisType) => void;
  onSelectSample: (sample: SampleModelId) => void;
}

export function SampleProjectMenu({ selectedSample, selectedAnalysisType, onBack, onLoadSample, onSelectAnalysisType, onSelectSample }: SampleProjectMenuProps) {
  return (
    <div className="start-sample-menu">
      <div className="start-sample-menu-bar">
        <button className="start-menu-back" type="button" onClick={onBack}>Back</button>
        <span>Sample model</span>
      </div>
      <div className="start-sample-setup" aria-label="Sample setup">
        <div className="start-sample-header">
          <span>Sample model</span>
          <div className="segmented analysis-type start-analysis-type" role="group" aria-label="Analysis type">
            <button className={selectedAnalysisType === "static_stress" ? "active" : ""} type="button" onClick={() => onSelectAnalysisType("static_stress")}>Static</button>
            <button className={selectedAnalysisType === "dynamic_structural" ? "active" : ""} type="button" onClick={() => onSelectAnalysisType("dynamic_structural")}>Dynamic</button>
          </div>
        </div>
        <div className="sample-option-grid start-sample-grid" role="list" aria-label="Sample model">
          {SAMPLE_OPTIONS.map((option) => (
            <SampleOptionCard
              key={option.id}
              option={option}
              selected={selectedSample === option.id}
              onSelect={onSelectSample}
              onOpen={onLoadSample}
            />
          ))}
        </div>
      </div>
      <button className="start-action primary sample-action start-menu-load" onClick={() => onLoadSample(selectedSample)}>
        <span>
          <strong>Load sample project</strong>
          <small>Use selected model and analysis type</small>
        </span>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
