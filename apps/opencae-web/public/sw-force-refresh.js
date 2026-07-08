(() => {
  const refreshParam = "opencae-sw-refresh";
  const refreshVersion = "2026-07-08-csp-eval";

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
