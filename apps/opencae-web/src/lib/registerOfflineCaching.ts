// Service-worker registration (plan Workstream C). Production builds only:
// dev and vitest never register (import.meta.env.PROD is false there), so
// local iteration keeps vite's plain module serving and tests stay hermetic.
//
// The registration itself (virtual:pwa-register) is dynamically imported so
// the initial bundle only carries this tiny guard; the Workbox client lands
// in its own lazy chunk.
import { advanceOfflineReadiness } from "./offlineStatus";

export function registerOfflineCaching(): void {
  if (!import.meta.env.PROD) return;
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    advanceOfflineReadiness("unsupported");
    return;
  }
  advanceOfflineReadiness("preparing");

  // navigator.serviceWorker.ready resolves once a SW for this scope is
  // ACTIVE. The generated Workbox SW only activates after install has
  // fetched + cached the ENTIRE precache manifest (a single failed asset
  // fails the install), so this is an honest "all offline assets cached" —
  // including the ~10.7 MiB gmsh .wasm.gz, which downloads in the SW's
  // background install without blocking the app.
  navigator.serviceWorker.ready
    .then(() => advanceOfflineReadiness("ready"))
    .catch(() => advanceOfflineReadiness("failed"));

  import("virtual:pwa-register")
    .then(({ registerSW }) =>
      registerSW({
        immediate: true,
        onRegisterError: () => advanceOfflineReadiness("failed")
      })
    )
    .catch(() => advanceOfflineReadiness("failed"));
}
