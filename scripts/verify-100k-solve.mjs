// Cross-engine browser proof for the 100k-DOF solve cap (plan 015: the cap
// stays at 60k "until the typed-array builder and a WebKit target-scale run
// land" — this is that run, automated). Drives the ?solveBench=1 harness
// (apps/opencae-web/src/workers/solveBenchHarness.ts) through a REAL
// gmsh-wasm mesh + solve-worker solve at ~99.3k DOFs in:
//   1. headless Chrome via CDP (V8), and
//   2. Playwright WebKit (JavaScriptCore — the iOS-class engine the staged
//      cap was waiting on; earlier solve benchmarks were V8-only).
//
// Hard gates (any failure exits 1):
//   - both engines complete the solve with ok:true and all sanity flags true
//     (finite positive maxStress/maxDisplacement, reaction within 1% of the
//     applied 500 N);
//   - both engines solved the SAME model: identical DOF count, inside the
//     90k..100k band;
//   - cross-engine result parity: maxStress / maxDisplacement / reactionForce
//     match within 1e-6 relative;
//   - wall time per engine under SOLVE_BENCH_MAX_MS (default 120 s ~= 3x the
//     measured 2026-07 baseline: Chrome ~13 s, WebKit ~40 s solve wall time);
//   - memory stays inside the measured envelope, on two separate metrics:
//     (a) JS-heap peak (the plan's stop metric) under MEMORY_STOP_BYTES
//         (1.5 GB). Chrome does not expose performance.memory inside dedicated
//         workers (verified 2026-07), so the harness reports the main-thread
//         heap and the in-worker sampling stays n/a; the authoritative solver
//         heap number was measured in-process at bench scale: 609 MB peak
//         (49 MB heap + 560 MB typed arrays) — 40% of the stop line.
//     (b) whole-renderer kernel phys_footprint_peak (plus ps-RSS fallback)
//         under MEMORY_STOP_PROCESS_BYTES (2 GB). Measured healthy baseline
//         2026-07: 1.62 GB lifetime peak for the full bench tab — of which
//         1.14 GB is reached during gmsh-wasm MESHING, before any solve
//         starts (meshing density is not gated by maxDofs and peaks the same
//         today at the 60k cap; the 60k-counterfactual bench peaked 1.13 GB).
//         The 2 GB tripwire exists to catch a regression that blows past this
//         measured envelope, not to re-litigate the meshing cost.
//
// Usage (Node >= 22; Chrome installed; playwright-webkit in a SCRATCH dir,
// never in repo deps — pass PLAYWRIGHT_WEBKIT_DIR or let the script
// npm-install it into a temp dir on first run):
//   pnpm --filter @opencae/web build
//   node scripts/verify-100k-solve.mjs
// Env: PORT (5199), CDP_PORT (9335), CHROME_BIN, PROOF_TIMEOUT_MS (600000),
//      SOLVE_BENCH_MAX_MS (120000), MEMORY_STOP_BYTES (1.5e9),
//      MEMORY_STOP_PROCESS_BYTES (2e9),
//      BENCH_MESH_SIZE_MM (debug: off-scale mesh for memory comparisons;
//      off-band DOF counts fail the gates by design),
//      PLAYWRIGHT_WEBKIT_DIR, SKIP_WEBKIT=1 / SKIP_CHROME=1 (debug only:
//      skipping an engine always exits non-zero because the gate is
//      explicitly cross-engine).
// Exit codes: 0 all gates pass, 1 gate failed, 2 timeout.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5199);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9335);
const CHROME_BIN = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 600_000);
const SOLVE_BENCH_MAX_MS = Number(process.env.SOLVE_BENCH_MAX_MS ?? 120_000);
const MEMORY_STOP_BYTES = Number(process.env.MEMORY_STOP_BYTES ?? 1.5e9);
const MEMORY_STOP_PROCESS_BYTES = Number(process.env.MEMORY_STOP_PROCESS_BYTES ?? 2e9);
const RESULT_PARITY_REL_TOL = 1e-6;
const BENCH_MESH_SIZE_MM = process.env.BENCH_MESH_SIZE_MM;
const BENCH_URL = `http://localhost:${PORT}/?solveBench=1${BENCH_MESH_SIZE_MM ? `&meshSizeMm=${BENCH_MESH_SIZE_MM}&minDofs=1` : ""}`;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "apps/opencae-web/dist");

// ── Process helpers (verify-offline-pwa.mjs pattern) ────────────────────────
const children = [];
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
process.on("exit", () => {
  for (const child of children) killChild(child);
});
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

// ── Chrome leg (CDP) ────────────────────────────────────────────────────────
async function connectCdp() {
  const target = await waitFor("Chrome DevTools endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const list = await response.json();
    return list.find((candidate) => candidate.type === "page") ?? null;
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
      if (text.includes("[solveBench]")) console.log(`[chrome console] ${text.slice(0, 300)}`);
    }
    if (message.method === "Runtime.exceptionThrown") {
      console.log(`[chrome pageerror] ${JSON.stringify(message.params.exceptionDetails).slice(0, 400)}`);
    }
  };
  return (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

/**
 * Peak RSS (bytes) of the single largest live descendant of `rootPid` right
 * now. Chrome's renderer (which hosts the solve worker heap and the gmsh wasm
 * memory) dominates its process tree, so polling this during the bench gives
 * an honest process-level peak-memory upper bound for the tab.
 */
function maxDescendantRss(rootPid) {
  const listed = spawnSync("ps", ["axo", "pid=,ppid=,rss="], { encoding: "utf8" });
  if (listed.status !== 0 || !listed.stdout) return { pid: undefined, rssBytes: 0 };
  const childrenByParent = new Map();
  const rssByPid = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [pid, ppid, rssKb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue;
    rssByPid.set(pid, rssKb * 1024);
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(pid);
  }
  let max = { pid: undefined, rssBytes: 0 };
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    for (const child of childrenByParent.get(pid) ?? []) {
      const rssBytes = rssByPid.get(child) ?? 0;
      if (rssBytes > max.rssBytes) max = { pid: child, rssBytes };
      queue.push(child);
    }
  }
  return max;
}

/**
 * Kernel-tracked lifetime peak phys_footprint of a process (macOS `footprint`
 * tool). phys_footprint is the metric memory pressure / jetsam act on; ps RSS
 * counts reclaimable pages and overstates it (measured 2026-07: 1.85 GB RSS vs
 * 1.57 GB footprint peak for the same bench renderer). Returns undefined when
 * the tool is unavailable (non-macOS) — the RSS poll then serves as fallback.
 */
function footprintPeakBytes(pid) {
  if (!pid) return undefined;
  const out = spawnSync("/usr/bin/footprint", [String(pid)], { encoding: "utf8" });
  const match = out.stdout?.match(/phys_footprint_peak:\s+([\d.]+)\s*(KB|MB|GB)/);
  if (!match) return undefined;
  const scale = { KB: 1e3, MB: 1e6, GB: 1e9 }[match[2]];
  return Math.round(Number(match[1]) * scale);
}

async function runChromeBench() {
  const profileDir = mkdtempSync(join(tmpdir(), "opencae-solvebench-chrome-"));
  const chrome = spawnChild(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "about:blank"
  ]);
  let rendererPeakRssBytes = 0;
  let rendererPid;
  const rssPoller = setInterval(() => {
    const largest = maxDescendantRss(chrome.pid);
    if (largest.rssBytes > rendererPeakRssBytes) {
      rendererPeakRssBytes = largest.rssBytes;
      rendererPid = largest.pid;
    }
  }, 500);
  try {
    const send = await connectCdp();
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url: BENCH_URL });

    // Phase-boundary footprint snapshot: the kernel peak up to the moment the
    // solve starts covers page load + occt + gmsh meshing + model build, so
    // final-peak > pre-solve-peak proves the SOLVE phase drove the maximum.
    let preSolveFootprintPeakBytes;
    let sawSolvingPhase = false;
    const readBench = async (expression) => {
      const evaluated = await send("Runtime.evaluate", { expression, returnByValue: true });
      return evaluated.result?.result?.value;
    };
    const result = await waitFor(
      "Chrome solve bench result",
      async () => {
        if (!sawSolvingPhase) {
          const phase = await readBench("window.__opencaeSolveBench ? window.__opencaeSolveBench.phase : null");
          if (phase === "solving" || phase === "done") {
            sawSolvingPhase = true;
            preSolveFootprintPeakBytes = footprintPeakBytes(rendererPid ?? maxDescendantRss(chrome.pid).pid);
          }
        }
        const value = await readBench(
          "window.__opencaeSolveBench && window.__opencaeSolveBench.lastResult ? JSON.stringify(window.__opencaeSolveBench.lastResult) : null"
        );
        return typeof value === "string" ? JSON.parse(value) : null;
      },
      TIMEOUT_MS,
      1_000
    );
    if (result?.ok) {
      result.memory.rendererPeakRssBytes = rendererPeakRssBytes;
      const finalFootprintPeakBytes = footprintPeakBytes(rendererPid);
      if (finalFootprintPeakBytes !== undefined) result.memory.rendererFootprintPeakBytes = finalFootprintPeakBytes;
      if (preSolveFootprintPeakBytes !== undefined) result.memory.rendererPreSolveFootprintPeakBytes = preSolveFootprintPeakBytes;
    }
    return result;
  } finally {
    clearInterval(rssPoller);
    killChild(chrome);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

// ── WebKit leg (Playwright from a scratch dir, NEVER repo deps) ─────────────
const WEBKIT_RUNNER_SOURCE = `import { webkit } from "playwright-webkit";
const url = process.env.BENCH_URL;
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 600000);
const browser = await webkit.launch();
const page = await browser.newPage();
page.on("console", (msg) => {
  const text = msg.text();
  if (text.includes("[solveBench]")) console.error("[webkit console] " + text.slice(0, 300));
});
page.on("pageerror", (error) => console.error("[webkit pageerror] " + String(error).slice(0, 400)));
await page.goto(url);
const started = Date.now();
let result = null;
while (Date.now() - started < timeoutMs) {
  result = await page.evaluate(() => {
    const bench = window.__opencaeSolveBench;
    return bench && bench.lastResult ? JSON.stringify(bench.lastResult) : null;
  });
  if (result) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await browser.close();
if (!result) {
  console.error("WEBKIT SOLVEBENCH TIMEOUT");
  process.exit(2);
}
console.log("SOLVEBENCH_JSON " + result);
`;

function ensurePlaywrightWebkitDir() {
  const dir = process.env.PLAYWRIGHT_WEBKIT_DIR ?? join(tmpdir(), "opencae-playwright-webkit");
  if (!existsSync(join(dir, "node_modules", "playwright-webkit"))) {
    console.log(`[webkit] installing playwright-webkit@1.61.1 into scratch dir ${dir} (kept out of repo deps)`);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "opencae-solvebench-webkit", private: true }, null, 2));
    }
    // The postinstall step downloads the WebKit build into Playwright's
    // default browser cache (~/Library/Caches/ms-playwright on macOS); only
    // the npm package itself lives in the scratch dir.
    const installed = spawnSync("npm", ["install", "playwright-webkit@1.61.1"], {
      cwd: dir,
      stdio: "inherit"
    });
    if (installed.status !== 0) throw new Error(`npm install playwright-webkit failed in ${dir}`);
  }
  return dir;
}

async function runWebkitBench() {
  const dir = ensurePlaywrightWebkitDir();
  const runnerPath = join(dir, "opencae-solvebench-webkit-runner.mjs");
  writeFileSync(runnerPath, WEBKIT_RUNNER_SOURCE);
  return await new Promise((resolve, reject) => {
    const child = spawn("node", [runnerPath], {
      cwd: dir,
      env: {
        ...process.env,
        BENCH_URL,
        BENCH_TIMEOUT_MS: String(TIMEOUT_MS)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => process.stdout.write(String(chunk)));
    const timer = setTimeout(() => {
      killChild(child);
      reject(new Error("Timed out waiting for WebKit solve bench result"));
    }, TIMEOUT_MS + 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const jsonLine = stdout.split("\n").find((line) => line.startsWith("SOLVEBENCH_JSON "));
      if (!jsonLine) {
        reject(new Error(`WebKit runner exited ${code} without a result: ${stdout.slice(0, 400)}`));
        return;
      }
      resolve(JSON.parse(jsonLine.slice("SOLVEBENCH_JSON ".length)));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ── Reporting + gates ───────────────────────────────────────────────────────
function megabytes(bytes) {
  return bytes === undefined ? "n/a" : `${Math.round(bytes / 1e6)} MB`;
}

function describeResult(label, result) {
  if (!result.ok) {
    console.log(`[${label}] FAIL: ${result.error.split("\n")[0]}`);
    return;
  }
  console.log(
    `[${label}] dofs=${result.dofs} (nodes=${result.nodeCount}, elements=${result.elementCount}, h=${result.meshSizeMm}mm) meshMs=${result.meshMs}`
  );
  console.log(
    `[${label}] solve totalMs=${result.solve.totalMs} (setup=${result.solve.setupMs}, assemble=${result.solve.assembleMs}, ` +
      `cg=${result.solve.cgMs}, recover=${result.solve.recoverMs}) cgIterations>=${result.solve.cgIterations} ` +
      `relResidual=${result.solve.lastRelativeResidual?.toExponential(2) ?? "n/a"}`
  );
  console.log(
    `[${label}] memory workerPeak=${megabytes(result.memory.workerPeakHeapBytes)} mainPeak=${megabytes(result.memory.mainThreadPeakHeapBytes)} ` +
      `rendererFootprintPeak=${megabytes(result.memory.rendererFootprintPeakBytes)} (preSolve=${megabytes(result.memory.rendererPreSolveFootprintPeakBytes)}) ` +
      `rendererPeakRss=${megabytes(result.memory.rendererPeakRssBytes)} uaSpecific=${megabytes(result.memory.uaSpecificMemoryBytes)} ` +
      `performance.memory=${result.memory.performanceMemorySupported}`
  );
  console.log(
    `[${label}] results maxStress=${result.summary.maxStress}${result.summary.maxStressUnits ?? ""} ` +
      `maxDisplacement=${result.summary.maxDisplacement}${result.summary.maxDisplacementUnits ?? ""} ` +
      `reaction=${result.summary.reactionForce.toFixed(3)}/${result.summary.appliedForce}N (relErr=${result.summary.reactionRelativeError.toExponential(2)})`
  );
}

function relativeDelta(left, right) {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale > 0 ? Math.abs(left - right) / scale : 0;
}

function engineGates(label, result, gates) {
  if (!result.ok) {
    gates.push(`${label}: bench failed: ${result.error.split("\n")[0]}`);
    return;
  }
  if (result.dofs < 90_000 || result.dofs > 100_000) gates.push(`${label}: dofs ${result.dofs} outside the 90k..100k target band`);
  if (result.appliedLimitMaxDofs !== 100_000) gates.push(`${label}: bench ran under maxDofs ${result.appliedLimitMaxDofs}, expected 100000`);
  if (!result.sanity.finiteMaxStress) gates.push(`${label}: maxStress not finite/positive`);
  if (!result.sanity.finiteMaxDisplacement) gates.push(`${label}: maxDisplacement not finite/positive`);
  if (!result.sanity.reactionMatchesApplied) {
    gates.push(`${label}: reaction ${result.summary.reactionForce} N does not match applied ${result.summary.appliedForce} N within 1%`);
  }
  if (result.solve.totalMs > SOLVE_BENCH_MAX_MS) {
    gates.push(`${label}: solve wall time ${result.solve.totalMs} ms exceeds the ${SOLVE_BENCH_MAX_MS} ms bound`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
try {
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("apps/opencae-web/dist is missing; run `pnpm --filter @opencae/web build` first.");
  }
  const preview = spawnChild("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: join(repoRoot, "apps/opencae-web")
  });
  void preview;
  await waitFor("preview server", async () => (await fetch(`http://localhost:${PORT}/`)).ok);
  console.log(`[serve] vite preview on :${PORT}`);

  const chromeResult = process.env.SKIP_CHROME === "1" ? null : await runChromeBench();
  if (chromeResult) describeResult("chrome", chromeResult);
  const webkitResult = process.env.SKIP_WEBKIT === "1" ? null : await runWebkitBench();
  if (webkitResult) describeResult("webkit", webkitResult);

  const gates = [];
  if (!chromeResult || !webkitResult) {
    gates.push("both engines are required for the 100k gate (SKIP_CHROME/SKIP_WEBKIT are debug aids, not passes)");
  }
  if (chromeResult) engineGates("chrome", chromeResult, gates);
  if (webkitResult) engineGates("webkit", webkitResult, gates);

  if (chromeResult?.ok && webkitResult?.ok) {
    if (chromeResult.dofs !== webkitResult.dofs) {
      gates.push(`engines meshed different models: chrome ${chromeResult.dofs} vs webkit ${webkitResult.dofs} DOFs`);
    }
    for (const key of ["maxStress", "maxDisplacement", "reactionForce"]) {
      const delta = relativeDelta(chromeResult.summary[key], webkitResult.summary[key]);
      if (delta > RESULT_PARITY_REL_TOL) {
        gates.push(`cross-engine ${key} mismatch: chrome ${chromeResult.summary[key]} vs webkit ${webkitResult.summary[key]} (rel ${delta.toExponential(2)} > ${RESULT_PARITY_REL_TOL})`);
      } else {
        console.log(`[parity] ${key}: rel delta ${delta.toExponential(2)} (<= ${RESULT_PARITY_REL_TOL})`);
      }
    }
  }

  // Memory stop-gates: the plan's honest outcome — if measured memory at
  // target scale busts the envelope, the cap flip is WRONG and this proof must
  // fail, arguing for 60k default + explicit opt-in.
  // Gate (a): JS-heap peak (the plan's stop metric) — any exposed
  // performance.memory number (in-worker when available, else main thread).
  const chromeHeapPeakBytes = chromeResult?.ok
    ? Math.max(chromeResult.memory.workerPeakHeapBytes ?? 0, chromeResult.memory.mainThreadPeakHeapBytes ?? 0)
    : 0;
  if (chromeHeapPeakBytes > MEMORY_STOP_BYTES) {
    gates.push(`STOP: Chrome JS-heap peak ${megabytes(chromeHeapPeakBytes)} exceeds ${megabytes(MEMORY_STOP_BYTES)} — keep the 60k default instead of flipping`);
  }
  // Gate (b): whole-renderer regression tripwire against the measured 1.62 GB
  // envelope (see header) — kernel footprint peak preferred, ps RSS fallback.
  const chromeProcessPeakBytes = chromeResult?.ok
    ? chromeResult.memory.rendererFootprintPeakBytes ?? chromeResult.memory.rendererPeakRssBytes ?? 0
    : 0;
  if (chromeResult?.ok && chromeHeapPeakBytes === 0 && chromeProcessPeakBytes === 0) {
    gates.push("Chrome run produced no memory measurement at all; the memory stop-gates cannot be evaluated");
  }
  if (chromeProcessPeakBytes > MEMORY_STOP_PROCESS_BYTES) {
    gates.push(`STOP: Chrome renderer peak ${megabytes(chromeProcessPeakBytes)} exceeds the ${megabytes(MEMORY_STOP_PROCESS_BYTES)} regression tripwire (measured healthy envelope: 1.62 GB incl. gmsh meshing)`);
  }
  const chromePeakBytes = Math.max(chromeHeapPeakBytes, chromeProcessPeakBytes);

  if (gates.length) {
    console.error("SOLVEBENCH100K FAIL:\n - " + gates.join("\n - "));
    process.exit(1);
  }
  console.log(
    `SOLVEBENCH100K OK: ${chromeResult.dofs} DOFs solved in Chrome (${chromeResult.solve.totalMs} ms, peak memory ${megabytes(chromePeakBytes)}) ` +
      `and WebKit (${webkitResult.solve.totalMs} ms) with cross-engine parity <= ${RESULT_PARITY_REL_TOL} relative.`
  );
  process.exit(0);
} catch (error) {
  const message = error?.message ?? String(error);
  if (message.startsWith("Timed out")) {
    console.error(`SOLVEBENCH100K TIMEOUT: ${message}`);
    process.exit(2);
  }
  console.error(`SOLVEBENCH100K FAIL: ${message}`);
  process.exit(1);
}
