// Browser proof for in-browser gmsh-wasm meshing (plan A-M2/A-M3): drives
// real headless Chrome via CDP, loads the built app with ?meshProof=1 (A-M2
// bracket .geo proof) or ?meshProof=step (A-M3 STEP end-to-end: face
// registry -> attribution -> byFace mapping -> in-browser solve), captures
// console output, and polls window.__opencaeMeshProof for evidence.
// Verified 2026-07-06: bracket 1,140 nodes / 562 Tet10 (matches the A-M1
// Node spike); STEP proof reports mapping modes + reaction-vs-applied load.
//
// Usage (manual; needs Node >= 22 for global WebSocket, plus Chrome):
//   VITE_WASM_MESHING=1 pnpm --filter @opencae/web build
//   pnpm --filter @opencae/web preview --port 5199 &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --disable-gpu --no-first-run \
//     --user-data-dir=/tmp/opencae-meshproof-profile \
//     --remote-debugging-port=9333 about:blank &
//   node scripts/verify-wasm-mesh-browser.mjs            # bracket proof
//   PROOF=step node scripts/verify-wasm-mesh-browser.mjs # STEP proof
//
// Exit codes: 0 proof ok, 1 harness reported failure, 2 timeout.
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);
const PROOF_MODE = process.env.PROOF === "step" ? "step" : "bracket";
const PAGE_URL = process.env.PAGE_URL
  ?? (PROOF_MODE === "step" ? "http://localhost:5199/?meshProof=step" : "http://localhost:5199/?meshProof=1");
const RESULT_FIELD = PROOF_MODE === "step" ? "lastStepResult" : "lastResult";
const TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 180_000);

async function getTargets() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      return await response.json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Chrome DevTools endpoint never came up.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const targets = await getTargets();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`No page target: ${JSON.stringify(targets)}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    console.log(`[console.${message.params.type}] ${text.slice(0, 400)}`);
  }
  if (message.method === "Runtime.exceptionThrown") {
    console.log(`[pageerror] ${JSON.stringify(message.params.exceptionDetails).slice(0, 600)}`);
  }
};

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: PAGE_URL });

const started = Date.now();
let result = null;
while (Date.now() - started < TIMEOUT_MS) {
  const evaluated = await send("Runtime.evaluate", {
    expression: `window.__opencaeMeshProof && window.__opencaeMeshProof.${RESULT_FIELD} ? JSON.stringify(window.__opencaeMeshProof.${RESULT_FIELD}) : (window.__opencaeMeshProof ? 'HARNESS_LOADED' : 'NO_HARNESS')`,
    returnByValue: true
  });
  const value = evaluated.result?.result?.value;
  if (typeof value === "string" && value.startsWith("{")) {
    result = JSON.parse(value);
    break;
  }
  await sleep(1000);
}

if (!result) {
  console.log("MESHPROOF TIMEOUT — no result within budget");
  process.exit(2);
}
console.log(`MESHPROOF RESULT (${PROOF_MODE}):`);
console.log(JSON.stringify(result, null, 2));
// A-M3 STEP proof: byFace mapping (never geometric) plus a converged solve
// with reaction ~= applied load are part of the pass criteria.
const stepGateFailed = PROOF_MODE === "step" && result.ok
  && (result.usedGeometricFallback || !result.solve?.ok || result.solve?.reactionMatchesApplied === false);
if (stepGateFailed) {
  console.log("STEPPROOF GATE FAILED: geometric fallback used or solve/reaction check failed.");
  process.exit(1);
}
process.exit(result.ok ? 0 : 1);
