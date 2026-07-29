// Real-Chrome regression for STEP selection identity across detailed viewport
// and lightweight playback tessellation. The in-app harness generates exact
// analytic cylinders at 1, 25, and 500 mm, raycasts the cylindrical wall and
// top face, assigns a support/load, and checks both display LODs preserve the
// same B-rep face IDs and fingerprints.
//
// Usage (Node >= 22, Chrome installed):
//   pnpm verify:step-selection-browser
//
// Env: PORT (5198), CDP_PORT (9336), CHROME_BIN, PROOF_TIMEOUT_MS (120000).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5198);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 120_000);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profileDir = mkdtempSync(join(tmpdir(), "opencae-step-selection-"));
const children = [];

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(macChrome)) return macChrome;
  for (const candidate of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const resolved = spawnSync("which", [candidate], { encoding: "utf8" });
    if (resolved.status === 0 && resolved.stdout.trim()) return resolved.stdout.trim();
  }
  throw new Error("Chrome was not found. Set CHROME_BIN to a Chrome or Chromium executable.");
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
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
      // Already stopped.
    }
  }
}

function cleanup() {
  for (const child of children) killChild(child);
  rmSync(profileDir, { recursive: true, force: true });
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(2));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectCdp() {
  const target = await waitFor("Chrome DevTools endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const targets = await response.json();
    return targets.find((candidate) => candidate.type === "page") ?? null;
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    const handler = handlers.get(message.method);
    if (typeof handler === "function") handler(message.params);
  };
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      handlers.set(method, handler);
    }
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 800));
  }
  return response.result?.result?.value;
}

async function run() {
  spawnChild(
    "pnpm",
    ["--filter", "@opencae/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    { cwd: repoRoot }
  );
  await waitFor("Vite server", async () => (await fetch(`http://127.0.0.1:${PORT}/`)).ok);

  spawnChild(chromeBinary(), [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "about:blank"
  ]);
  const cdp = await connectCdp();
  const consoleErrors = [];
  const pageErrors = [];
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    consoleErrors.push(params.args.map((argument) => argument.value ?? argument.description ?? "").join(" "));
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    pageErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "Unknown page error");
  });

  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${PORT}/?stepSelectionProof=1`
  });
  const result = await waitFor(
    "STEP selection proof",
    async () => {
      const value = await evaluate(
        cdp,
        "window.__opencaeStepSelectionProof?.lastResult ? JSON.stringify(window.__opencaeStepSelectionProof.lastResult) : null"
      );
      return value ? JSON.parse(value) : null;
    },
    TIMEOUT_MS,
    500
  );
  const page = await evaluate(
    cdp,
    `JSON.stringify({
      title: document.title,
      proofVisible: Boolean(document.getElementById("opencae-step-selection-proof")),
      frameworkOverlay: Boolean(document.querySelector("vite-error-overlay, #vite-plugin-checker-error-overlay"))
    })`
  ).then(JSON.parse);

  console.log("STEP SELECTION BROWSER RESULT:");
  console.log(JSON.stringify({ result, page, consoleErrors, pageErrors }, null, 2));

  const gates = [];
  if (!result.ok) gates.push(...result.failures);
  if (result.scales?.length !== 3) gates.push(`expected 3 model scales, received ${result.scales?.length ?? 0}`);
  if (!page.title.startsWith("STEPSELECTION OK")) gates.push(`unexpected page title: ${page.title}`);
  if (!page.proofVisible) gates.push("proof result was not rendered into the page");
  if (page.frameworkOverlay) gates.push("Vite framework error overlay was visible");
  if (consoleErrors.length) gates.push(`browser console errors: ${consoleErrors.join(" | ")}`);
  if (pageErrors.length) gates.push(`uncaught page errors: ${pageErrors.join(" | ")}`);
  if (gates.length) throw new Error(gates.join(" | "));
}

try {
  await run();
  console.log("STEPSELECTION OK: wall support and top-face load remained mapped across 1, 25, and 500 mm detailed/playback meshes.");
  process.exit(0);
} catch (error) {
  console.error(`STEPSELECTION FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(String(error instanceof Error ? error.message : error).startsWith("Timed out") ? 2 : 1);
}
