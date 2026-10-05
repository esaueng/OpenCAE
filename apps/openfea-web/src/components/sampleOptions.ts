import type { SampleModelId } from "../lib/api";

export interface SampleOption {
  id: SampleModelId;
  title: string;
  shortTitle: string;
  description: string;
  support: string;
  load: string;
  thumbnail: "bracket" | "beam" | "cantilever";
  imageSrc?: string;
}

export const SAMPLE_OPTIONS: SampleOption[] = [
  {
    id: "bracket",
    title: "Bracket Demo",
    shortTitle: "Bracket",
    description: "Gusseted mounting bracket with bolt-hole supports.",
    support: "2 mounting holes",
    load: "Top face force",
    thumbnail: "bracket"
  },
  {
    id: "plate",
    title: "Beam Demo",
    shortTitle: "Beam",
    description: "Fixed beam carrying a payload mass at the free end.",
    support: "Fixed end",
    load: "Payload mass",
    thumbnail: "beam"
  },
  {
    id: "cantilever",
    title: "Cantilever Demo",
    shortTitle: "Cantilever",
    description: "Classic end-loaded beam for bending stress studies.",
    support: "Fixed end",
    load: "Free-end force",
    thumbnail: "cantilever"
  }
];

export function sampleOptionFor(id: SampleModelId): SampleOption {
  return SAMPLE_OPTIONS.find((option) => option.id === id) ?? SAMPLE_OPTIONS[0]!;
}
