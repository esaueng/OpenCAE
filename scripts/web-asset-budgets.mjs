/**
 * Declared size budgets for the built web app.
 *
 * Only the initial JS bundle had a budget before this. Everything else — the
 * lazy viewer chunk, the CAD and meshing engines, the service worker's
 * install-time precache — grew unwatched, so an end-to-end audit measuring
 * them had nothing to compare against and no way to tell growth from the
 * intended size.
 *
 * Budgets are set at the measured size plus a stated margin. They are growth
 * alarms, not shrink targets: exceeding one means look at what was added, not
 * that the number is wrong.
 */

/** Everything the browser must download before the app shell paints. */
export const INITIAL_JS_GZIP_BUDGET_BYTES = 175 * 1024;

/**
 * Ceiling for any single lazy JS chunk, gzip.
 *
 * The largest today is `viewer-three` at ~265 KiB gzip (~962 KiB raw): all of
 * three.js plus the drei/fiber layer the 7.3k-line viewer drives directly. It
 * is one manual chunk on purpose — plan 024 owns the question of splitting the
 * viewer's subsystems, which needs visual regression evidence rather than a
 * budget line.
 */
export const LAZY_JS_CHUNK_GZIP_BUDGET_BYTES = 300 * 1024;

/** All JS the build emits, gzip — catches growth spread thinly across chunks. */
export const TOTAL_JS_GZIP_BUDGET_BYTES = 1500 * 1024;

/**
 * Total bytes the service worker precaches at install.
 *
 * Dominated by the two wasm engines (gmsh ~10.7 MiB compressed, occt ~7.3 MiB),
 * which are EXEMPT from any shrink expectation and are precached deliberately:
 * `src/lib/offlinePrecache.ts` records the contract that a user who goes
 * offline before their first mesh must still be able to mesh. Moving them to
 * first-use caching would cut install by ~18 MiB and break that promise, so it
 * is not a size decision to make here.
 */
export const PRECACHE_TOTAL_BUDGET_BYTES = 26 * 1024 * 1024;

/** Non-code assets (images, fonts) that ship raw. Excludes wasm. */
export const STATIC_ASSET_BUDGET_BYTES = 256 * 1024;

/** Files exempt from STATIC_ASSET_BUDGET_BYTES, with the reason. */
export const STATIC_ASSET_EXEMPTIONS = [
  { pattern: /\.wasm(\.gz)?$/, reason: "CAD and meshing engines; intrinsically large, see PRECACHE_TOTAL_BUDGET_BYTES" }
];
