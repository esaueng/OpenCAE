import { CloudUpload, HardDrive, ShieldCheck } from "lucide-react";
import type { CloudBackupPreference } from "../cloudBackup";

interface ProjectStorageNoticeProps {
  preference: CloudBackupPreference | null;
  busy: boolean;
  recoveryNeeded: boolean;
  onChooseCloud: () => void;
  onChooseLocal: () => void;
}

export function ProjectStorageNotice({ preference, busy, recoveryNeeded, onChooseCloud, onChooseLocal }: ProjectStorageNoticeProps) {
  const title = preference === "cloud"
    ? recoveryNeeded ? "Encrypted recovery is on" : "Encrypted recovery is ready"
    : preference === "local"
      ? "This project stays local"
      : recoveryNeeded ? "Choose how to protect this project" : "Choose your recovery preference";
  const description = preference === "cloud"
    ? recoveryNeeded
      ? "The complete project no longer fits in browser autosave, so OpenCAE will keep an encrypted recovery copy for 30 days. Simulation still runs locally."
      : "Browser autosave is active. If the complete project outgrows browser storage, OpenCAE will keep an encrypted recovery copy for 30 days."
    : preference === "local"
      ? "OpenCAE will not upload recovery data. Use Save project whenever you need a complete file outside this browser."
      : recoveryNeeded
        ? "The complete project is larger than browser autosave can hold. Pick a recovery option without leaving or blocking the workspace."
        : "Browser autosave is active for this project. Choose what OpenCAE should do if the complete project grows beyond the browser storage limit.";
  const recoveryFacts = preference === "local"
    ? ["No project upload", "Manual file saves"]
    : ["Encrypted in this browser", "Deleted after 30 days"];

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
      <div className="storage-recovery-facts" aria-label="Storage choice details">
        {recoveryFacts.map((fact) => <span key={fact}>{fact}</span>)}
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
