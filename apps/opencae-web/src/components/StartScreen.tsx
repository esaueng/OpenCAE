interface StartScreenProps {
  onLoadSample: () => void;
  onCreateProject: () => void;
  onOpenProject: () => void;
}

export function StartScreen({ onLoadSample, onCreateProject, onOpenProject }: StartScreenProps) {
  return (
    <main
      className="start-screen"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onLoadSample();
      }}
    >
      <div className="start-top">
        <span className="version-chip">v0.1.0-mvp</span>
        <span>local mode</span>
      </div>
      <section className="start-brand" aria-labelledby="opencae-title">
        <OpenCaeMark className="start-mark" />
        <h1 id="opencae-title">OpenCAE</h1>
        <p className="start-tagline">open structural simulation</p>
        <div className="start-actions">
          <button className="start-action primary" onClick={() => onLoadSample()}>
            <span>
              <strong>Load sample project</strong>
              <small>Bracket demo · full workflow preview</small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
          <button className="start-action secondary" onClick={() => onCreateProject()}>
            <span>Create new project</span>
            <kbd>⌘ N</kbd>
          </button>
          <button className="start-action secondary" onClick={() => onOpenProject()}>
            <span>Open local project</span>
            <kbd>⌘ O</kbd>
          </button>
        </div>
        <p className="start-caption">OpenCAE helps you test how parts respond to forces. Start with the sample project to see a complete example.</p>
      </section>
      <footer className="start-footer">
        <span>./data/artifacts · SQLite · in-memory jobs</span>
        <span>docs · examples · github</span>
      </footer>
    </main>
  );
}

function OpenCaeMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 56 56" role="img" aria-label="OpenCAE mark">
      <path d="M28 5 48 16.5v23L28 51 8 39.5v-23L28 5Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M18 22.5 28 17l10 5.5v11L28 39l-10-5.5v-11Z" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.8" />
      <path d="M28 17v22M18 22.5l10 5.5 10-5.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
    </svg>
  );
}
