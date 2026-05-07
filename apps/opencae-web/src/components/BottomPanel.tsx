import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { Coffee, Github, MessageSquare } from "lucide-react";
import { REQUIRED_SETTING_HELP_IDS, SETTING_HELP, type SettingHelpVisual } from "../settingHelp";

interface BottomPanelProps {
  status: string;
  logs: string[];
  projectName: string;
  studyName: string;
  meshStatus: string;
  solverStatus: string;
  backendStatus: "local" | "cloud" | "core";
  onClearLogs: () => void;
}

export const WORKSPACE_SHORTCUT_GUIDE: Array<{ keys: string[]; label: string }> = [
  { keys: ["N"], label: "Next workflow step" },
  { keys: ["B"], label: "Previous workflow step" },
  { keys: ["H"], label: "Fit view / home view" },
  { keys: ["Ctrl/Cmd", "S"], label: "Save project" },
  { keys: ["Ctrl/Cmd", "Z"], label: "Undo" },
  { keys: ["Shift", "Ctrl/Cmd", "Z"], label: "Redo" }
];

export const COFFEE_ANIMATION_DURATION_MS = 1800;
export const COFFEE_ANIMATION_REPLAY_DELAY_MS = { min: 18000, max: 45000 } as const;
const COFFEE_LINK_TEXT = "Buy me a coffee";

export function coffeeAnimationReplayDelayMs(randomValue = Math.random()) {
  const safeRandomValue = Number.isFinite(randomValue) ? randomValue : 0;
  const boundedRandomValue = Math.min(1, Math.max(0, safeRandomValue));
  const delayRange = COFFEE_ANIMATION_REPLAY_DELAY_MS.max - COFFEE_ANIMATION_REPLAY_DELAY_MS.min;
  return Math.round(COFFEE_ANIMATION_REPLAY_DELAY_MS.min + delayRange * boundedRandomValue);
}

export function BottomPanel({ status, logs, projectName, studyName, meshStatus, solverStatus, backendStatus, onClearLogs }: BottomPanelProps) {
  const [tab, setTab] = useState<"tips" | "logs" | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(320);
  const [clearPromptVisible, setClearPromptVisible] = useState(false);
  const [coffeeAnimating, setCoffeeAnimating] = useState(false);
  const [coffeeAnimationRun, setCoffeeAnimationRun] = useState(0);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  const animationTimeoutRef = useRef(0);
  const replayTimeoutRef = useRef(0);
  const expanded = tab !== null;
  const displayStatus = statusForDisplay(status, solverStatus);
  const healthy = solverStatus === "Running" ? "running" : displayStatus.endsWith("error") ? "warning" : meshStatus === "Ready" ? "ready" : "warning";
  const formattedLogs = logs.map(formatLogEntry);
  const donateLinkClassName = `status-link donate-link${coffeeAnimating ? " coffee-animating" : ""}`;

  useEffect(() => {
    if (!clearPromptVisible) return undefined;
    const timeoutId = window.setTimeout(() => setClearPromptVisible(false), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [clearPromptVisible]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (prefersReducedCoffeeMotion()) return undefined;

    function scheduleCoffeeAnimation() {
      replayTimeoutRef.current = window.setTimeout(() => {
        runCoffeeAnimation();
        scheduleCoffeeAnimation();
      }, coffeeAnimationReplayDelayMs());
    }

    runCoffeeAnimation();
    scheduleCoffeeAnimation();

    return () => {
      window.clearTimeout(animationTimeoutRef.current);
      window.clearTimeout(replayTimeoutRef.current);
    };
  }, []);

  function prefersReducedCoffeeMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  }

  function runCoffeeAnimation() {
    if (typeof window === "undefined" || prefersReducedCoffeeMotion()) return;
    setCoffeeAnimationRun((run) => run + 1);
    setCoffeeAnimating(true);
    window.clearTimeout(animationTimeoutRef.current);
    animationTimeoutRef.current = window.setTimeout(() => setCoffeeAnimating(false), COFFEE_ANIMATION_DURATION_MS);
  }

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

  function copyLogs() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(formattedLogs.join("\n"));
  }

  function clearLogs(event: MouseEvent<HTMLButtonElement>) {
    if (!logs.length) return;
    if (resolveLogClearIntent(event.detail, clearPromptVisible) === "clear") {
      setClearPromptVisible(false);
      onClearLogs();
      event.currentTarget.blur();
      return;
    }
    setClearPromptVisible(true);
  }

  return (
    <footer className={`bottom-panel ${expanded ? "expanded" : ""}`}>
      {expanded && tab === "logs" && (
        <div className="bottom-content logs-content" style={{ height: drawerHeight }}>
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
          <div className="logs-drawer-header">
            <span>Run logs</span>
            <div className="logs-drawer-actions">
              <button type="button" className="log-copy-button" onClick={copyLogs}>Copy logs</button>
              <button
                type="button"
                className="log-clear-button"
                disabled={!logs.length}
                title="Double-click to clear run logs"
                aria-label="Clear logs. Double-click to clear."
                onClick={clearLogs}
              >
                {clearPromptVisible ? "Double-click to clear" : "Clear logs"}
              </button>
            </div>
          </div>
          <pre>{formattedLogs.join("\n")}</pre>
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
        <div className="status-groups" aria-label="Simulation status">
          <span className={`status-state ${healthy}`}><i />{displayStatus}</span>
          <span className="backend-pill"><span aria-hidden="true" />{backendStatus}</span>
          <span><b>project</b>{projectName}</span>
          <span><b>study</b>{studyName}</span>
          <span><b>mesh</b>{meshStatus}</span>
          <span><b>solver</b>{solverStatus}</span>
        </div>
        <div className="status-links" aria-label="Project links">
          <a className={donateLinkClassName} href="https://ko-fi.com/petergn" target="_blank" rel="noreferrer" title="Support OpenCAE on Ko-fi" onMouseEnter={runCoffeeAnimation}>
            <span className="coffee-mark" aria-hidden="true" key={`coffee-mark-${coffeeAnimationRun}`}>
              <span className="coffee-steam coffee-steam-one" />
              <span className="coffee-steam coffee-steam-two" />
              <Coffee size={13} aria-hidden="true" />
              <span className="coffee-sparkle" />
            </span>
            <span className="coffee-label" key={`coffee-label-${coffeeAnimationRun}`}>
              {COFFEE_LINK_TEXT.split("").map((letter, index) => (
                <span
                  className={letter === " " ? "coffee-letter coffee-letter-space" : "coffee-letter"}
                  key={`${letter}-${index}`}
                  style={{ "--coffee-letter-index": index } as CSSProperties}
                >
                  {letter}
                </span>
              ))}
            </span>
          </a>
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
  const normalized = status.toLowerCase();
  if (normalized.includes("cloud fea") && /(error|fail|failed|unavailable|not configured|not enabled|not ready)/.test(normalized)) return "Cloud FEA error";
  if (normalized.includes("opencae core") && /(error|fail|failed|unavailable|not configured|not enabled|not ready)/.test(normalized)) return "OpenCAE Core error";
  if (solverStatus === "Running") return "Simulating";
  if (status.toLowerCase().includes("complete")) return "Results ready";
  if (normalized.includes("cloud fea")) return "Cloud FEA active";
  if (normalized.includes("opencae core")) return "OpenCAE Core active";
  return "Ready";
}

export function resolveLogClearIntent(clickDetail: number, armed: boolean): "confirm" | "clear" {
  return armed || clickDetail >= 2 ? "clear" : "confirm";
}

function formatLogEntry(entry: string, index: number) {
  const normalized = entry.toLowerCase();
  const level = normalized.includes("complete") || normalized.includes("generated")
    ? "OK"
    : /(error|fail|failed|unavailable|not configured|not enabled)/.test(normalized)
      ? "ERR"
      : "INFO";
  return `${new Date(Date.now() - index * 15000).toLocaleTimeString([], { hour12: false })} ${level.padEnd(4, " ")} ${entry}`;
}
