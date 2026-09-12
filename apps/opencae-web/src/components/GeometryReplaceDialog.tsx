import { AlertTriangle, X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatGeometryReplacementLosses } from "../geometryReplacement";

interface GeometryReplaceDialogProps {
  open: boolean;
  /** What is about to happen, e.g. `Replace the model with cube20.stl`. */
  actionLabel: string;
  losses: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm-before-destroy for geometry replacement (2026-09 review D5).
 * Uploading or generating a part resets the whole study setup; this names
 * what will be cleared and gives the user a way out.
 */
export function GeometryReplaceDialog({ open, actionLabel, losses, onConfirm, onCancel }: GeometryReplaceDialogProps) {
  const dialogRef = useFocusTrap<HTMLElement>(open, onCancel);
  if (!open) return null;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section ref={dialogRef} className="workflow-modal geometry-replace-dialog" role="dialog" aria-modal="true" aria-labelledby="geometry-replace-title" aria-describedby="geometry-replace-copy">
        <header className="workflow-modal-header">
          <h2 id="geometry-replace-title">Replace the model?</h2>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="Keep the current model">
            <X size={18} />
          </button>
        </header>
        <div className="geometry-replace-body">
          <p className="panel-warning" id="geometry-replace-copy">
            <AlertTriangle size={16} aria-hidden="true" />
            {actionLabel} clears {formatGeometryReplacementLosses(losses)}. Supports and loads are tied to the current faces and cannot be carried over.
          </p>
          <p className="muted">Save the project first if you want to come back to this setup.</p>
        </div>
        <footer className="workflow-modal-footer">
          <button className="secondary" type="button" onClick={onCancel}>Keep current model</button>
          <button className="primary" type="button" onClick={onConfirm}>Replace and clear setup</button>
        </footer>
      </section>
    </div>
  );
}
