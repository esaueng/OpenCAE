import { lazy, Suspense, useMemo, useState } from "react";
import { StartScreen } from "./components/StartScreen";

type SampleModelId = "bracket" | "plate" | "cantilever";
type SampleAnalysisType = "static_stress" | "dynamic_structural";

export type WorkspaceInitialAction =
  | { type: "loadSample"; sample?: SampleModelId; analysisType?: SampleAnalysisType }
  | { type: "createProject" }
  | { type: "openProject"; file: File };

const lazyWorkspaceImport = () => import("./WorkspaceApp").then((module) => ({ default: module.WorkspaceApp }));
const WorkspaceApp = lazy(lazyWorkspaceImport);
const AUTOSAVE_STORAGE_KEY = "opencae.workspace.autosave.v1";

export function App() {
  const hasRestoredWorkspace = useMemo(() => hasAutosavedWorkspace(), []);
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
    <Suspense fallback={startScreen}>
      <WorkspaceApp initialAction={initialAction} />
    </Suspense>
  );
}

function hasAutosavedWorkspace(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.localStorage.getItem(AUTOSAVE_STORAGE_KEY));
}
