import { Component, type ErrorInfo, type ReactNode } from "react";
import { hasAutosavedWorkspace } from "../autosaveStorage";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  autosavePresent: boolean;
}

function autosaveIsPresent(): boolean {
  try {
    return hasAutosavedWorkspace();
  } catch {
    return false;
  }
}

/**
 * The app had no error boundary at all: a throw anywhere under <App> — the viewer's
 * Three/WASM stack, or a rejected chunk import against a stale service worker — unmounted
 * the tree to a blank document with no message, no way back, and no hint that the work was
 * still on disk.
 *
 * The fallback deliberately does three things a blank page cannot: name what failed, offer
 * the one action that fixes a chunk mismatch, and say whether the autosaved project is
 * still there. It reads the autosave once, when the error is caught, because by the time
 * the fallback renders the app state it described is already gone.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, autosavePresent: false };

  // Read here, not in componentDidCatch: React renders the fallback between deriving state
  // and calling componentDidCatch, so anything stashed there arrives a render too late and
  // the card tells the user their work is gone when it is not.
  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, autosavePresent: autosaveIsPresent() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack in the console; the fallback shows only the message.
    console.error("OpenCAE crashed", error, info.componentStack);
  }

  render() {
    const { error, autosavePresent } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="app-crash" role="alert">
        <div className="app-crash-card">
          <p className="app-crash-eyebrow">OpenCAE stopped</p>
          <h1>Something in the app crashed.</h1>
          <p className="app-crash-copy">
            {autosavePresent
              ? "Your project is still autosaved in this browser and should come back when you reload."
              : "There is no autosaved project in this browser, so reloading will start from the home screen."}
          </p>
          <div className="app-crash-actions">
            <button className="primary" type="button" onClick={() => window.location.reload()}>
              Reload OpenCAE
            </button>
          </div>
          <p className="app-crash-detail">
            <span>Reported error</span>
            <code>{error.message || String(error)}</code>
          </p>
          <p className="app-crash-footnote">
            If it keeps happening, the full details are in the browser console.
          </p>
        </div>
      </main>
    );
  }
}
