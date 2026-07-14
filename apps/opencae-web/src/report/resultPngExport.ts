import type { ResultField, StressComponent } from "@opencae/schema";
import type { ResultMode } from "../workspaceViewTypes";

export interface ResultPngFilenameInput {
  projectName: string;
  resultMode: ResultMode;
  stressComponent?: StressComponent;
  field?: Pick<ResultField, "frameIndex" | "timeSeconds">;
}

export function suggestedResultPngFilename(input: ResultPngFilenameInput): string {
  const project = filenameToken(input.projectName) || "opencae-project";
  const field = resultFieldFilenameToken(input.resultMode, input.stressComponent);
  const frame = input.field?.frameIndex;
  const time = input.field?.timeSeconds;
  const metadata = frame === undefined
    ? "static"
    : `frame-${String(Math.max(0, Math.trunc(frame))).padStart(4, "0")}${Number.isFinite(time) ? `_t-${timeToken(time!)}s` : ""}`;
  return `${project}_${field}_${metadata}.png`;
}

function resultFieldFilenameToken(resultMode: ResultMode, stressComponent?: StressComponent): string {
  if (resultMode !== "stress") return resultMode.replaceAll("_", "-");
  if (stressComponent === "principal_max") return "stress-sigma1";
  if (stressComponent === "principal_min") return "stress-sigma3";
  if (stressComponent === "max_shear") return "stress-max-shear";
  return "stress-von-mises";
}

function filenameToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function timeToken(seconds: number): string {
  const finiteSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return finiteSeconds.toFixed(6).replace(/0+$/g, "").replace(/\.$/g, "").replace(".", "p");
}

export function pngDataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error("The result viewer returned an invalid PNG image.");
  const binary = atob(match[1]!.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}
