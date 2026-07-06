// Regenerates the A-M3 STEP robustness corpus fixtures under
// libs/opencae-mesh-intake/fixtures/ from the deterministic gmsh-wasm OCC
// generators in stepFixtures.ts (box-with-bore.step predates this corpus and
// keeps its original generator, generateBoxWithBoreStep).
//
// Usage: npx tsx scripts/generate-step-corpus.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixturesDir = new URL("../libs/opencae-mesh-intake/fixtures/", import.meta.url);
const generators = await import("../libs/opencae-mesh-intake/src/stepFixtures.ts");

const corpus = [
  ["filleted-block.step", generators.generateFilletedBlockStep],
  ["multi-hole-plate.step", generators.generateMultiHolePlateStep],
  ["l-bracket-gusset.step", generators.generateLBracketGussetStep],
  ["thin-walled-tray.step", generators.generateThinWalledTrayStep]
];

for (const [filename, generate] of corpus) {
  const step = await generate();
  const path = fileURLToPath(new URL(filename, fixturesDir));
  writeFileSync(path, step);
  console.log(`${filename}: ${step.length} bytes`);
}
