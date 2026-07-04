# Plan 009: Re-Validate Run Identity After Awaited Result Fetches In `WorkspaceApp`

Base commit: `d1556f2` (origin/main). Execute AFTER plan 006.
Status: TODO
Priority: 4
Category: correctness / result truthfulness

## Problem

When a run's event stream reports `complete`, `WorkspaceApp` fetches the results with `await getResults(...)` and then applies them to app state unconditionally — it never re-checks that this run is still the one the user cares about. Cancelling a run closes its `EventSource` (so no *further* events arrive), but it cannot stop a continuation that is already awaiting the results download. For cloud runs the results fetch is the slowest client-side step (it downloads full field arrays), so the window is real.

Concrete failure: run A completes → the `complete` handler starts `await getResults(A)` → while the download is in flight the user hits Cancel (or Cancel then Run to start run B with changed loads/mesh) → when `getResults(A)` resolves, the stale continuation force-applies A's summary/fields/mesh, sets `completedRunId = A`, and navigates to the Results step (`setViewMode("results")`, `setActiveStep("results")`). The user is now looking at results that do not match the current study configuration — in an engineering tool that is a truthfulness failure, the exact class the project's honest-results policy exists to prevent. If run B is already processing, the stale navigation also buries B's progress view.

A second, smaller instance of the same shape: the `complete` branch calls `setProcessingRunId(null)` and `setRunTiming(null)` unconditionally (before the await). Those lines only run when THIS run's stream fires, and a cancelled run's stream is closed, so today they're mostly benign — but once you add the identity guard, fold these resets under it for consistency.

## Current Evidence

`apps/opencae-web/src/WorkspaceApp.tsx` — the subscription inside `handleRunSimulation` (~lines 1124–1170):

```ts
const source = subscribeToRun(response.run.id, async (event: RunEvent) => {
  if (typeof event.progress === "number") setRunProgress(event.progress);
  setRunTiming(timingFromRunEvent(event));
  pushMessage(messageWithEta(event));
  if (event.type === "complete") {
    source.close();
    if (activeRunSourceRef.current === source) activeRunSourceRef.current = null;
    if (processingRunIdRef.current === response.run.id) processingRunIdRef.current = null;
    setProcessingRunId(null);
    setRunTiming(null);
    try {
      const results = await getResults(response.run.id);
      // ... hasDynamicPlaybackFrames early-return ...
      setResultSummary(results.summary);
      setResultFields(withDerivedSurfaceSafetyFactorFields(results));
      setResultSurfaceMesh(results.surfaceMesh);
      setSolverMeshSummary(solverMeshSummaryFromResults(results));
      setResultFrameIndex(0);
      setResultPlaybackPlaying(false);
      if (study.type === "dynamic_structural") setResultMode("stress");
      setCompletedRunId(response.run.id);
      setViewMode("results");
      setActiveStep("results");
    } catch (error) { /* ... */ }
  } else if (event.type === "cancelled" || event.type === "error") { /* symmetric resets */ }
});
activeRunSourceRef.current = source;
processingRunIdRef.current = response.run.id;
```

`handleCancelSimulation` (~lines 1174–1193) closes the source and clears both refs, then calls `cancelRun(runId)`:

```ts
const runId = processingRunIdRef.current;
activeRunSourceRef.current?.close();
activeRunSourceRef.current = null;
processingRunIdRef.current = null;
setProcessingRunId(null);
```

Note there is NO "this run was abandoned" marker that the in-flight `complete` continuation can observe: after cancel, `processingRunIdRef.current` is `null`, and the continuation never looks at it again anyway.

## Desired Behavior

After `await getResults(...)` resolves (or rejects), the handler applies results/errors ONLY if the run is still current — i.e. it has not been cancelled and no newer run has been started. A stale continuation logs a passive message at most (e.g. via `pushMessage`) and changes no result state and no navigation.

## Implementation Steps

1. Introduce a monotonically increasing run epoch alongside the existing refs in `WorkspaceApp`:

```ts
const runEpochRef = useRef(0);
```

2. In `handleRunSimulation`, right where `processingRunIdRef.current = response.run.id` is assigned, also capture the epoch for this subscription:

```ts
runEpochRef.current += 1;
const runEpoch = runEpochRef.current;
```

3. In `handleCancelSimulation`, increment `runEpochRef.current` (cancelling invalidates any in-flight continuation). Audit the other places that clear `processingRunIdRef.current` (there is one more around line 735 — read its context; if it represents "abandon current run", increment there too).
4. In the `complete` handler, after `await getResults(...)` resolves AND in its `catch`, bail out first:

```ts
if (runEpochRef.current !== runEpoch) {
  pushMessage("Discarded results from a superseded run.");
  return;
}
```

5. Move the unconditional `setProcessingRunId(null)` / `setRunTiming(null)` resets in the `complete` branch behind the same `processingRunIdRef.current === response.run.id` condition that already guards the ref clear (they are semantically "this run stopped processing" statements).
6. Leave the `cancelled`/`error` branch's resets as-is except for applying the same ref-guard consistency if trivial.
7. Tests: follow the existing harness in `apps/opencae-web/src/App.workflow.test.ts` (it drives run flows with mocked api-module functions). Add a test that:
   - starts a run, delivers `complete`, but makes the mocked `getResults` return a promise you resolve manually;
   - triggers cancel (and optionally a second run start) before resolving;
   - resolves the deferred `getResults`;
   - asserts result state was NOT applied (no `completedRunId`, view/step unchanged, second run's processing state intact).
   If `App.workflow.test.ts`'s harness can't reach this depth, extract the subscription callback into a testable function first — but keep the extraction minimal and inside `WorkspaceApp.tsx` unless the file already has a pattern for extracted handlers.

## Verification Gates

```sh
pnpm --filter @opencae/web exec tsc --noEmit
pnpm test
```

Expected: exit 0; the new stale-continuation test fails before the code change (results applied) and passes after.

## Done Criteria

- A cancelled or superseded run's `getResults` continuation cannot mutate result state or navigation (proven by the new test).
- Normal single-run completion behavior is unchanged (existing workflow tests stay green with unchanged expectations).
- No changes outside `apps/opencae-web/src/WorkspaceApp.tsx` and its tests.

## Out Of Scope

- Server/Worker-side cancellation semantics and the R2 start-claim race (plan 004).
- `subscribeToRun` internals in `apps/opencae-web/src/lib/api.ts` (its reconnect/error handling is separate).
- Any UI redesign of run progress.

## Maintenance Note

Every future `await` added inside run-event handlers must re-check the epoch after resuming. If more async steps accumulate, consider promoting the epoch check into a small `isRunCurrent(epoch)` helper next to the refs.

## Escape Hatches

- If the code at the cited lines has moved or been refactored (e.g. the subscription extracted elsewhere), re-locate by searching for `subscribeToRun(` in `WorkspaceApp.tsx`; if the control flow differs materially from the excerpt, STOP and report.
- If existing tests encode the current stale-apply behavior (unlikely but possible), STOP and report rather than editing their expectations.
