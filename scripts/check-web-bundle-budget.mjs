import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  INITIAL_JS_GZIP_BUDGET_BYTES,
  LAZY_JS_CHUNK_GZIP_BUDGET_BYTES,
  PRECACHE_TOTAL_BUDGET_BYTES,
  STATIC_ASSET_BUDGET_BYTES,
  STATIC_ASSET_EXEMPTIONS,
  TOTAL_JS_GZIP_BUDGET_BYTES
} from "./web-asset-budgets.mjs";

const distAssetsDir = new URL("../apps/opencae-web/dist/assets/", import.meta.url);

function jsFiles(directoryUrl) {
  return readdirSync(directoryUrl)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(fileURLToPath(directoryUrl), name));
}

const distDir = new URL("../apps/opencae-web/dist/", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", distDir), "utf8");
const initialScriptMatch = indexHtml.match(/<script[^>]+type="module"[^>]+src="(?<src>\/assets\/[^"]+\.js)"/);
if (!initialScriptMatch?.groups?.src) {
  console.error("Could not find the initial module script in dist/index.html.");
  process.exit(1);
}

const failures = [];

const initialBundle = join(fileURLToPath(distDir), initialScriptMatch.groups.src.replace(/^\//, ""));
const initialFiles = collectStaticImports(initialBundle, new Set());
const gzipBytes = [...initialFiles].reduce((total, file) => total + gzipSync(readFileSync(file)).byteLength, 0);
if (gzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES) {
  failures.push(`Initial JS gzip budget exceeded: ${gzipBytes} > ${INITIAL_JS_GZIP_BUDGET_BYTES} bytes (${[...initialFiles].join(", ")}).`);
}

const allJs = jsFiles(distAssetsDir).map((file) => ({ file, gzip: gzipSync(readFileSync(file)).byteLength, raw: statSync(file).size }));
const totalJsGzip = allJs.reduce((total, entry) => total + entry.gzip, 0);
if (totalJsGzip > TOTAL_JS_GZIP_BUDGET_BYTES) {
  failures.push(`Total JS gzip budget exceeded: ${totalJsGzip} > ${TOTAL_JS_GZIP_BUDGET_BYTES} bytes.`);
}

for (const entry of allJs) {
  if (initialFiles.has(entry.file)) continue;
  if (entry.gzip > LAZY_JS_CHUNK_GZIP_BUDGET_BYTES) {
    failures.push(`Lazy chunk over budget: ${basename(entry.file)} is ${entry.gzip} gzip bytes > ${LAZY_JS_CHUNK_GZIP_BUDGET_BYTES}.`);
  }
}

for (const entry of staticAssets(distAssetsDir)) {
  if (STATIC_ASSET_EXEMPTIONS.some((exemption) => exemption.pattern.test(entry.file))) continue;
  if (entry.size > STATIC_ASSET_BUDGET_BYTES) {
    failures.push(`Static asset over budget: ${basename(entry.file)} is ${entry.size} bytes > ${STATIC_ASSET_BUDGET_BYTES}.`);
  }
}

const precacheBytes = precacheTotalBytes();
if (precacheBytes > PRECACHE_TOTAL_BUDGET_BYTES) {
  failures.push(`Service-worker precache over budget: ${precacheBytes} > ${PRECACHE_TOTAL_BUDGET_BYTES} bytes.`);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

const largestLazy = allJs.filter((entry) => !initialFiles.has(entry.file)).sort((left, right) => right.gzip - left.gzip)[0];
console.log([
  `Initial JS gzip: ${gzipBytes} / ${INITIAL_JS_GZIP_BUDGET_BYTES} bytes.`,
  `Total JS gzip: ${totalJsGzip} / ${TOTAL_JS_GZIP_BUDGET_BYTES} bytes.`,
  largestLazy ? `Largest lazy chunk: ${basename(largestLazy.file)} ${largestLazy.gzip} / ${LAZY_JS_CHUNK_GZIP_BUDGET_BYTES} gzip bytes.` : "",
  `Service-worker precache: ${precacheBytes} / ${PRECACHE_TOTAL_BUDGET_BYTES} bytes.`
].filter(Boolean).join("\n"));

function basename(file) {
  return file.split(/[\\/]/).pop();
}

function staticAssets(directoryUrl) {
  const directory = fileURLToPath(directoryUrl);
  return readdirSync(directory)
    .filter((name) => !name.endsWith(".js") && !name.endsWith(".map"))
    .map((name) => ({ file: join(directory, name), size: statSync(join(directory, name)).size }));
}

/**
 * Sums the real precache manifest in dist/sw.js rather than re-deriving it, so
 * the number tracks what the service worker actually installs.
 */
function precacheTotalBytes() {
  const serviceWorker = readFileSync(new URL("sw.js", distDir), "utf8");
  const urls = [...serviceWorker.matchAll(/url:\s*"(?<url>[^"]+)"/g)].map((match) => match.groups?.url).filter(Boolean);
  if (!urls.length) {
    console.error("Could not read the precache manifest from dist/sw.js.");
    process.exit(1);
  }
  return urls.reduce((total, url) => {
    try {
      return total + statSync(fileURLToPath(new URL(url, distDir))).size;
    } catch {
      // vite-plugin-pwa injects manifest.webmanifest itself; it is generated
      // beside dist/ and may not resolve as a plain file path.
      return total;
    }
  }, 0);
}

function collectStaticImports(file, visited) {
  if (visited.has(file)) return visited;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  const importPattern = /import(?:[^("'`]*?from\s*)?["'](?<specifier>\.\/[^"']+\.js)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match.groups?.specifier;
    if (!specifier) continue;
    collectStaticImports(join(fileURLToPath(distAssetsDir), specifier.replace(/^\.\//, "")), visited);
  }
  return visited;
}
