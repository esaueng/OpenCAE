import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const INITIAL_JS_GZIP_BUDGET_BYTES = 175 * 1024;

const root = new URL("../", import.meta.url);
const dist = new URL("apps/opencae-web/dist/", root);
const indexHtml = readFileSync(new URL("index.html", dist), "utf8");
const initialScript = indexHtml.match(/<script[^>]+type="module"[^>]+src="(?<src>\/assets\/[^"]+\.js)"/)?.groups?.src;
const modulePreloads = [...indexHtml.matchAll(/rel="modulepreload"[^>]+href="(?<href>[^"]+)"/g)].map((match) => match.groups?.href ?? "");

if (!initialScript) throw new Error("No initial module script found in dist/index.html.");
if (modulePreloads.some((href) => /WorkspaceApp|CadViewer|viewer-three|cad-import|occt/.test(href))) {
  throw new Error(`Heavy workspace/viewer chunks are preloaded: ${modulePreloads.join(", ")}`);
}

const initialScriptPath = fileURLToPath(new URL(initialScript.replace(/^\//, ""), dist));
const initialFiles = collectStaticImports(initialScriptPath, new Set());
const initialGzipBytes = [...initialFiles].reduce((total, file) => total + gzipSync(readFileSync(file)).byteLength, 0);

if (initialGzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES) {
  throw new Error(`Initial JS bundle is ${initialGzipBytes} gzip bytes, over the ${INITIAL_JS_GZIP_BUDGET_BYTES}-byte budget.`);
}
const result = {
  initialScript,
  initialJsGzipBytes: initialGzipBytes,
  initialJsGzipBudgetBytes: INITIAL_JS_GZIP_BUDGET_BYTES,
  initialJsFiles: [...initialFiles].map((file) => file.replace(fileURLToPath(dist), "/")),
  heavyModulePreloads: modulePreloads,
  preview: null,
  browserProbe: "skipped: install Playwright and set OPENCAE_PERF_BROWSER=1 to record viewer frame timing"
};

const preview = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@opencae/web", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
  cwd: fileURLToPath(root),
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"]
});
let previewStderr = "";
preview.stderr.on("data", (chunk) => {
  previewStderr += chunk.toString();
});

try {
  const previewUrl = "http://127.0.0.1:4173/";
  const startedAt = performance.now();
  await waitForPreview(previewUrl);
  const response = await fetch(previewUrl);
  const html = await response.text();
  result.preview = {
    url: previewUrl,
    status: response.status,
    startupMs: Math.round(performance.now() - startedAt),
    shellBytes: html.length
  };

  if (process.env.OPENCAE_PERF_BROWSER === "1") {
    result.browserProbe = await runBrowserProbe(previewUrl);
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  await stopPreview(preview);
}

async function waitForPreview(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (preview.exitCode !== null) {
      throw new Error(`Vite preview exited before it served the app.\n${previewStderr.trim()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the preview server binds.
    }
    await delay(125);
  }
  throw new Error("Timed out waiting for Vite preview.");
}

function collectStaticImports(file, visited) {
  if (visited.has(file)) return visited;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  const importPattern = /import(?:[^("'`]*?from\s*)?["'](?<specifier>\.\/[^"']+\.js)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match.groups?.specifier;
    if (!specifier) continue;
    collectStaticImports(fileURLToPath(new URL(`assets/${specifier.replace(/^\.\//, "")}`, dist)), visited);
  }
  return visited;
}

async function stopPreview(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    once(child, "exit").catch(() => undefined),
    delay(1000)
  ]);
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function runBrowserProbe(url) {
  const playwright = await importOptional("playwright");
  if (!playwright) return "skipped: Playwright is not installed";
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByText("Load sample project").click();
    await page.locator("canvas").waitFor({ timeout: 15_000 });
    const frameStats = await page.evaluate(async () => {
      const samples = [];
      let previous = performance.now();
      for (let index = 0; index < 90; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        samples.push(now - previous);
        previous = now;
      }
      return {
        maxFrameMs: Math.max(...samples),
        longFramesOver50Ms: samples.filter((value) => value > 50).length
      };
    });
    return frameStats;
  } finally {
    await browser.close();
  }
}

async function importOptional(packageName) {
  try {
    return await import(packageName);
  } catch {
    const localPackage = new URL(`node_modules/${packageName}/index.js`, root);
    try {
      return await import(pathToFileURL(localPackage.pathname).href);
    } catch {
      return null;
    }
  }
}
