import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SampleAnalysisType, SampleModelId } from "../lib/api";
import { getOfflineReadiness, offlineReadinessLabel, subscribeOfflineReadiness } from "../lib/offlineStatus";
import { OpenCaeLogoMark } from "./OpenCaeLogoMark";
import { SampleOptionCard } from "./SampleOptionCard";
import { SAMPLE_ANALYSIS_OPTIONS } from "./sampleAnalysisOptions";
import { SAMPLE_OPTIONS } from "./sampleOptions";
import { defaultRecentProjectService, isRecentProjectsSupported, pickRecentProjectFile, projectNameFromFile, requestRecentProjectFile, type RecentProjectEntry, type RecentProjectFileHandle, type RecentProjectService } from "../recentProjects";

interface StartScreenProps {
  onLoadSample: (sample?: SampleModelId, analysisType?: SampleAnalysisType) => void;
  onCreateProject: () => void;
  onOpenProject: (file: File, handle?: RecentProjectFileHandle) => void | Promise<void>;
}

export function StartScreen({ onLoadSample, onCreateProject, onOpenProject }: StartScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Truthful cache state (see lib/offlineStatus.ts): "Offline-ready" only
  // once the service worker reports every precached asset (wasm included) in
  // cache; nothing at all when there is no service worker.
  const offlineReadiness = useSyncExternalStore(subscribeOfflineReadiness, getOfflineReadiness, getOfflineReadiness);
  const offlineLabel = offlineReadinessLabel(offlineReadiness);
  const [selectedSample, setSelectedSample] = useState<SampleModelId>("bracket");
  const [selectedAnalysisType, setSelectedAnalysisType] = useState<SampleAnalysisType>("static_stress");
  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>([]);
  const [recentsAvailable, setRecentsAvailable] = useState(() => isRecentProjectsSupported());
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentBusyId, setRecentBusyId] = useState<string | null>(null);
  const recentServiceRef = useRef<RecentProjectService | null>(null);
  if (!recentServiceRef.current) recentServiceRef.current = defaultRecentProjectService();

  useEffect(() => {
    if (!recentsAvailable) return undefined;
    let cancelled = false;
    void recentServiceRef.current!.list().then((entries) => {
      if (!cancelled) setRecentProjects(entries);
    }).catch((error) => {
      if (cancelled) return;
      setRecentsAvailable(false);
      setRecentError(messageFromError(error, "Recent Projects is unavailable."));
    });
    return () => { cancelled = true; };
  }, [recentsAvailable]);

  function loadSelectedSample(sample = selectedSample) {
    onLoadSample(sample, selectedAnalysisType);
  }

  async function openValidatedProject(file: File, handle?: RecentProjectFileHandle) {
    setRecentError(null);
    const projectName = await projectNameFromFile(file);
    if (handle && recentsAvailable) {
      try {
        setRecentProjects(await recentServiceRef.current!.add(handle, { filename: file.name, projectName }));
      } catch (error) {
        setRecentsAvailable(false);
        setRecentError(messageFromError(error, "Recent Projects could not be updated."));
      }
    }
    await onOpenProject(file, handle);
  }

  async function chooseLocalProject() {
    if (!recentsAvailable) {
      fileInputRef.current?.click();
      return;
    }
    setRecentBusyId("picker");
    setRecentError(null);
    try {
      const selected = await pickRecentProjectFile();
      if (selected !== "cancelled") await openValidatedProject(selected.file, selected.handle);
    } catch (error) {
      setRecentError(messageFromError(error, "Could not open the selected project."));
    } finally {
      setRecentBusyId(null);
    }
  }

  async function openRecentProject(entry: RecentProjectEntry) {
    setRecentBusyId(entry.id);
    setRecentError(null);
    try {
      const file = await requestRecentProjectFile(entry);
      await openValidatedProject(file, entry.handle);
    } catch (error) {
      setRecentError(messageFromError(error, `Could not open ${entry.filename}.`));
    } finally {
      setRecentBusyId(null);
    }
  }

  async function removeRecentProject(id: string) {
    setRecentError(null);
    try {
      setRecentProjects(await recentServiceRef.current!.remove(id));
    } catch (error) {
      setRecentError(messageFromError(error, "Could not remove the recent project."));
    }
  }

  async function clearRecentProjects() {
    setRecentError(null);
    try {
      await recentServiceRef.current!.clear();
      setRecentProjects([]);
    } catch (error) {
      setRecentError(messageFromError(error, "Could not clear Recent Projects."));
    }
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
          void chooseLocalProject();
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
              <button className="start-action secondary" disabled={recentBusyId === "picker"} onClick={() => void chooseLocalProject()}>
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
                  if (file) void openValidatedProject(file).catch((error) => setRecentError(messageFromError(error, "Could not open the selected project.")));
                }}
              />
            </div>
            {recentsAvailable && (
              <RecentProjectsSection
                entries={recentProjects}
                busyId={recentBusyId}
                onOpen={(entry) => void openRecentProject(entry)}
                onRemove={(id) => void removeRecentProject(id)}
                onClear={() => void clearRecentProjects()}
              />
            )}
            {recentError && <p className="start-inline-error" role="alert">{recentError}</p>}
            <p className="start-caption">
              <span>OpenCAE helps you test how parts respond to forces.</span>
              <span>Start with the sample project to see a complete example.</span>
            </p>
          </>
        )}
      </section>
      <footer className="start-footer">
        <span className="local-runtime">
          Runs locally
          {offlineLabel ? (
            <span className="offline-readiness" role="status">
              {` · ${offlineLabel}`}
            </span>
          ) : null}
        </span>
        <a className="start-credit" href="https://esauengineering.com/" target="_blank" rel="noreferrer">
          Built by Esau Engineering
        </a>
        <a className="start-github" href="https://github.com/esaueng/OpenCAE" target="_blank" rel="noreferrer">github</a>
      </footer>
    </main>
  );
}

export function RecentProjectsSection({
  entries,
  busyId,
  onOpen,
  onRemove,
  onClear
}: {
  entries: RecentProjectEntry[];
  busyId: string | null;
  onOpen: (entry: RecentProjectEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section className="recent-projects" aria-label="Recent Projects">
      <div className="recent-projects-header">
        <h2>Recent Projects</h2>
        {entries.length > 0 && <button type="button" onClick={onClear}>Clear List</button>}
      </div>
      {entries.length === 0 ? <p>No recent project files yet.</p> : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              <span><strong>{entry.projectName}</strong><small>{entry.filename}</small></span>
              <button type="button" disabled={busyId !== null} onClick={() => onOpen(entry)}>{busyId === entry.id ? "Opening…" : "Open"}</button>
              <button type="button" aria-label={`Remove ${entry.projectName} from Recent Projects`} disabled={busyId !== null} onClick={() => onRemove(entry.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
      </div>
      <div className="start-sample-setup" aria-label="Sample setup">
        <div className="start-sample-header">
          <span>Sample model</span>
          <div className="segmented analysis-type sample-analysis-type-grid start-analysis-type" role="group" aria-label="Analysis type">
            {SAMPLE_ANALYSIS_OPTIONS.map((option) => (
              <button
                key={option.id}
                className={selectedAnalysisType === option.id ? "active" : ""}
                type="button"
                aria-pressed={selectedAnalysisType === option.id}
                onClick={() => onSelectAnalysisType(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sample-option-grid start-sample-grid" role="group" aria-label="Sample model">
          {SAMPLE_OPTIONS.map((option) => (
            <SampleOptionCard
              key={option.id}
              option={option}
              selected={selectedSample === option.id}
              analysisType={selectedAnalysisType}
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
