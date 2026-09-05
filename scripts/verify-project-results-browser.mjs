// Regression: history must invalidate results; portable files must contain all dynamic cases.
// Run with: node scripts/verify-project-results-browser.mjs (Chrome; ports 5199 and 9337).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5199);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profileDir = mkdtempSync(join(tmpdir(), "opencae-project-results-"));
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

async function callInPage(cdp, fn, ...args) {
  const target = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const response = await cdp.send("Runtime.callFunctionOn", {
    objectId: target.result.result.objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map(value => ({ value })),
    awaitPromise: true,
    returnByValue: true
  });
  if (response.error || response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.error ?? response.result.exceptionDetails).slice(0, 800));
  }
  return response.result?.result?.value;
}

let activeCdp;

async function run() {
  spawnChild("pnpm", ["--filter", "@opencae/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: repoRoot });
  await waitFor("Vite", async () => (await fetch(`http://127.0.0.1:${PORT}/`)).ok);
  spawnChild(chromeBinary(), ["--headless=new", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${CDP_PORT}`, "about:blank"]);
  const cdp = await connectCdp();
  activeCdp = cdp;
  const errors = [];
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  cdp.on("Runtime.exceptionThrown", (params) => errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text));
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await waitFor("app", () => evaluate(cdp, 'document.title.includes("OpenCAE") && document.body.innerText.includes("Create new project")'));
  const fixture = await waitFor("fixture imports", () => evaluate(cdp, `(async () => {
    const { loadSampleProject } = await import('/src/lib/api.ts');
    const { project, displayModel } = await loadSampleProject('cantilever', 'dynamic_structural');
    const summary = { maxStress: 10, maxStressUnits: 'MPa', maxDisplacement: 0.1, maxDisplacementUnits: 'mm', safetyFactor: 2, reactionForce: 100, reactionForceUnits: 'N', transient: { analysisType: 'dynamic_structural', frameCount: 2, startTime: 0, endTime: 1, timeStep: 1, outputInterval: 1, peakDisplacement: 0.1, peakDisplacementTimeSeconds: 1 } };
    const variant = id => ({ id, name: id, kind: 'case', caseId: id, summary, fields: [0, 1].flatMap(frameIndex => ['stress', 'displacement'].map(type => ({ id: id + '-' + type + '-' + frameIndex, runId: 'run-local-history-proof', variantId: id, type, location: 'face', values: displayModel.faces.map(() => type === 'stress' ? 10 : 0.1), min: type === 'stress' ? 10 : 0.1, max: type === 'stress' ? 10 : 0.1, units: type === 'stress' ? 'MPa' : 'mm', frameIndex, timeSeconds: frameIndex }))) });
    const active = variant('Down');
    const other = variant('Side');
    const previous = structuredClone(project);
    previous.studies[0].loads[0].parameters.value = 250;
    project.studies[0].loads[0].parameters.value = 500;
    return { project, previous, displayModel, active, other, results: { completedRunId: 'run-local-history-proof', summary, fields: active.fields, variants: [active], variantRefs: [active, other].map(({id,name,kind,caseId}) => ({id,name,kind,caseId,persistedSeparately:true})), activeVariantId: active.id } };
  })()`));
  async function restore(projectFile, ui) {
    const token = `${Date.now()}-${Math.random()}`;
    await callInPage(cdp, (projectFile, ui, token) => {
      sessionStorage.setItem('opencae-test-fixture', JSON.stringify({ projectFile, ui, token }));
    }, projectFile, ui, token);
    const injection = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const fixture = JSON.parse(sessionStorage.getItem('opencae-test-fixture'));
      sessionStorage.removeItem('opencae-test-fixture');
      window.__projectFixtureToken = fixture.token;
      localStorage.clear();
      localStorage.setItem('opencae.workspace.autosave.v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), projectFile: fixture.projectFile, ui: fixture.ui }));
    })()` });
    await cdp.send("Page.reload");
    await waitFor("restored results", () => callInPage(cdp, token => window.__projectFixtureToken === token && Boolean(document.querySelector(".result-variant-selector select")), token));
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection.result.identifier });
    await evaluate(cdp, `(() => {
      window.__savedProject = null;
      window.showSaveFilePicker = async () => ({ name: 'proof.opencae.json', createWritable: async () => ({ write: async blob => { window.__savedProject = JSON.parse(await blob.text()); }, close: async () => {} }) });
    })()`);
  }
  async function save() {
    await evaluate(cdp, `(() => { window.__savedProject = null; window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); })()`);
    return waitFor("saved project", () => evaluate(cdp, 'window.__savedProject'));
  }
  const projectFile = { format: "opencae-local-project", version: 2, savedAt: new Date().toISOString(), project: fixture.project, displayModel: fixture.displayModel, results: fixture.results };
  const ui = { activeStep: "results", viewMode: "results", homeRequested: false, resultMode: "stress", logs: [], undoStack: [fixture.previous], redoStack: [], runProgress: 100, completedRunId: "run-local-history-proof" };
  for (const direction of ["Undo", "Redo"]) {
    await restore(projectFile, { ...ui, undoStack: direction === "Undo" ? [fixture.previous] : [], redoStack: direction === "Redo" ? [fixture.previous] : [] });
    await evaluate(cdp, `document.querySelector('[aria-label="${direction} last change"]').click()`);
    await waitFor("cleared results", () => evaluate(cdp, '!document.querySelector(".result-variant-selector select")'));
    const saved = await save();
    if (saved.results || saved.project.studies[0].loads[0].parameters.value !== 250) throw new Error(`${direction} retained stale results or did not restore the load`);
    console.log(`${direction}: load restored; stale results absent from UI and saved file.`);
  }
  await restore(projectFile, ui);
  await callInPage(cdp, async variant => {
    const store = await import('/src/lib/localResultsStore.ts');
    await store.saveLocalRunVariantResult('run-local-history-proof', 'Side', variant);
  }, fixture.other);
  const saved = await save();
  if (saved.results.variants.length !== 2 || saved.results.variantRefs.some(ref => ref.persistedSeparately)) throw new Error('Save omitted a case or retained storage dependencies');
  await evaluate(cdp, `(async () => { const store = await import('/src/lib/localResultsStore.ts'); await store.deleteLocalRunVariantResults('run-local-history-proof'); })()`);
  await restore(saved, { ...ui, undoStack: [], redoStack: [] });
  for (const id of ['Side', 'Down', 'Side']) {
    await evaluate(cdp, `(() => { const select = document.querySelector('.result-variant-selector select'); select.value = '${id}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`case ${id}`, () => evaluate(cdp, `document.querySelector('.result-variant-selector select')?.value === '${id}'`));
  }
  const resaved = await save();
  if (resaved.results.variants.length !== 2 || resaved.results.activeVariantId !== 'Side') throw new Error('Reopened cases were lost when switching');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Portable results: both cases survive save, storage deletion, reopen, repeated switching, and resave.');
}

try {
  await run();
  console.log("PROJECT RESULTS OK");
  process.exit(0);
} catch (error) {
  if (activeCdp) console.error(await evaluate(activeCdp, 'JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 5000) })').catch(() => 'Page unavailable'));
  console.error(`PROJECT RESULTS FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
