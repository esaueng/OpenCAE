// Deterministic STEP corpus generators (plan A-M3 stage 5), built with
// gmsh-wasm's OpenCASCADE kernel exactly like generateBoxWithBoreStep. Each
// function runs a fresh gmsh session (0.1.2 session bug: never reuse a module
// instance) and returns the STEP text; the checked-in fixtures under
// fixtures/ were produced by scripts/generate-step-corpus.mjs and these
// functions can regenerate them byte-for-byte-equivalent (OCC writes a
// timestamp header line, which is the only nondeterminism).
import { loadGmshWasm, type GmshApi } from "./wasmMesher";

/** 60x40x20 mm block with every edge filleted at 3 mm. */
export async function generateFilletedBlockStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const box = gmsh.model.occ.addBox(0, 0, 0, 60, 40, 20);
    gmsh.model.occ.synchronize();
    const curves = entityTags(gmsh, 1);
    gmsh.model.occ.fillet([box], curves, [3], true);
    gmsh.model.occ.synchronize();
  });
}

/** 100x60x8 mm plate with four 10 mm bores near the corners and one 16 mm center bore. */
export async function generateMultiHolePlateStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const plate = gmsh.model.occ.addBox(0, 0, 0, 100, 60, 8);
    const holes: number[] = [];
    for (const [x, y, diameter] of [
      [15, 15, 10],
      [85, 15, 10],
      [15, 45, 10],
      [85, 45, 10],
      [50, 30, 16]
    ] as const) {
      holes.push(gmsh.model.occ.addCylinder(x, y, -1, 0, 0, 10, diameter / 2));
    }
    gmsh.model.occ.cut([3, plate], holes.flatMap((hole) => [3, hole]));
    gmsh.model.occ.synchronize();
  });
}

/**
 * L-bracket with gusset, approximating the real bracket demo: 100x60x10 mm
 * base, 10x60x70 mm upright, and a triangular gusset wedge tying them
 * together, fused into one solid.
 */
export async function generateLBracketGussetStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const base = gmsh.model.occ.addBox(0, 0, 0, 100, 60, 10);
    const upright = gmsh.model.occ.addBox(0, 0, 0, 10, 60, 80);
    // addWedge(x, y, z, dx, dy, dz): right-angle wedge along its dx/dz faces;
    // place it against the upright, on top of the base, centered in depth.
    const gusset = gmsh.model.occ.addWedge(10, 22, 10, 45, 16, 45);
    gmsh.model.occ.fuse([3, base], [3, upright, 3, gusset]);
    gmsh.model.occ.synchronize();
  });
}

/** Thin-walled open tray: 60x40x30 mm outer shell with uniform 2 mm walls/floor and an open top. */
export async function generateThinWalledTrayStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const outer = gmsh.model.occ.addBox(0, 0, 0, 60, 40, 30);
    // Inner cut protrudes past the top face so the tray opens up.
    const inner = gmsh.model.occ.addBox(2, 2, 2, 56, 36, 30);
    gmsh.model.occ.cut([3, outer], [3, inner]);
    gmsh.model.occ.synchronize();
  });
}

async function withOccSession(build: (gmsh: GmshApi) => void): Promise<string> {
  const gmsh = await loadGmshWasm();
  gmsh.initialize();
  gmsh.option.setNumber("General.Verbosity", 2);
  try {
    build(gmsh);
    gmsh.write("/fixture.step");
    return gmsh.FS.readFile("/fixture.step", { encoding: "utf8" }) as string;
  } finally {
    try {
      gmsh.finalize();
    } catch {
      // finalize after OCC failures can throw; the module instance is discarded either way.
    }
  }
}

function entityTags(gmsh: GmshApi, dimension: number): number[] {
  const flat = gmsh.model.getEntities(dimension).dimTags;
  const tags: number[] = [];
  for (let index = 1; index < flat.length; index += 2) {
    tags.push(flat[index]!);
  }
  return tags;
}
