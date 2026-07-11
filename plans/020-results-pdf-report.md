# Plan 020: One-Click Professional PDF Simulation Report

Base commit: open-cae `fa2ae84` (or later main).
Status: TODO
Category: product feature / results UX
Driver: 2026-07-10 maintainer request — on the results page, a single **Generate report** button that downloads an aesthetically pleasing, professional, concise PDF CAE report covering the full simulation setup (geometry, material, boundary conditions, mesh, solver) and the results (key metrics, contour figures, diagnostics).

This plan is self-contained. All file:line references were verified against `fa2ae84`.

## Product intent

An engineer finishes a solve and clicks one button. They get a PDF they could attach to an email or drop into a design folder: branded, clean, honest about fidelity. No configuration dialog in v1 — the report is a faithful, well-typeset snapshot of exactly what the results panel already shows, plus the setup that produced it.

Non-goals for v1: report customization UI, multi-study reports, editable templates, server-side rendering (must be fully client-side/local-first), CSV/raw-field export.

## Architecture overview

Four pieces, in dependency order:

1. **Viewer capture seam** — `CadViewer` gains an imperative capture handle so the app can grab PNG snapshots of the contour view. Today no screenshot capability exists anywhere (`preserveDrawingBuffer` is default-false and the canvas uses `frameloop="demand"`, so a naive `toDataURL()` reads an empty buffer).
2. **Report data assembly** — a pure, unit-tested function that gathers everything from live app state into a `ReportData` object, reusing the existing honest-results formatters. No PDF concepts in this module.
3. **PDF renderer** — a lazily-imported module (`import()`) that turns `ReportData` + captured images into a styled PDF via jsPDF + jspdf-autotable. Lazy loading is mandatory: `scripts/check-web-bundle-budget.mjs` gates initial JS at 175 KB gzip and counts static imports only.
4. **UI** — a **Generate report** button in the results panel with generating/error states, wired through `WorkspaceApp`, downloading via the same save-picker/anchor-download pattern as `saveProjectToLocalDisk`.

## New files

```
apps/opencae-web/src/report/reportData.ts        # ReportData types + buildReportData()
apps/opencae-web/src/report/reportData.test.ts
apps/opencae-web/src/report/reportPdf.ts         # renderReportPdf(data): Promise<Blob>  (lazy chunk)
apps/opencae-web/src/report/reportPdf.test.ts
apps/opencae-web/src/report/reportTheme.ts       # print design tokens (colors, type scale, spacing)
apps/opencae-web/src/report/fonts/               # IBM Plex Sans Regular + SemiBold TTFs (see Fonts)
apps/opencae-web/src/lib/fileSave.ts             # download helper extracted from WorkspaceApp
```

## Dependencies to add (apps/opencae-web only)

- `jspdf` (^3) and `jspdf-autotable` (^5). Both MIT, pure client-side, no network at runtime — compatible with the CSP in `apps/opencae-web/public/_headers` (`'unsafe-eval'` already allowed for occt; `img-src data: blob:` covers embedded PNGs; no new `connect-src` needed). jsPDF also runs under Node, which is what makes the renderer unit-testable in Vitest.
- Add both to `THIRD_PARTY_NOTICES.md`, plus the IBM Plex OFL notice if not already present for the embedded TTFs.

Rejected alternatives: `pdf-lib` (no table/flow layout — hand-rolling tables is where report code goes to die), `react-pdf`/`@react-pdf/renderer` (heavy, own reconciler, poor fit for a lazy chunk), `html2canvas`+print (fuzzy raster text, not "professional").

---

## Report content specification

Every value in the report goes through the same display pipeline as the on-screen panel: convert with `resultSummaryForUnits` / `resultFieldForUnits` (`apps/opencae-web/src/unitDisplay.ts:61,77`) using `displayUnitSystem`, format with the panel's conventions. **Honest-results rules are non-negotiable**: `--` for missing values, `Unit missing` when units are absent (`RightPanel.tsx:1583-1596` pattern), `(est.)` suffixes on mesh counts unless `summary.source === "core_solver"` (`RightPanel.tsx:1085-1090`), provenance tier labeled via `formatResultProvenanceLabel` (`unitDisplay.ts:109`), and any active warnings (`PREVIEW_GEOMETRY_WARNING`, invalid-reaction diagnostics from `src/resultProvenance.ts`) reproduced verbatim in the Diagnostics section. The report must never look more authoritative than the screen it summarizes.

### Page 1 — Cover / summary (the "concise" page; a reader who stops here has the story)

- **Header band**: OpenCAE logo mark (from `public/opencae-logo.png`, embedded as PNG) + wordmark, right-aligned report date (ISO, local), thin accent rule below.
- **Title block**: "Structural Simulation Report" (or "Dynamic Structural Simulation Report" when `study.type === "dynamic_structural"`), project name, study name, unit system ("SI (m, Pa)" / "US (in, psi)").
- **Provenance banner**: one-line tier label (e.g. "Production FEA" / "OpenCAE Core Preview (coarse block proxy)" / "Estimate (not FEA)") using the exact strings from `formatResultProvenanceLabel`. Tint the banner: success-green tint for `production_fea`, warning-amber tint for every other tier.
- **Key results table** (the executive summary): Max von Mises stress, Max displacement, Safety factor, Reaction force, Failure check status — sourced from `resultSummary` exactly as `ResultsPanelContent`'s `.summary-box` shows them (`RightPanel.tsx:1529-1542`).
- **Failure assessment callout**: `resultSummary.failureAssessment` `{status,title,message}` rendered as a bordered callout, color-keyed (success/warning/error tints).
- **Hero figure**: the von Mises contour capture, large (full content width), with color-ramp legend and caption noting the deformation exaggeration factor (e.g. "Deformed shape, ×120 exaggeration (display only)").
- **Footer** (every page): "Generated by OpenCAE — cae.esau.app" left, "Page N of M" right, and the scope disclaimer centered in small muted type: *"Development-grade analysis. Not a substitute for professional engineering review."* (matches the README's own scope statement).

### Page 2+ — Model definition

1. **Geometry** — source discrimination from `DisplayModel` (`libs/opencae-schema/src/index.ts:550-587`): uploaded CAD → filename + format ("STEP"); sample → "Sample model: Cantilever/Beam/Bracket (procedural)"; uploaded mesh / structured block labeled as such. Include the `project.geometryFiles` entries (name, size if available). If the geometry is a sample/procedural proxy, say so plainly — do not present it as customer CAD.
2. **Material** — table of assigned material(s) from `study.materialAssignments` resolved against the material record: Name, Young's modulus, Poisson ratio, Density, Yield strength (each unit-converted; `--` for absent fields).
3. **Boundary conditions** — two tables:
   - Supports: one row per `Constraint` (`type` humanized: "Fixed support" / "Prescribed displacement", target selection label).
   - Loads: one row per `Load` (`type` humanized, magnitude + units from `parameters`, direction if present, target selection label). For selection labels reuse whatever naming the setup panels display (named selection name, else the selection ref id); never invent face descriptions.
4. **Mesh** — settings preset (`meshSettings.preset`), node count, element count, element type (Tet10 where known from provenance), warnings list from `meshSettings.summary.warnings`. Counts labeled `(est.)` per the honest rule above; if `solverMeshSummary` (from `solverMeshSummaryFromResults`, `src/resultFields.ts:1065`) exists, prefer its solver-actual counts and label the source "Core solver".
5. **Solver** — analysis type; static: backend/fidelity; dynamic: integration method, time step, end time, output interval, damping (from `DynamicSolverSettings` and `ResultProvenance.integrationMethod/loadProfile`); solver/core/runner versions from `ResultProvenance`; solve wall time from `runTiming.elapsedMs` **if it is still live at generation time**, else `--` (it is not persisted — see Data notes).

### Results section

6. **Result figures** — von Mises stress contour and displacement magnitude contour, each with: the captured image, a vertical color-ramp legend rendered natively in PDF (six stops from the ramp: `#0759d6 → … → #ef4444`, matching `--color-ramp-0..5` in `src/theme/tokens.css`) with min/max tick labels from the corresponding `ResultField.min/max` (unit-converted), and a caption stating field name, units, frame/time for dynamic (from `ResultField.frameIndex/timeSeconds`), and the exaggeration factor.
7. **Results table** — the full `.summary-box` row set: Result source, Core solver version, Core model schema version, Mesh source, Solver method, Runner, Local fallback, Max stress, Max displacement, Safety factor, Failure check, Reaction force. For dynamic studies add the transient block (`resultSummary.transient`) rows.
8. **Diagnostics & limitations** — every entry of `resultSummary.diagnostics[]`, active provenance warnings, mesh warnings not already shown, and a fixed bullet: displayed contours are smoothed for visualization; the summary max stress is the unaveraged element peak (true statement about the pipeline — keep only if provenance is a Core-solver tier).

### Filename

`OpenCAE-Report_<project-name-slug>_<YYYY-MM-DD>.pdf`, slug sanitized like the project-save filename.

---

## Design aesthetics specification (`reportTheme.ts`)

The app is a dark UI; the report is a **print document** — light, ink-on-white, with the brand accent used sparingly. Do not port the dark surface colors.

**Page**: A4 when `displayUnitSystem === "SI"`, US Letter when `"US"`. Margins 18 mm all around; content width therefore ~174 mm (A4). Single column.

**Palette** (derive from `tokens.css`, adjusted for print):

| Token | Value | Use |
| - | - | - |
| ink | `#0b0f14` (= `--color-bg`) | body text, table text |
| ink-muted | `#57606a` | captions, footer, secondary labels (NOT the UI's `#8b949e` — too light on white) |
| accent | `#1f6fd0` (darkened `--color-accent #4da3ff` for ≥4.5:1 on white) | section numbers, rules, table header text |
| accent-soft | `#e8f1fc` | table header row fill, callout tints base |
| hairline | `#d8dee4` | table borders, rules |
| success / warning / error | `#15803d` / `#b45309` / `#b91c1c` | status callout text (darkened from UI tokens for print contrast), on 8% tint fills of the UI values `#22c55e`/`#f59e0b`/`#ef4444` |
| ramp 0..5 | exactly `--color-ramp-0..5` from `tokens.css` | contour legend only — must match the viewer legend the user saw |

**Typography**: IBM Plex Sans (Regular 400, SemiBold 600) — the app's `--font-ui`, embedded as TTF (see Fonts). Scale: title 22 pt SemiBold; section heading 13 pt SemiBold in accent, numbered ("1  Geometry"), 0.5 pt accent rule beneath; body/table 9.5 pt; caption/footer 8 pt ink-muted; key-results numerals 14 pt SemiBold. Numbers in tables right-aligned; units set with the value ("38.9 MPa"), never in a separate column.

**Tables** (jspdf-autotable theme): no vertical borders; 0.4 pt hairline horizontal rules; header row accent-soft fill with accent SemiBold text; 6 pt cell padding; zebra off (concise reports don't need it); label column ~38% width.

**Figures**: full content width, hairline border, 2 mm padding; legend as a 6-stop vertical gradient bar (draw six filled rects — jsPDF has no native gradients worth trusting) right of the image with min/max labels; caption below in caption style. Never upscale a capture beyond its pixel size / 150 dpi equivalent; captures come in at canvas resolution × devicePixelRatio which is ample.

**Layout discipline**: sections start with a heading block that is kept with at least its first content row (manual keep-together: measure, page-break before if <30 mm remains). Cover page content is fixed-layout; subsequent pages flow. Everything monochrome-printable: tints must degrade gracefully to grayscale (they do at these lightness values).

**Fonts**: ship `IBMPlexSans-Regular.ttf` and `IBMPlexSans-SemiBold.ttf` (OFL) in `src/report/fonts/`, imported with Vite `?url` and fetched at generation time (same-origin fetch — allowed by `connect-src 'self'`), registered via jsPDF `addFileToVFS`/`addFont`. They live in the lazy report chunk's asset graph, not the initial bundle. If the fetch fails, fall back to built-in Helvetica and proceed — a slightly-off font must not block report generation. (~350 KB total; acceptable for an on-demand asset, and PWA precache picks it up for offline use automatically via vite-plugin-pwa's glob — verify the glob includes `ttf`, extend if not.)

---

## Implementation steps

### Step 1 — Extract the download helper

Pull the save logic out of `saveProjectToLocalDisk` (`apps/opencae-web/src/WorkspaceApp.tsx:1914-1940`) into `src/lib/fileSave.ts`: `saveBlobToDisk(blob: Blob, suggestedName: string, opts: { description: string; accept: Record<string,string[]> }): Promise<"saved"|"cancelled">` using `showSaveFilePicker` when available (reuse the `SaveFilePickerWindow`/`SaveFilePickerHandle` interfaces at `WorkspaceApp.tsx:64-73` — move them too), else the `URL.createObjectURL` + anchor fallback. Refactor `saveProjectToLocalDisk` to call it. Pure refactor; existing save behavior unchanged.

### Step 2 — Viewer capture seam (`CadViewer.tsx`)

Add an imperative capture handle **without** enabling `preserveDrawingBuffer` globally (needless memory/perf tax on every frame forever, for a feature used occasionally):

- New child component inside the `<Canvas>` (beside the existing `ViewerInvalidator` / `controlsRef` pattern, canvas at `CadViewer.tsx:278`): `CaptureBridge({ register })` that uses `useThree` and registers `capture(): string` — synchronously `gl.render(scene, camera)` then `return gl.domElement.toDataURL("image/png")`. Because render and read happen in the same task, the drawing buffer is still valid; no `preserveDrawingBuffer` needed.
- Expose upward as a prop `onRegisterCapture?: (fn: (() => string) | null) => void` on `CadViewer`; `WorkspaceApp` stores it in a ref. Register null on unmount.
- Capture must reflect what the user sees: current camera, current result field, current exaggeration. Do not reframe the camera in v1.

**Two-field capture orchestration** (in `WorkspaceApp`): the report wants both stress and displacement contours, but the viewer shows one at a time. Implement `captureResultViews()`: remember the current result mode; for each of `["stress","displacement"]` that has a `ResultField`, set the mode, wait two `requestAnimationFrame`s (demand-frameloop invalidation + render), then call the capture handle; finally restore the original mode. If a field is absent, skip it — the report renders that figure slot as a labeled "Not available (--)" box rather than failing. Guard with the same staleness discipline used elsewhere: if `viewMode !== "results"` or results were superseded mid-capture, abort report generation with a clear error.

### Step 3 — `reportData.ts` (pure, heavily tested)

```ts
export interface ReportData { /* cover, geometry, material rows, bc rows, mesh, solver,
  results rows, figures: { stressPng?: string; displacementPng?: string; legends... },
  diagnostics: string[], provenanceTier, unitSystem, generatedAtIso, footerDisclaimer } */ }
export function buildReportData(input: {
  project: Project; study: Study; displayModel: DisplayModel | null;
  resultSummary: ResultSummary; resultFields: ResultField[];
  solverMeshSummary: SolverMeshSummary | null; runTiming: RunTimingEstimate | null;
  unitSystem: "SI" | "US"; captures: { stress?: string; displacement?: string };
  generatedAt: Date; exaggeration: number;
}): ReportData
```

All strings fully formatted here (values, units, `--`, `(est.)`, tier labels) so `reportPdf.ts` is layout-only and the formatting is testable without a PDF. Reuse — do not duplicate — `resultSummaryForUnits`, `resultFieldForUnits`, `formatResultProvenanceLabel`, and the mesh/source label helpers; if a formatter is currently private to `RightPanel.tsx` (e.g. `formatMeshSourceLabel`, `formatResultMetric` around `:1583-1618`), export it or lift it into `unitDisplay.ts` rather than copying.

Data notes the executor must honor:
- **Solve time is transient**: `runTiming` (`WorkspaceApp.tsx:156`) is not persisted into results; after a project reload it is null → report shows `--`. Fine for v1; do not persist it in this plan.
- **Seeded/demo values**: if the summary is the seeded bracket demo (`seededSummary`, `WorkspaceApp.tsx:74-80`), provenance labeling already marks it — the tier banner carries that honesty; no extra special-casing.
- Multiple materials/loads/supports are tables, not prose — no assumption of exactly one.

### Step 4 — `reportPdf.ts` (lazy chunk)

`export async function renderReportPdf(data: ReportData): Promise<Blob>`. Statically imports `jspdf`, `jspdf-autotable`, `reportTheme.ts`, and the font URLs — but **is itself only ever loaded via `await import("./report/reportPdf")`**. Implements the content + aesthetics specs above. Internals: a tiny cursor-based layout helper (`y` tracking, `ensureSpace(mm)` page-break, `sectionHeading(n, title)`, `figure(png, legend, caption)`, `calloutBox(...)`), autotable for all tables with the shared theme object, footer drawn in a `didDrawPage` hook with total page count via `putTotalPages`.

The logo: fetch `/opencae-logo.png` (same-origin), draw at header size. Cache the fetched font/logo bytes at module scope so repeat generations are instant.

### Step 5 — UI wiring

- **Button placement**: top of `ResultsPanelContent` (`apps/opencae-web/src/components/RightPanel.tsx:1348-1574`), above the failure-assessment banner — the user asked for the button "on the results page", and this panel *is* the results page. `<button className="primary">` with lucide `FileDown` icon, label "Generate report". Pass `onGenerateReport: () => Promise<void>` and `reportBusy: boolean` down from `WorkspaceApp` through `RightPanel`'s existing prop plumbing.
- **States**: idle → generating ("Generating…", disabled, spinner-safe) → done (returns to idle after save/cancel) → error (surface the message through the existing results-panel notice pattern; never a silent failure). Disable when `resultSummary` is null (shouldn't render then anyway) or a solve is running.
- **Handler in `WorkspaceApp`**: `handleGenerateReport()` — guard `resultSummary`; run `captureResultViews()`; `buildReportData(...)`; `const { renderReportPdf } = await import("./report/reportPdf")`; `saveBlobToDisk(blob, filename, { description: "PDF report", accept: { "application/pdf": [".pdf"] } })`. Wrap in try/finally for the busy flag; catch → error state with the message.

### Step 6 — Guardrails

- `pnpm --filter @opencae/web check:bundle` must pass — the budget script (`scripts/check-web-bundle-budget.mjs`, 175 KB gzip initial) only counts static imports, so this verifies the lazy boundary held. If the report chunk needs naming for cache hygiene, extend `manualChunks` in `apps/opencae-web/vite.config.ts` following the existing viewer/cad pattern (optional).
- No `_headers` CSP change should be needed; if the executor finds one is, stop and reassess the library choice instead of widening CSP.

## Testing

- `reportData.test.ts` (the bulk of coverage): builds fixture `Project/Study/ResultSummary` objects (crib from `RightPanel.test.tsx` fixtures) and asserts — unit conversion matches the panel (SI and US), missing yield strength → `--`, mesh counts get `(est.)` unless solver-sourced, provenance tier strings exact, dynamic study emits transient rows + time-step fields, missing captures → figure slots marked unavailable, diagnostics passed through verbatim, filename slugging.
- `reportPdf.test.ts` (Node smoke test — jsPDF runs under Node): render a full fixture `ReportData` (data-URI 1×1 PNG captures); assert the blob starts with `%PDF`, page count ≥ 2, and no throw on the empty-everything variant (all `--`). Stub the font/logo fetches to the Helvetica fallback path (and assert the fallback doesn't throw).
- Capture orchestration: unit-test `captureResultViews`' mode-cycling/restore logic with an injected fake capture fn and fake RAF; do not attempt WebGL in jsdom.
- Manual verification pass (executor, via the dev server): run the cantilever sample end to end, generate the report, and check — both figures present and matching the on-screen contours, legend colors match the viewer legend, provenance banner correct, prints acceptably in grayscale, regenerating twice works (cached fonts), Save-dialog cancel returns to idle without error UI.

## Verification gates

```sh
pnpm --filter @opencae/web test
pnpm typecheck                              # gate on no NEW errors (pre-existing localCantilever failure is known)
pnpm --filter @opencae/web check:bundle     # 175 KB initial-JS budget must still pass
pnpm --filter @opencae/web build
```

## Done criteria

- On the results page, one **Generate report** button produces a downloaded PDF with cover summary, geometry/material/BC/mesh/solver sections, both contour figures with matching ramp legends, the full results table, and a diagnostics section — all values identical to the on-screen panel (same converters/formatters), with `--` / `(est.)` / provenance-tier honesty preserved and the scope disclaimer in the footer.
- jsPDF and fonts load only on click (bundle budget green); generation works offline once assets are cached; failure paths (no capture handle, font fetch failure, user cancels save) degrade gracefully with visible, honest messaging.
