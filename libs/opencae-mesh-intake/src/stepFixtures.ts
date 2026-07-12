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

/**
 * Bent thin shell like a sheet-metal tablet stand: 93 mm wide L of two 3 mm
 * plates (60 mm deep base, 50 mm tall back) with a 12 mm fillet at the bend.
 * Regression geometry for curved Tet10 elevation inverting elements on thin
 * bent regions (minSICN -0.29 curved vs +0.31 straight at the 12 mm preset).
 */
export async function generateBentShellStandStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const base = gmsh.model.occ.addBox(0, 0, 0, 93, 60, 3);
    const back = gmsh.model.occ.addBox(0, 0, 0, 93, 3, 50);
    gmsh.model.occ.fuse([3, base], [3, back]);
    gmsh.model.occ.synchronize();
    // Fillet the concave joint edge (the long X-parallel edge at y=z=3).
    const joint = entityTags(gmsh, 1).filter((tag) => {
      const bounds = gmsh.model.getBoundingBox(1, tag);
      return bounds.xmax - bounds.xmin > 80 &&
        Math.abs(bounds.ymin - 3) < 0.5 && Math.abs(bounds.ymax - 3) < 0.5 &&
        Math.abs(bounds.zmin - 3) < 0.5 && Math.abs(bounds.zmax - 3) < 0.5;
    });
    if (joint.length) {
      gmsh.model.occ.fillet(entityTags(gmsh, 3), joint, [12], true);
      gmsh.model.occ.synchronize();
    }
  });
}

/**
 * Thin J-clip like a sheet-metal tablet stand: 93 mm wide, 2 mm walls — a
 * 60 mm base, 50 mm back, and a 22 mm front prong, with an 8 mm bend fillet.
 * Regression geometry for thin-wall sliver tets: at the 12 mm medium preset
 * its linear mesh scores minSICN ~0.02 (below the 0.05 floor) while 8 mm
 * scores ~0.25, driving the quality-refinement ladder.
 */
export async function generateThinClipStandStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const base = gmsh.model.occ.addBox(0, 0, 0, 93, 60, 2);
    const back = gmsh.model.occ.addBox(0, 0, 0, 93, 2, 50);
    const prong = gmsh.model.occ.addBox(0, 55, 0, 93, 2, 22);
    gmsh.model.occ.fuse([3, base], [3, back, 3, prong]);
    gmsh.model.occ.synchronize();
    const joint = entityTags(gmsh, 1).filter((tag) => {
      const bounds = gmsh.model.getBoundingBox(1, tag);
      const shortYZ = Math.abs(bounds.ymax - bounds.ymin) < 0.1 && Math.abs(bounds.zmax - bounds.zmin) < 0.1;
      return bounds.xmax - bounds.xmin > 80 && shortYZ && Math.abs(bounds.zmin - 2) < 0.5;
    });
    if (joint.length) {
      try {
        gmsh.model.occ.fillet(entityTags(gmsh, 3), joint.slice(0, 2), [8], true);
        gmsh.model.occ.synchronize();
      } catch {
        // Fillet is best effort; the unfilleted clip still exercises thin walls.
      }
    }
  });
}

/**
 * 1.5 mm sheet tablet stand: 93 mm wide base + 50.5 mm back + 22 mm prong
 * with a 6 mm slot gap and a 10 mm bend fillet — the thinnest, nastiest
 * shape class reported from production. Its linear mesh at the 12 mm medium
 * preset keeps a sliver tail (minSICN ~0.01, 2/776 elements below floor)
 * that only gmsh's Netgen optimizer reliably repairs (to ~0.11).
 */
export async function generateThinSheetStandStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const wall = 1.5;
    const base = gmsh.model.occ.addBox(0, 0, 0, 93, 60, wall);
    const back = gmsh.model.occ.addBox(0, 0, 0, 93, wall, 50.5);
    const prong = gmsh.model.occ.addBox(0, wall + 6, 0, 93, wall, 22);
    gmsh.model.occ.fuse([3, base], [3, back, 3, prong]);
    gmsh.model.occ.synchronize();
    const joint = entityTags(gmsh, 1).filter((tag) => {
      const bounds = gmsh.model.getBoundingBox(1, tag);
      const shortYZ = Math.abs(bounds.ymax - bounds.ymin) < 0.1 && Math.abs(bounds.zmax - bounds.zmin) < 0.1;
      return bounds.xmax - bounds.xmin > 80 && shortYZ && bounds.zmin < wall + 0.6 && bounds.ymin < wall + 0.6;
    });
    if (joint.length) {
      try {
        gmsh.model.occ.fillet(entityTags(gmsh, 3), joint.slice(0, 2), [10], true);
        gmsh.model.occ.synchronize();
      } catch {
        // Fillet is best effort; the unfilleted stand still exercises thin sheets.
      }
    }
  });
}

/**
 * Seed-holder-style carrier tray, the most complex corpus member (~90 B-rep
 * faces): a 160x120x16 mm picture frame with a through window, eight
 * scalloped cradle pockets across the top of each long rail (16 half-round
 * grooves), four counterbored corner bolt holes, a grip notch in each short
 * rail, and filleted outer corners. Models the production part class that
 * exposed the multi-support preflight and picked-face mapping failures.
 */
export async function generateSeedHolderTrayStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const frame = gmsh.model.occ.addBox(0, 0, 0, 160, 120, 16);
    const cutters: number[] = [];
    // Through window leaving 24 mm rails on every side.
    cutters.push(gmsh.model.occ.addBox(24, 24, -1, 112, 72, 18));
    // Eight scallop cradles across the top of each long rail: half-round
    // grooves from Y-axis cylinders centered on the top surface.
    for (let pocket = 0; pocket < 8; pocket += 1) {
      const x = 34 + pocket * 13;
      cutters.push(gmsh.model.occ.addCylinder(x, -1, 16, 0, 26, 0, 6.5));
      cutters.push(gmsh.model.occ.addCylinder(x, 95, 16, 0, 26, 0, 6.5));
      // Drainage bore up through each cradle floor: a 4 mm hole whose top
      // pierces the scallop cylinder, forcing curved-curved boolean seams and
      // a 40:1 part-to-feature scale ratio.
      cutters.push(gmsh.model.occ.addCylinder(x, 12, -1, 0, 0, 11.5, 2));
      cutters.push(gmsh.model.occ.addCylinder(x, 108, -1, 0, 0, 11.5, 2));
    }
    // Counterbored corner bolt holes: 8 mm through bore, 14 mm x 5 mm seat.
    for (const [x, y] of [[12, 12], [148, 12], [12, 108], [148, 108]] as const) {
      cutters.push(gmsh.model.occ.addCylinder(x, y, -1, 0, 0, 18, 4));
      cutters.push(gmsh.model.occ.addCylinder(x, y, 11, 0, 0, 6, 7));
    }
    // Grip notches through the outer wall of each short rail.
    cutters.push(gmsh.model.occ.addBox(-1, 50, 8, 13, 20, 9));
    cutters.push(gmsh.model.occ.addBox(148, 50, 8, 13, 20, 9));
    gmsh.model.occ.cut([3, frame], cutters.flatMap((cutter) => [3, cutter]));
    gmsh.model.occ.synchronize();
    // Fillet the four outer vertical corner edges (best effort).
    const corners = entityTags(gmsh, 1).filter((tag) => {
      const bounds = gmsh.model.getBoundingBox(1, tag);
      const vertical = Math.abs(bounds.xmax - bounds.xmin) < 0.1 && Math.abs(bounds.ymax - bounds.ymin) < 0.1 && bounds.zmax - bounds.zmin > 15;
      const atCornerX = Math.abs(bounds.xmin) < 0.1 || Math.abs(bounds.xmin - 160) < 0.1;
      const atCornerY = Math.abs(bounds.ymin) < 0.1 || Math.abs(bounds.ymin - 120) < 0.1;
      return vertical && atCornerX && atCornerY;
    });
    if (corners.length) {
      try {
        gmsh.model.occ.fillet(entityTags(gmsh, 3), corners, [6], true);
        gmsh.model.occ.synchronize();
      } catch {
        // Fillet is best effort; the sharp-cornered tray still exercises the pipeline.
      }
    }
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

/**
 * T-bar exported as TWO UNFUSED solids that interpenetrate (the cross-bar
 * overlaps the arm's first 10 mm), like the failing "CAE Load Test" upload
 * class: a 160x20x10 mm arm with an 8 mm bore near the tip, plus a
 * 20x60x10 mm cross-bar. Exercises the multi-body fusion stage — meshed
 * per-volume this double-counts the overlap and can never form one component.
 */
export async function generateOverlappingTBarStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const arm = gmsh.model.occ.addBox(0, -10, 0, 160, 20, 10);
    gmsh.model.occ.addBox(-10, -30, 0, 20, 60, 10);
    const bore = gmsh.model.occ.addCylinder(150, 0, -1, 0, 0, 12, 4);
    gmsh.model.occ.cut([3, arm], [3, bore]);
    gmsh.model.occ.synchronize();
  });
}

/**
 * The same T-bar as two UNFUSED solids that exactly touch at the x=0 plane
 * (coincident faces, no interpenetration). Meshed per-volume the coincident
 * faces get independent, non-matching triangulations, so the two bodies never
 * share nodes and the solver rejects the mesh as two components.
 */
export async function generateTouchingTBarStep(): Promise<string> {
  return withOccSession((gmsh) => {
    const arm = gmsh.model.occ.addBox(0, -10, 0, 160, 20, 10);
    gmsh.model.occ.addBox(-10, -30, 0, 10, 60, 10);
    const bore = gmsh.model.occ.addCylinder(150, 0, -1, 0, 0, 12, 4);
    gmsh.model.occ.cut([3, arm], [3, bore]);
    gmsh.model.occ.synchronize();
  });
}

/** Two 40x20x10 mm bars separated by a 5 mm air gap: fusion must leave disjoint bodies alone. */
export async function generateDisjointBarsStep(): Promise<string> {
  return withOccSession((gmsh) => {
    gmsh.model.occ.addBox(0, 0, 0, 40, 20, 10);
    gmsh.model.occ.addBox(45, 0, 0, 40, 20, 10);
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
