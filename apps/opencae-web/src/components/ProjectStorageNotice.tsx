import { CloudUpload, HardDrive, ShieldCheck } from "lucide-react";
import type { CloudBackupPreference } from "../cloudBackup";

interface ProjectStorageNoticeProps {
  preference: CloudBackupPreference | null;
  busy: boolean;
  onChooseCloud: () => void;
  onChooseLocal: () => void;
}

export function ProjectStorageNotice({ preference, busy, onChooseCloud, onChooseLocal }: ProjectStorageNoticeProps) {
  const title = preference === "cloud"
    ? "Encrypted recovery is on"
    : preference === "local"
      ? "This project stays local"
      : "Choose how to protect this project";
  const description = preference === "cloud"
    ? "When the complete project cannot fit in browser autosave, OpenCAE keeps an encrypted recovery copy for 30 days. Simulation still runs locally."
    : preference === "local"
      ? "OpenCAE will not upload recovery data. Use Save project whenever you need a complete file outside this browser."
      : "The complete project is larger than browser autosave can hold. Pick a recovery option without leaving or blocking the workspace.";

  return (
    <aside className="storage-recovery-card" id="project-storage-notice" aria-labelledby="project-storage-title">
      <header className="storage-recovery-header">
        <span className="storage-recovery-mark" aria-hidden="true"><ShieldCheck size={18} /></span>
        <span>
          <small>Project storage</small>
          <strong id="project-storage-title">{title}</strong>
        </span>
      </header>
      <p>{description}</p>
      <div className="storage-recovery-facts" aria-label="Encrypted recovery details">
        <span>Encrypted in this browser</span>
        <span>Deleted after 30 days</span>
      </div>
      <div className="storage-recovery-actions">
        <button
          className={`storage-choice cloud ${preference === "cloud" ? "selected" : ""}`}
          type="button"
          aria-pressed={preference === "cloud"}
          disabled={busy}
          onClick={onChooseCloud}
        >
          <CloudUpload size={17} aria-hidden="true" />
          <span>
            <strong>{busy ? "Saving recovery…" : "Encrypted recovery"}</strong>
            <small>Private cloud backup</small>
          </span>
        </button>
        <button
          className={`storage-choice local ${preference === "local" ? "selected" : ""}`}
          type="button"
          aria-pressed={preference === "local"}
          disabled={busy}
          onClick={onChooseLocal}
        >
          <HardDrive size={17} aria-hidden="true" />
          <span>
            <strong>Local only</strong>
            <small>Save complete files manually</small>
          </span>
        </button>
      </div>
      <small className="storage-recovery-footnote">Remembered in this browser. Change it anytime from Storage in the toolbar.</small>
    </aside>
  );
}
