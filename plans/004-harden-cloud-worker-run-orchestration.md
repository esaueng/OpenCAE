# Plan 004: Harden Cloud Worker Run Orchestration

Base commit: `3a67db9`
Status: TODO
Priority: 4
Category: reliability

## Problem

The Cloudflare Worker Core Cloud run flow is close, but two reliability details are weak:

1. Duplicate start protection uses a non-atomic R2 `head` then `put`.
2. Event streaming returns the current event list and closes, so browser `EventSource` relies on reconnecting snapshots instead of a live stream with monotonic replay.

Under concurrent start requests, both requests can observe no `started.json` before either writes it. Under long solves, the UI can see stale progress until the next reconnect and cannot use event ids for precise replay.

## Current Evidence

`apps/opencae-web/worker/index.ts`:

```ts
async function claimCoreCloudRunStart(env: Env, runId: string): Promise<boolean> {
  const bucket = (env as CoreCloudEnv).CORE_CLOUD_ARTIFACTS;
  if (!bucket) throw new Error("CORE_CLOUD_ARTIFACTS is not bound.");
  const startKey = runStartedKey(runId);
  const existing = await bucket.head(startKey);
  if (existing) return false;
  await bucket.put(startKey, JSON.stringify({ startedAt: new Date().toISOString() }));
  return true;
}
```

`apps/opencae-web/worker/index.ts`:

```ts
async function readCoreCloudEventsStream(env: Env, runId: string): Promise<Response> {
  const events = await readEvents(env, runId);
  return new Response(
    events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", ... } }
  );
}
```

`apps/opencae-web/src/lib/api.ts`:

```ts
const source = new EventSource(cloudEventsUrlByRunId.get(runId) ?? `/api/runs/${runId}/stream`);
```

Worker tests currently prove sequential duplicate starts do not dispatch twice, but they do not simulate the race between `head` and `put`.

## Desired Behavior

- Starting a cloud run is idempotent and race-safe.
- At most one request can dispatch a given run to the container.
- Event clients receive an ordered stream or a well-defined polling/replay contract.
- Cancellation and completion cannot produce contradictory final state.
- Tokens stay out of start/results URLs when fetch can use headers; any remaining query token use is documented and constrained to EventSource limitations.

## Implementation Steps

1. Replace the non-atomic start claim.
   - Preferred: use a Durable Object keyed by run id to serialize start/cancel/complete transitions.
   - Acceptable smaller step: use R2 conditional `put` if the generated Worker types support the needed `onlyIf` precondition. The local `worker-configuration.d.ts` includes `R2PutOptions.onlyIf`; confirm exact semantics in the current Cloudflare runtime before implementation.
   - Add a helper with one responsibility, for example `tryClaimRunStart(env, runId)`.

2. Add a concurrency regression test.
   - Extend the test R2 mock so `head(startedKey)` can be delayed for two concurrent callers.
   - Fire two `start` requests with the same token before either claim resolves.
   - Assert only one returns success and `containerMock.fetch` calls `/solve` once.
   - If using a Durable Object abstraction, test the state machine directly with parallel starts.

3. Define the event delivery contract.
   - Option A: implement a live `ReadableStream` SSE endpoint in the Worker that polls R2 briefly while a run is non-terminal, emits event ids, and closes on terminal events.
   - Option B: stop pretending it is a live stream. Make the Worker return JSON snapshots for cloud events, and change the web client to poll `/events` with backoff until a terminal event.
   - Choose one option and document it in tests. Do not leave the current reconnecting snapshot behavior implicit.

4. Add event ids and replay semantics if keeping SSE.
   - Include `id: <sequence>` in each SSE message.
   - Honor `Last-Event-ID` when replaying from stored events.
   - Preserve terminal close behavior.
   - Include the same security headers returned by JSON API routes unless streaming constraints prevent a header.

5. Tighten cancel/complete ordering.
   - In `runCoreCloudSolve`, after `validateCoreCloudResult` and before writing results, re-read events and stop if cancelled.
   - After writing results but before appending complete, keep the existing cancellation check.
   - Add a test for cancellation arriving while the solve response is pending; expected behavior should be either cancelled without result write or cancelled with a clear ignored-late-result policy, not both cancelled and complete.

6. Token handling cleanup.
   - Keep `headerTokenRequest(...)` for `start` and `results`.
   - For EventSource, if query tokens remain necessary, shorten token lifetime by deleting `auth.json` or marking it consumed after terminal events.
   - Add tests that terminal runs no longer allow result/event reads after any selected expiry/deletion policy, or explicitly document retention if users need downloadable reports.

## Verification Gates

Run:

```sh
pnpm test apps/opencae-web/worker/index.test.ts apps/opencae-web/src/lib/api.test.ts
pnpm verify:cloudflare-config
pnpm --filter @opencae/web exec tsc --noEmit
pnpm test
```

Expected:

- Worker race test proves one container solve per run.
- Event delivery tests describe either live SSE replay or explicit polling.
- Existing Core Cloud fail-closed tests still pass.

## Done Criteria

- Start claim is race-safe.
- Duplicate concurrent starts cannot dispatch duplicate solves.
- The web client has deterministic progress behavior for cloud runs.
- Cancellation cannot be followed by a misleading complete event.
- Token-in-query behavior is minimized or explicitly limited to the event transport.

## Out Of Scope

- Do not redesign the container solver protocol.
- Do not change Core Cloud result validation rules.
- Do not add user accounts or cross-user authorization.

## Escape Hatches

If Cloudflare R2 conditional writes do not provide a reliable create-if-absent primitive, stop and implement the Durable Object state machine instead of attempting another R2-only lock.
