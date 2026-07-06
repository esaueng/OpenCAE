// Offline PWA proof (plan Workstream C): the app must GENUINELY work with no
// network. Two-part evidence, one self-contained run:
//
// 1. Dist audit — parse the Workbox precache manifest out of dist/sw.js and
//    assert it covers every JS/CSS chunk, the app shell, and the wasm assets
//    (gmsh-core-<hash>.wasm.gz + assets/gmsh-wasm.json + occt wasm), and that
//    it does NOT reference the raw gmsh-core-<hash>.wasm that
//    compressGmshWasmForDeploy deletes in closeBundle. This is the guard for
//    the closeBundle ordering trap: vite-plugin-pwa must glob dist AFTER the
//    compress plugin rewrote it.
// 2. Browser proof — spawn `vite preview` + headless Chrome, load the app
//    once online, wait for the service worker to activate (= full precache,
//    wasm included) and for the footer to say "Offline-ready"; then KILL the
//    server, force CDP network emulation offline, reload ?meshProof=run and
//    run the bracket study end-to-end (wasm mesh -> local solve) while
//    logging every network event. Pass requires zero successful fetches from
//    the network (every response served by the SW) and the solve's reaction
//    matching the applied 500 N.
//
// Usage (Node >= 22 for global WebSocket + fetch; Chrome installed):
//   pnpm --filter @opencae/web build
//   node scripts/verify-offline-pwa.mjs
// Env: PORT (5199), CDP_PORT (9334), CHROME_BIN, PROOF_TIMEOUT_MS (240000).
// Exit codes: 0 proof ok, 1 gate failed, 2 timeout.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5199);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334);
const CHROME_BIN = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 240_000);
const APPLIED_NEWTONS = 500;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "apps/opencae-web/dist");

function fail(message) {
  console.error(`OFFLINEPROOF FAIL: ${message}`);
  process.exitCode = 1;
}

function listDistFiles(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...listDistFiles(path, base));
    else files.push(relative(base, path));
  }
  return files;
}

// ── Phase 1: dist audit (closeBundle ordering trap) ────────────────────────
function auditDist() {
  const swSource = readFileSync(join(distDir, "sw.js"), "utf8");
  const manifestMatch = swSource.match(/precacheAndRoute\((\[.*?\])\s*,/s);
  if (!manifestMatch) throw new Error("dist/sw.js has no precacheAndRoute([...]) manifest.");
  const entries = JSON.parse(manifestMatch[1].replace(/([{,])(\w+):/g, (_all, sep, key) => `${sep}${JSON.stringify(key)}:`));
  const precached = new Set(entries.map((entry) => entry.url.replace(/^\.?\//, "").split("?")[0]));

  const distFiles = listDistFiles(distDir);
  const swMachinery = /(^|\/)(sw\.js|workbox-[^/]*\.js|registerSW\.js)$/;
  const rawGmsh = /(^|\/)gmsh-core-[^/]*\.wasm$/;
  const required = distFiles
    .filter((file) => !swMachinery.test(file) && !rawGmsh.test(file))
    .filter((file) => /\.(js|css|html|png|wasm|webmanifest)$/.test(file) || /gmsh-core-[^/]*\.wasm\.gz$/.test(file) || file === "assets/gmsh-wasm.json");

  const missing = required.filter((file) => !precached.has(file));
  const forbidden = [...precached].filter((url) => rawGmsh.test(url));
  const rawInDist = distFiles.filter((file) => rawGmsh.test(file));
  const hasGmsh = distFiles.some((file) => /gmsh-core-[^/]*\.wasm\.gz$/.test(file));

  console.log(`[dist] precache entries: ${entries.length}`);
  console.log(`[dist] wasm entries: ${[...precached].filter((url) => url.includes(".wasm")).join(", ") || "(none — flag-off build)"}`);
  if (missing.length) throw new Error(`precache manifest is missing required offline assets: ${missing.join(", ")}`);
  if (forbidden.length) throw new Error(`precache manifest references the deleted raw gmsh wasm: ${forbidden.join(", ")}`);
  if (rawInDist.length) throw new Error(`raw gmsh wasm still present in dist (compress plugin did not run): ${rawInDist.join(", ")}`);
  const manifestEntry = entries.find((entry) => entry.url.replace(/^\//, "") === "assets/gmsh-wasm.json");
  if (hasGmsh && !manifestEntry?.revision) {
    throw new Error("assets/gmsh-wasm.json is precached without a content revision; updates would pin a stale manifest.");
  }
  console.log("[dist] audit OK: shell + all chunks + wasm assets precached; raw gmsh wasm absent.");
  return hasGmsh;
}

// ── Process + CDP helpers ───────────────────────────────────────────────────
const children = [];
// detached => own process group, so killChild(-pid) takes wrapper AND
// grandchildren with it (npx/pnpm wrappers otherwise leave the real server
// alive, which would fake the "offline" phase).
function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "ignore", detached: true, ...options });
  children.push(child);
  return child;
}
function killChild(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
function cleanup() {
  for (const child of children) killChild(child);
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(2));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectCdp() {
  const targets = await waitFor("Chrome DevTools endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const list = await response.json();
    return list.find((target) => target.type === "page") ?? null;
  });
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    eventHandlers.get(message.method)?.(message.params);
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, handler) => eventHandlers.set(method, handler)
  };
}

async function evaluate(cdp, expression) {
  const evaluated = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (evaluated.result?.exceptionDetails) throw new Error(JSON.stringify(evaluated.result.exceptionDetails).slice(0, 400));
  return evaluated.result?.result?.value;
}

// ── Phase 2: browser proof ──────────────────────────────────────────────────
async function browserProof() {
  const preview = spawnChild("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: join(repoRoot, "apps/opencae-web")
  });
  await waitFor("preview server", async () => (await fetch(`http://localhost:${PORT}/`)).ok);
  console.log(`[serve] vite preview on :${PORT}`);

  const profileDir = mkdtempSync(join(tmpdir(), "opencae-offline-proof-"));
  spawnChild(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "about:blank"
  ]);
  const cdp = await connectCdp();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");

  // Network evidence log; only consulted after the offline flip.
  let offline = false;
  const requests = new Map();
  const postOfflineResponses = [];
  const postOfflineFailures = [];
  cdp.on("Network.requestWillBeSent", (params) => {
    requests.set(params.requestId, params.request.url);
  });
  cdp.on("Network.responseReceived", (params) => {
    if (!offline) return;
    postOfflineResponses.push({
      url: params.response.url,
      status: params.response.status,
      fromServiceWorker: params.response.fromServiceWorker === true,
      fromCache: params.response.fromDiskCache === true || params.response.fromPrefetchCache === true
    });
  });
  cdp.on("Network.loadingFailed", (params) => {
    if (!offline) return;
    postOfflineFailures.push({ url: requests.get(params.requestId) ?? "(unknown)", error: params.errorText });
  });

  // Online pass: install the SW, wait for full precache + honest indicator.
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });
  const cacheReport = await waitFor(
    "service worker activation + full precache",
    async () => {
      const report = await evaluate(
        cdp,
        `(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          if (!registration || !registration.active) return null;
          const urls = [];
          for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
          }
          return JSON.stringify({ scope: registration.scope, cached: urls.sort() });
        })()`
      );
      return report ? JSON.parse(report) : null;
    },
    120_000,
    1_000
  );
  const cached = new Set(cacheReport.cached);
  const mustBeCached = ["/index.html", "/assets/gmsh-wasm.json"];
  const cachedGz = cacheReport.cached.filter((url) => /gmsh-core-.*\.wasm\.gz$/.test(url));
  const cachedOcct = cacheReport.cached.filter((url) => /occt-import-js-.*\.wasm$/.test(url));
  for (const url of mustBeCached) if (!cached.has(url)) throw new Error(`SW active but ${url} not in CacheStorage.`);
  if (!cachedGz.length) throw new Error("SW active but no gmsh-core-*.wasm.gz in CacheStorage.");
  if (!cachedOcct.length) throw new Error("SW active but no occt-import-js-*.wasm in CacheStorage.");
  console.log(`[online] SW active; ${cacheReport.cached.length} cached URLs incl. ${cachedGz[0]} and ${cachedOcct[0]}`);

  const footerText = await waitFor(
    "footer offline indicator",
    () => evaluate(cdp, `document.querySelector(".start-footer .local-runtime")?.textContent ?? ""`).then((text) => (text.includes("Offline-ready") ? text : null)),
    30_000,
    500
  );
  console.log(`[online] footer: "${footerText.trim()}"`);

  // Go offline for real: dead server + CDP network emulation.
  killChild(preview);
  const serverDead = await waitFor(
    "preview server to die",
    () =>
      fetch(`http://localhost:${PORT}/`).then(
        () => null,
        () => true
      ),
    10_000,
    250
  ).catch(() => false);
  if (!serverDead) throw new Error("preview server still reachable after kill; offline proof would be meaningless.");
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  offline = true;
  console.log("[offline] preview server killed + CDP network emulation offline:true");

  // Offline pass: reload straight into the production run proof.
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/?meshProof=run` });
  const result = await waitFor(
    "offline bracket mesh+solve run",
    async () => {
      const value = await evaluate(
        cdp,
        `window.__opencaeMeshProof && window.__opencaeMeshProof.lastRunResult ? JSON.stringify(window.__opencaeMeshProof.lastRunResult) : null`
      );
      return value ? JSON.parse(value) : null;
    },
    TIMEOUT_MS,
    1_000
  );

  console.log("[offline] run result:", JSON.stringify(result, null, 2));
  const networkServed = postOfflineResponses.filter((entry) => !entry.fromServiceWorker && /^https?:/.test(entry.url));
  console.log(`[offline] responses: ${postOfflineResponses.length} total, ${postOfflineResponses.filter((entry) => entry.fromServiceWorker).length} from SW, ${networkServed.length} from network`);
  console.log(`[offline] failed fetches (expected for third-party beacons): ${postOfflineFailures.length}`);
  for (const entry of postOfflineFailures.slice(0, 5)) console.log(`  [failed] ${entry.url} (${entry.error})`);

  const gates = [];
  if (networkServed.length) gates.push(`network-served responses after offline flip: ${networkServed.map((entry) => entry.url).join(", ")}`);
  if (!result.ok || !result.completed) gates.push(`run did not complete offline: ${result.error ?? "unknown"}`);
  if (!result.sawMeshingEvents) gates.push("no meshing phase events (wasm mesh did not run)");
  if (!result.sawSolveEvents) gates.push("no solve phase events");
  if (result.results?.labeledLocal !== true) gates.push("results not labeled as local browser solve");
  const reaction = result.results?.reactionForce;
  if (typeof reaction !== "number" || Math.abs(reaction - APPLIED_NEWTONS) / APPLIED_NEWTONS > 0.01) {
    gates.push(`reaction ${reaction ?? "n/a"} N does not match applied ${APPLIED_NEWTONS} N`);
  }
  rmSync(profileDir, { recursive: true, force: true });
  if (gates.length) throw new Error(gates.join(" | "));

  console.log(`OFFLINEPROOF OK: shell + meshWorker + gmsh-wasm + solve all served by the service worker with the server dead;` +
    ` reaction ${reaction.toFixed(1)}/${APPLIED_NEWTONS} N, maxStress ${result.results?.maxStress?.toFixed(2)} ${result.results?.maxStressUnits ?? ""}.`);
}

try {
  const hasGmsh = auditDist();
  if (!hasGmsh) {
    console.log("OFFLINEPROOF NOTE: flag-off dist (no gmsh assets) — dist audit only, browser proof needs the default build.");
    process.exit(0);
  }
  await browserProof();
  process.exit(0);
} catch (error) {
  if (String(error?.message ?? error).startsWith("Timed out")) {
    console.error(`OFFLINEPROOF TIMEOUT: ${error.message}`);
    process.exit(2);
  }
  fail(error?.message ?? String(error));
  process.exit(1);
}
