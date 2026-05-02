import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Github, MessageSquare } from "lucide-react";
import { REQUIRED_SETTING_HELP_IDS, SETTING_HELP, type SettingHelpVisual } from "../settingHelp";

interface BottomPanelProps {
  status: string;
  logs: string[];
  projectName: string;
  studyName: string;
  meshStatus: string;
  solverStatus: string;
}

export const WORKSPACE_SHORTCUT_GUIDE: Array<{ keys: string[]; label: string }> = [
  { keys: ["N"], label: "Next workflow step" },
  { keys: ["B"], label: "Previous workflow step" },
  { keys: ["H"], label: "Fit view / home view" },
  { keys: ["Ctrl/Cmd", "S"], label: "Save project" },
  { keys: ["Ctrl/Cmd", "Z"], label: "Undo" },
  { keys: ["Shift", "Ctrl/Cmd", "Z"], label: "Redo" }
];

export function BottomPanel({ status, logs, projectName, studyName, meshStatus, solverStatus }: BottomPanelProps) {
  const [tab, setTab] = useState<"tips" | "logs" | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(320);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
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

  function startDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragStart.current = { y: event.clientY, height: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDrawer(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current) return;
    const maxHeight = Math.max(260, window.innerHeight - 120);
    const nextHeight = dragStart.current.height + dragStart.current.y - event.clientY;
    setDrawerHeight(Math.min(maxHeight, Math.max(260, nextHeight)));
  }

  function stopDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <footer className={`bottom-panel ${expanded ? "expanded" : ""}`}>
      {expanded && tab === "logs" && (
        <div className="bottom-content" style={{ height: drawerHeight }}>
          <button
            type="button"
            className="bottom-resize-handle"
            aria-label="Resize drawer"
            title="Drag up to resize"
            onPointerDown={startDrawerResize}
            onPointerMove={resizeDrawer}
            onPointerUp={stopDrawerResize}
            onPointerCancel={stopDrawerResize}
          />
          <pre>
            {logs.map((entry, index) => {
              const level = entry.toLowerCase().includes("complete") || entry.toLowerCase().includes("generated") ? "OK" : "INFO";
              return `${new Date(Date.now() - index * 15000).toLocaleTimeString([], { hour12: false })} ${level.padEnd(4, " ")} ${entry}`;
            }).join("\n")}
          </pre>
        </div>
      )}
      {expanded && tab === "tips" && (
        <div className="bottom-content tips-content" style={{ height: drawerHeight }}>
          <button
            type="button"
            className="bottom-resize-handle"
            aria-label="Resize tips drawer"
            title="Drag up to resize"
            onPointerDown={startDrawerResize}
            onPointerMove={resizeDrawer}
            onPointerUp={stopDrawerResize}
            onPointerCancel={stopDrawerResize}
          />
          <div className="tips-drawer-header">
            <span>Settings tips</span>
            <strong>{REQUIRED_SETTING_HELP_IDS.length} guides</strong>
          </div>
          <KeyboardShortcutGuide />
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
          <span className="local-pill"><span aria-hidden="true" />local</span>
          <span><b>project</b>{projectName}</span>
          <span><b>study</b>{studyName}</span>
          <span><b>mesh</b>{meshStatus}</span>
          <span><b>solver</b>{solverStatus}</span>
        </div>
        <div className="status-links" aria-label="Project links">
          <a className="status-link" href="https://form.esauengineering.com/opencae-feedback" target="_blank" rel="noreferrer">
            <MessageSquare size={13} aria-hidden="true" />
            feedback
          </a>
          <a className="status-link" href="https://github.com/esaueng/OpenCAE" target="_blank" rel="noreferrer">
            <Github size={13} aria-hidden="true" />
            github
          </a>
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

export function KeyboardShortcutGuide() {
  return (
    <section className="shortcut-guide" aria-labelledby="shortcut-guide-title">
      <div className="shortcut-guide-header">
        <strong id="shortcut-guide-title">Keyboard shortcuts</strong>
        <span>Workspace</span>
      </div>
      <div className="shortcut-list">
        {WORKSPACE_SHORTCUT_GUIDE.map((shortcut) => (
          <div className="shortcut-item" key={`${shortcut.keys.join("+")}-${shortcut.label}`}>
            <span className="shortcut-keys">
              {shortcut.keys.map((key, index) => (
                <span className="shortcut-key" key={`${shortcut.label}-${key}-${index}`}>
                  {index > 0 && <span aria-hidden="true">+</span>}
                  <kbd>{key}</kbd>
                </span>
              ))}
            </span>
            <span>{shortcut.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function statusForDisplay(status: string, solverStatus: string) {
  if (solverStatus === "Running") return "Simulating";
  if (status.toLowerCase().includes("complete")) return "Results ready";
  return "Ready";
}
