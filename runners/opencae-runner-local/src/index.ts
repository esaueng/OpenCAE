export interface LocalRunnerInfo {
  id: string;
  mode: "local";
  description: string;
}

export const localRunnerInfo: LocalRunnerInfo = {
  id: "opencae-runner-local",
  mode: "local",
  description: "Local runner placeholder for queued CAD, mesh, solve, and post-processing jobs."
};
