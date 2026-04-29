import { useRef } from "react";
import type { SampleAnalysisType, SampleModelId } from "../lib/api";
import { OpenCaeLogoMark } from "./OpenCaeLogoMark";

interface StartScreenProps {
  onLoadSample: (sample?: SampleModelId, analysisType?: SampleAnalysisType) => void;
  onCreateProject: () => void;
  onOpenProject: (file: File) => void;
}

export function StartScreen({ onLoadSample, onCreateProject, onOpenProject }: StartScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <main
      className="start-screen"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onLoadSample();
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
      <section className="start-brand" aria-labelledby="opencae-title">
        <OpenCaeLogoMark className="start-mark" title="OpenCAE mark" />
        <h1 id="opencae-title">OpenCAE</h1>
        <p className="start-tagline">open structural simulation</p>
        <div className="start-actions">
          <button className="start-action secondary" onClick={() => onCreateProject()}>
            <span>Create new project</span>
            <kbd>N</kbd>
          </button>
          <button className="start-action secondary" onClick={() => fileInputRef.current?.click()}>
            <span>Open local project</span>
            <kbd>O</kbd>
          </button>
          <button className="start-action primary sample-action" onClick={() => onLoadSample()}>
            <span>
              <strong>Load sample project</strong>
              <small>Choose sample and analysis type next</small>
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
