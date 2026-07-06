// Browser proof for in-browser gmsh-wasm meshing (plan A-M2): drives real
// headless Chrome via CDP, loads the built app with ?meshProof=1 (the
// meshHarness.ts auto-run), captures console output, and polls
// window.__opencaeMeshProof.lastResult for node/element counts and phase
// progress evidence. Verified 2026-07-06: 1,140 nodes / 562 Tet10 for the
// default bracket .geo, matching the A-M1 Node spike exactly.
//
// Usage (manual; needs Node >= 22 for global WebSocket, plus Chrome):
//   VITE_WASM_MESHING=1 pnpm --filter @opencae/web build
//   pnpm --filter @opencae/web preview --port 5199 &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --disable-gpu --no-first-run \
//     --user-data-dir=/tmp/opencae-meshproof-profile \
//     --remote-debugging-port=9333 about:blank &
//   node scripts/verify-wasm-mesh-browser.mjs
//
// Exit codes: 0 proof ok, 1 harness reported failure, 2 timeout.
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);
const PAGE_URL = process.env.PAGE_URL ?? "http://localhost:5199/?meshProof=1";
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
    expression: "window.__opencaeMeshProof && window.__opencaeMeshProof.lastResult ? JSON.stringify(window.__opencaeMeshProof.lastResult) : (window.__opencaeMeshProof ? 'HARNESS_LOADED' : 'NO_HARNESS')",
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
console.log("MESHPROOF RESULT:");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
