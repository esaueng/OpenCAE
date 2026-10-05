import type { StepId } from "./components/StepBar";
import type { PayloadObjectSelection } from "./workspaceViewTypes";

export function nextSelectedPayloadObject({
  activeStep,
  draftLoadType,
  current,
  payloadObject
}: {
  activeStep: StepId;
  draftLoadType: string;
  current: PayloadObjectSelection | null;
  payloadObject?: PayloadObjectSelection;
}): PayloadObjectSelection | null {
  if (activeStep !== "loads" || draftLoadType !== "gravity") return null;
  return payloadObject ?? current;
}

export function shouldClearPayloadSelectionOnViewerMiss({ activeStep, draftLoadType }: { activeStep: StepId; draftLoadType: string }): boolean {
  return activeStep === "loads" && draftLoadType === "gravity";
}
