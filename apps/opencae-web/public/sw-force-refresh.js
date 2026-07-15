(() => {
  const refreshParam = "opencae-sw-refresh";
  // A service worker activates once per newly installed build. Use that
  // activation's timestamp instead of a hand-maintained release string so
  // every deploy moves already-open tabs onto the new precached app shell.
  // A frozen value leaves long-lived CAE sessions running old mesh/solver
  // code even after a corrected bundle has reached production.
  const refreshVersion = String(Date.now());

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        await Promise.all(
          windowClients.map(async (client) => {
            if (typeof client.navigate !== "function") return;
            let url;
            try {
              url = new URL(client.url);
            } catch {
              return;
            }
            if (url.origin !== self.location.origin) return;
            if (url.searchParams.get(refreshParam) === refreshVersion) return;
            url.searchParams.set(refreshParam, refreshVersion);
            try {
              await client.navigate(url.href);
            } catch {
              // Navigation can fail if the tab closes during activation.
            }
          })
        );
      })()
    );
  });
})();
