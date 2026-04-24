import { useState } from "react";

interface BottomPanelProps {
  status: string;
  logs: string[];
  projectName: string;
  studyName: string;
  meshStatus: string;
  solverStatus: string;
}

export function BottomPanel({ status, logs, projectName, studyName, meshStatus, solverStatus }: BottomPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"status" | "tips" | "logs" | "diagnostics">("status");
  const healthy = solverStatus === "Running" ? "running" : meshStatus === "Ready" ? "ready" : "warning";

  function selectTab(nextTab: typeof tab) {
    setTab(nextTab);
    setExpanded(nextTab === "logs" ? (value) => !value : false);
  }

  return (
    <footer className={`bottom-panel ${expanded ? "expanded" : ""}`}>
      {expanded && (
        <div className="bottom-content">
          <pre>
            {logs.map((entry, index) => {
              const level = entry.toLowerCase().includes("complete") || entry.toLowerCase().includes("generated") ? "OK" : "INFO";
              return `${new Date(Date.now() - index * 15000).toLocaleTimeString([], { hour12: false })} ${level.padEnd(4, " ")} ${entry}`;
            }).join("\n")}
          </pre>
        </div>
      )}
      <div className="status-strip">
        <div className="status-tabs">
          {(["status", "tips", "logs", "diagnostics"] as const).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>
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
        <span className="mock-backend">mock backend</span>
      </div>
    </footer>
  );
}

function statusForDisplay(status: string, solverStatus: string) {
  if (solverStatus === "Running") return "Simulating";
  if (status.toLowerCase().includes("complete")) return "Results ready";
  return "Ready";
}
