import { lazy, Suspense, useMemo, useState } from "react";
import type { AutosavedWorkspace } from "./appPersistence";
import { readAutosavedWorkspace } from "./appPersistence";
import { StartScreen } from "./components/StartScreen";

type SampleModelId = "bracket" | "plate" | "cantilever";
type SampleAnalysisType = "static_stress" | "dynamic_structural";

export type WorkspaceInitialAction =
  | { type: "loadSample"; sample?: SampleModelId; analysisType?: SampleAnalysisType }
  | { type: "createProject" }
  | { type: "openProject"; file: File };

const lazyWorkspaceImport = () => import("./WorkspaceApp").then((module) => ({ default: module.WorkspaceApp }));
const WorkspaceApp = lazy(lazyWorkspaceImport);

export function App() {
  const restoredWorkspace = useMemo(() => readAutosavedWorkspace(), []);
  const [initialAction, setInitialAction] = useState<WorkspaceInitialAction | null>(null);
  const [workspaceRequested, setWorkspaceRequested] = useState(Boolean(restoredWorkspace));

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
      <WorkspaceApp initialAction={initialAction} restoredWorkspace={restoredWorkspace} />
    </Suspense>
  );
}

export type { AutosavedWorkspace };
