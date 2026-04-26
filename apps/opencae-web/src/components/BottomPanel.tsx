import { useState, type MouseEvent } from "react";
import { REQUIRED_SETTING_HELP_IDS, SETTING_HELP, type SettingHelpVisual } from "../settingHelp";

interface BottomPanelProps {
  status: string;
  logs: string[];
  projectName: string;
  studyName: string;
  meshStatus: string;
  solverStatus: string;
}

export function BottomPanel({ status, logs, projectName, studyName, meshStatus, solverStatus }: BottomPanelProps) {
  const [tab, setTab] = useState<"tips" | "logs" | null>(null);
  const expanded = tab !== null;
  const healthy = solverStatus === "Running" ? "running" : meshStatus === "Ready" ? "ready" : "warning";

  function selectTab(nextTab: NonNullable<typeof tab>, event: MouseEvent<HTMLButtonElement>) {
    if (tab === nextTab) {
      setTab(null);
      event.currentTarget.blur();
      return;
    }
    setTab(nextTab);
  }

  return (
    <footer className={`bottom-panel ${expanded ? "expanded" : ""}`}>
      {expanded && tab === "logs" && (
        <div className="bottom-content">
          <pre>
            {logs.map((entry, index) => {
              const level = entry.toLowerCase().includes("complete") || entry.toLowerCase().includes("generated") ? "OK" : "INFO";
              return `${new Date(Date.now() - index * 15000).toLocaleTimeString([], { hour12: false })} ${level.padEnd(4, " ")} ${entry}`;
            }).join("\n")}
          </pre>
        </div>
      )}
      {expanded && tab === "tips" && (
        <div className="bottom-content tips-content">
          <div className="tips-drawer-header">
            <span>Settings tips</span>
            <strong>{REQUIRED_SETTING_HELP_IDS.length} guides</strong>
          </div>
          <div className="tips-grid">
            {REQUIRED_SETTING_HELP_IDS.map((helpId) => {
              const help = SETTING_HELP[helpId];
              return (
                <article className="tip-card" key={helpId}>
                  <TipVisual kind={help.visual} />
                  <span>
                    <strong>{help.title}</strong>
                    <small>{help.body}</small>
                  </span>
                </article>
              );
            })}
          </div>
        </div>
      )}
      <div className="status-strip">
        <div className="status-tabs">
          {(["tips", "logs"] as const).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={(event) => selectTab(item, event)}>
              {item[0]?.toUpperCase()}{item.slice(1)}
              {item === "logs" && <span className="count-pill">{logs.length}</span>}
            </button>
          ))}
        </div>
        <div className="status-groups" aria-label="Local status">
          <span className={`status-state ${healthy}`}><i />{statusForDisplay(status, solverStatus)}</span>
          <span><b>project</b>{projectName}</span>
          <span><b>study</b>{studyName}</span>
          <span><b>mesh</b>{meshStatus}</span>
          <span><b>solver</b>{solverStatus}</span>
        </div>
      </div>
    </footer>
  );
}

function TipVisual({ kind }: { kind: SettingHelpVisual }) {
  return (
    <span className={`help-visual ${kind}`} aria-hidden="true">
      <span className="help-part" />
      <span className="help-force" />
      <span className="help-grid" />
    </span>
  );
}

function statusForDisplay(status: string, solverStatus: string) {
  if (solverStatus === "Running") return "Simulating";
  if (status.toLowerCase().includes("complete")) return "Results ready";
  return "Ready";
}
