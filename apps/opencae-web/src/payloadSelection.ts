import type { PayloadObjectSelection } from "./loadPreview";
import type { StepId } from "./components/StepBar";

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
