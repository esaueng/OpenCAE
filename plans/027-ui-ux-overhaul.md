# 027 — UI/UX Overhaul

## Status

Proposed on 2026-09-04 against `origin/main` at `8d87c456`, on branch
`claude/ui-ux-overhaul-cc6067`. Nothing in this plan is implemented yet;
the branch carries only this document.

This continues the September design review (PR #99, merged 2026-09-03), which
fixed the broken states and added the missing component tier to `tokens.css`.
That work made a redesign *affordable*. It did not redesign anything: every
panel still has the structure it was assembled with. This plan is the
redesign, scoped to what the survey below actually shows.

## Survey (dev server, this tree, 1440x900, both themes)

Walked the static Bracket Demo through all seven steps and one solve.

What is right and stays: the shell grid, the workflow rail, the top bar, the
view cube, the Results headline (verdict card + four KPIs), the honesty
vocabulary, the light theme (now correct after PR #99).

What is wrong, per step:

| Step | Observed | Consequence |
| - | - | - |
| Model | Panel leads with the three-card sample gallery, then Analysis type, then "Load static sample", "Replace model", parametric builder. Dimensions, orientation and section controls are below the fold. | The step named "Model" is mostly about *choosing a different* model. Once a part is loaded, the primary content is inspection, not selection. |
| Material | "Base material" card lists modulus/density/yield; "Simulation properties" lists the same three values again; "Apply material & process" is always shown even when nothing changed; the "Assigned" section is below the fold. | Three cards for one fact. The apply button reads as a required action when it is not. |
| Supports | Lean. Face-pick prompt, one support card, one help callout. | Target quality for the other panels. |
| Loads | Lean editor, but "Load cases" (Default / Enabled / 1 load / Add load case) is always expanded. | An advanced feature costs 90 px on every static study with one case. |
| Mesh | Rows read "Nodes: Reported after solve", "Elements: Reported after solve", "Warnings: 1" with no way to read the warning; "Mesh convergence" (case select, probe XYZ, run) is fully expanded. | A stats table that contains no stats. A warning count that cannot be opened. |
| Run | Readiness checklist, Analysis type (again), fidelity, run button, solver rows. | Analysis type appears at start gallery, Model and Run. Only Run's mutates the study (review 3.4). |
| Results | Headline is good. Below it, "Result mode" is three stacked full-width buttons while "Stress measure" next to it is a segmented control. | Two controls of the same kind, two idioms. |
| Viewer chrome | Bottom-left `X Y Z Iso` strip duplicates the view cube; `Perspective / Orthographic` toggle is low contrast. | Two camera controls, two reducers (review 3.4). |
| Rail footer | `study static / units mm Metric` in 10 px mono with no labels. | Duplicates the top-bar breadcrumb ("Bracket Demo / Static Stress") in a form nobody can read. |
| Status bar | Tips, Logs, status pill, "Built by Esau Engineering", Ko-fi, feedback, github. | Utility links share the strip with live solver status. |
| Identity | `--font-ui` declares IBM Plex Sans; there is no `@font-face`; the app renders in system-ui while the PDF is set in Plex (review 2.13). | The report and the app look like two products. |

Not verified in this pass: the 390 px layout (the browser pane was hidden
when the mobile capture ran). PR #99 verified it on 2026-09-03; re-check
before PR B ships.

## Direction

**Restructure, do not re-skin.** The palette, spacing scale, radii and the
shell are sound and pinned by tests. The gap is information architecture:
each panel should lead with the *state of this study* and demote setup,
alternatives and advanced controls behind the existing `Collapsible`.
`SupportsPanel` is the model: it asks one question and shows one answer.

Rules for every panel:

1. First block answers "what is set right now" for this step.
2. Actions that change that state come second.
3. Alternatives (other samples, other analysis types) and advanced tools
   (convergence, load cases) live in a closed `Collapsible`.
4. Placeholder text never occupies a value cell. Unknown values render `--`
   with the reason in the helper line, per the honest-results convention.

## Increments

Each is one PR. Order matters: A and B touch the same panel tests.

### A — Identity: IBM Plex on screen (decision required)

Ship the typeface the tokens already declare. `src/report/fonts/` holds the
two TTFs (200 KB each, 403 KB total). Shipping TTFs as-is would breach
`STATIC_ASSET_BUDGET_BYTES` (256 KB) per file and add ~400 KB to the precache;
they must be subset and converted to WOFF2 (Latin + Latin-1 + the symbols the
UI uses: `×`, `°`, `–`, `—`, `→`, `·`, `±`, `≈`). Expect ~30–40 KB per
weight. No subsetting tool is installed on this machine (`pyftsubset`,
`woff2_compress` absent, no `fontTools`); add `fonttools` + `brotli` as a
one-off dev dependency of a `scripts/build-fonts.mjs` step, or commit the
built WOFF2 files with the subsetting command recorded in the file header.
Add `@font-face` with `font-display: swap`, a `<link rel="preload">` for the
regular weight, and extend the web asset budget test to cover `.woff2`.
Plex Mono is a separate decision: it is not in the repo and `--font-mono`
falls back to `ui-monospace` today, which is acceptable.

Alternative if declined: change `--font-ui` to `system-ui` first and drop the
lie from the token. Either answer is fine; the current state is neither.

### B — Panel information architecture

- **Model:** lead with a model card (source, body count, bounding box in
  the active units, face count), then view mode / dimensions / section
  plane. Move sample gallery + analysis type + "Load static sample" into a
  closed `Collapsible` titled "Change model". This removes the Model-step
  analysis type duplicate (review 3.4). Keep "Replace model" visible.
- **Material:** one card: name, process, the three effective properties,
  "Change" link. Show "Apply material & process" only when the picker holds
  an unapplied selection. Drop the "Base material" / "Simulation
  properties" duplication; keep the manufacturing-process compatibility
  copy.
- **Loads:** `Load cases` becomes a `Collapsible`, open only when the study
  has more than one case or a combination.
- **Mesh:** after generation, show a real stats card (node/element counts
  from the mesh summary when present, `--` otherwise with the helper line
  explaining they arrive with results). "Warnings: 1" becomes an expandable
  list of the warning strings. `Mesh convergence` becomes a closed
  `Collapsible`.
- **Run:** the analysis-type buttons carry a forward warning (title text and,
  on first click, an inline card with a cancel) whenever the switch would
  clear the current supports and loads — structural ↔ thermal in either
  direction, as `handleChangeStudyType` does. Only a second click switches.
  Landed separately (increment E) after B.
- **Results:** `Result mode` becomes a segmented control matching
  `Stress measure`. Nothing else moves; the headline stays.

Cost: `RightPanel.test.tsx` pins seven panel-eyebrow/step strings and
the panel markup for all seven steps; `App.workflow.test.ts`,
`performanceRewrite.test.ts` (7 sites), `BottomPanel.test.tsx` and
`ProjectStorageNotice.test.tsx` read `WorkspaceApp.tsx` as source text. Panel
restructuring does not touch `WorkspaceApp.tsx`, so only the RightPanel suite
needs rewriting. Rewrite those assertions to test behavior (what is visible,
what is disabled), not markup strings, in the same PR.

### C — Chrome (measured 2026-09-04: withdrawn)

- The `X Y Z Iso` strip stays. The view cube is drawn inside the WebGL
  canvas and is not keyboard-operable; the strip (`role="group"`, "Camera
  views") is the only accessible camera control. Its muted labels measure
  5.3:1 on their own background in dark mode, so the "low contrast" claim
  does not reproduce. The two-row wrap at 390 px is pre-existing and equal
  with the system font.
- The rail footer readout is labeled (`study`, `units`) and carries the
  units toggle; not worth a change.
- The status bar is left alone: moving the Ko-fi link out of the persistent
  strip changes donation exposure, which is the maintainer's call, not a
  design fix.

### D — Copy sweep (scoped down after grepping the tree)

The review's list was partly stale: the top bar no longer has a "Download
Project" button (it is "Storage" + Cmd+S "Save project"), so the four "Use
Save project" messages match the shortcut label and stay. What remained:
the legend's six Title Case result titles ("Von Mises Stress", "Principal
Stress σ₁/σ₃", "Maximum Shear Stress", "Normalized Mode Shape", "Heat Flux",
"Safety Factor") → sentence case; "Clear All" / "Clear List" → sentence
case; the Run readiness hint, which lowercased the whole item list (so
"STEP" became "step"), now uses the same "Complete before running: …"
phrasing as the top-bar tooltip. The negative guard in `RightPanel.test.tsx`
(`not.toContain("Von Mises Stress")`) was updated to the new string in the
same commit so it keeps testing something.

## Not in this plan

- Any change to the result ramp, the sample-thumbnail palette, the z-index
  scale, or the light/dark token values.
- Run comparison / run history (review 3.1 expensive half). Needs run
  bookkeeping in the project file; separate plan.
- `RightPanel.tsx` / `CadViewer.tsx` decomposition (plan 024 release 5B).
  B will split `ModelPanel` and `MeshPanel` into their own files because the
  restructure rewrites them anyway; nothing else moves.

## Verification per PR

`pnpm --filter @opencae/web exec tsc --noEmit`, `pnpm test`, the dev server
walked through all seven steps at 1440, 1024 and 390 in both themes, and
for A: `pnpm --filter @opencae/web build` plus the asset budget script.
Remember: `pnpm build:core` first, and restart the dev server after clearing
`node_modules/.vite` — deleting it under a running server yields 504
"Outdated Optimize Dep" on every lazy chunk.

## Decisions needed before A and B start

1. Plex on screen (A) — yes, or drop it from the token.
2. Confirm "restructure, not re-skin". If a new visual identity is wanted,
   that is a different plan and should come before B, not after.
3. Model step: keep the sample gallery reachable from the panel (collapsed),
   or only from the start screen.
