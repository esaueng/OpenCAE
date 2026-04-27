import { useRef } from "react";
import { OpenCaeLogoMark } from "./OpenCaeLogoMark";

interface StartScreenProps {
  onLoadSample: () => void;
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
      <div className="start-top">
        <span className="version-chip">v0.1.0-mvp</span>
        <span>local mode</span>
      </div>
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
              <small>Bracket demo · full workflow preview</small>
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
      <a className="start-credit" href="https://esauengineering.com/" target="_blank" rel="noreferrer">
        Built by Esau Engineering
      </a>
      <footer className="start-footer">
        <a href="https://github.com/esaueng/OpenCAE" target="_blank" rel="noreferrer">github</a>
      </footer>
    </main>
  );
}
