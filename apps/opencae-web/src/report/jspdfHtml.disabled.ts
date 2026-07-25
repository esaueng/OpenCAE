/**
 * Stub for jsPDF's optional `html()` rendering dependencies.
 *
 * jsPDF declares html2canvas, canvg, and dompurify as *optionalDependencies*
 * and its ESM build imports them statically, so Rollup bundles all three even
 * though this app never calls `doc.html()` — it composes report pages from
 * primitives (text/rect/addImage/autoTable) and outputs an arraybuffer. That
 * cost ~110 kB gzip of unreachable code and was the app's only exposure to
 * dompurify advisories.
 *
 * `vite.config.ts` aliases those three specifiers here. If anyone adds a
 * `doc.html()` call, this throws immediately with instructions rather than
 * failing obscurely deep inside jsPDF — the failure is loud and traceable.
 * See report/reportPdf.ts for the supported drawing surface.
 */

const MESSAGE =
  "jsPDF's html() rendering path is stubbed out in this build. OpenCAE composes report PDFs from " +
  "primitives (text, rect, addImage, autoTable), so html2canvas/canvg/dompurify are not bundled. " +
  "To use html(), remove the stubJsPdfHtmlDependencies alias in apps/opencae-web/vite.config.ts and " +
  "re-check the bundle budget and the dompurify advisory surface.";

function unavailable(): never {
  throw new Error(MESSAGE);
}

// html2canvas and canvg are consumed as default exports; dompurify is used as
// a namespace with .sanitize(). Cover both shapes so the stub resolves
// identically to the real modules at import time and only fails when called.
export default unavailable;
export const sanitize = unavailable;
export const Canvg = { fromString: unavailable, from: unavailable };
export const presets = {};
