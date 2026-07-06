// Offline-readiness indicator state (plan Workstream C). The start-screen
// footer already says "Runs locally"; this store extends it TRUTHFULLY:
//
// - "Offline-ready" may only be shown once the service worker is ACTIVE.
//   The generated Workbox SW activates strictly after its install step has
//   fetched and cached every precache-manifest entry (app shell, all JS/CSS
//   chunks, gmsh .wasm.gz + manifest, occt wasm — see offlinePrecache.ts),
//   so an active SW is an honest "everything needed is cached".
// - "Preparing offline assets…" while the first install is still caching.
// - Nothing at all when there is no service worker (dev, vitest, unsupported
//   browsers, or a failed registration) — no fake states.
//
// The transition function is pure so the state machine is unit-testable.

export type OfflineReadiness =
  | "unknown" // before registration is attempted (also dev/vitest, where it never is)
  | "unsupported" // no serviceWorker API in this browser
  | "preparing" // registration in flight / first install still precaching
  | "ready" // active SW: full precache manifest is cached
  | "failed"; // registration or install failed

/**
 * Pure transition: once "ready", never downgrade. An update installing later
 * (autoUpdate flow) does not invalidate the already-cached current version,
 * so flipping back to "preparing" would be dishonest in the other direction.
 */
export function nextOfflineReadiness(current: OfflineReadiness, requested: OfflineReadiness): OfflineReadiness {
  if (current === "ready") return "ready";
  return requested;
}

/** Footer indicator text; null renders nothing (never misleading). */
export function offlineReadinessLabel(status: OfflineReadiness): string | null {
  switch (status) {
    case "ready":
      return "Offline-ready";
    case "preparing":
      return "Preparing offline assets…";
    default:
      return null;
  }
}

let current: OfflineReadiness = "unknown";
const listeners = new Set<() => void>();

export function getOfflineReadiness(): OfflineReadiness {
  return current;
}

export function advanceOfflineReadiness(requested: OfflineReadiness): void {
  const next = nextOfflineReadiness(current, requested);
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeOfflineReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: stores are module singletons, so suites must be able to reset. */
export function resetOfflineReadinessForTests(): void {
  current = "unknown";
  listeners.clear();
}
