import { lazy, Suspense, useState } from "react";
import { hasAutosavedWorkspace, readAutosavedThemeMode } from "./autosaveStorage";
import { StartScreen } from "./components/StartScreen";

type SampleModelId = "bracket" | "plate" | "cantilever";
type SampleAnalysisType = "static_stress" | "dynamic_structural" | "modal_analysis" | "steady_state_thermal";

export type WorkspaceInitialAction =
  | { type: "loadSample"; sample?: SampleModelId; analysisType?: SampleAnalysisType }
  | { type: "createProject" }
  | { type: "openProject"; file: File };

const lazyWorkspaceImport = () => import("./WorkspaceApp").then((module) => ({ default: module.WorkspaceApp }));
const WorkspaceApp = lazy(lazyWorkspaceImport);

/**
 * Neutral shell shown while the workspace chunk loads on a restore.
 *
 * The start screen used to fill this gap, so reloading a saved project
 * flashed "Create new project" before the restored workspace appeared. When
 * the user is arriving *from* the start screen the fallback is continuous and
 * stays as it was; only the restore path needs something neutral.
 */
function WorkspaceRestoringShell({ themeMode }: { themeMode: "dark" | "light" }) {
  return (
    <div className={`workspace-restoring theme-${themeMode}`} role="status" aria-live="polite">
      <span>Restoring your workspace...</span>
    </div>
  );
}

export function App() {
  const [{ hasRestoredWorkspace, restoredThemeMode }] = useState(() => {
    const hasWorkspace = hasAutosavedWorkspace();
    return {
      hasRestoredWorkspace: hasWorkspace,
      restoredThemeMode: hasWorkspace ? readAutosavedThemeMode() : "dark"
    } as const;
  });
  const [initialAction, setInitialAction] = useState<WorkspaceInitialAction | null>(null);
  const [workspaceRequested, setWorkspaceRequested] = useState(hasRestoredWorkspace);

  function openWorkspace(action: WorkspaceInitialAction) {
    setInitialAction(action);
    setWorkspaceRequested(true);
  }

  const startScreen = (
    <StartScreen
      onLoadSample={(sample, analysisType) => openWorkspace({ type: "loadSample", sample, analysisType })}
      onCreateProject={() => openWorkspace({ type: "createProject" })}
      onOpenProject={(file) => openWorkspace({ type: "openProject", file })}
    />
  );

  if (!workspaceRequested) return startScreen;

  return (
    <Suspense fallback={initialAction ? startScreen : <WorkspaceRestoringShell themeMode={restoredThemeMode} />}>
      <WorkspaceApp initialAction={initialAction} />
    </Suspense>
  );
}
