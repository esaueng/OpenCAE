import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const distAssetsDir = new URL("../apps/opencae-web/dist/assets/", import.meta.url);
const INITIAL_JS_GZIP_BUDGET_BYTES = 175 * 1024;

function jsFiles(directoryUrl) {
  return readdirSync(directoryUrl)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(directoryUrl.pathname, name));
}

const distDir = new URL("../apps/opencae-web/dist/", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", distDir), "utf8");
const initialScriptMatch = indexHtml.match(/<script[^>]+type="module"[^>]+src="(?<src>\/assets\/[^"]+\.js)"/);
if (!initialScriptMatch?.groups?.src) {
  console.error("Could not find the initial module script in dist/index.html.");
  process.exit(1);
}

const initialBundle = join(distDir.pathname, initialScriptMatch.groups.src.replace(/^\//, ""));
const initialFiles = collectStaticImports(initialBundle, new Set());
const gzipBytes = [...initialFiles].reduce((total, file) => total + gzipSync(readFileSync(file)).byteLength, 0);
if (gzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES) {
  console.error(`Initial JS gzip budget exceeded: ${gzipBytes} > ${INITIAL_JS_GZIP_BUDGET_BYTES} bytes (${[...initialFiles].join(", ")}).`);
  process.exit(1);
}

const totalJsBytes = jsFiles(distAssetsDir).reduce((total, file) => total + statSync(file).size, 0);
console.log(`Initial JS gzip: ${gzipBytes} bytes; total JS: ${totalJsBytes} bytes.`);

function collectStaticImports(file, visited) {
  if (visited.has(file)) return visited;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  const importPattern = /import(?:[^("'`]*?from\s*)?["'](?<specifier>\.\/[^"']+\.js)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match.groups?.specifier;
    if (!specifier) continue;
    collectStaticImports(join(distAssetsDir.pathname, specifier.replace(/^\.\//, "")), visited);
  }
  return visited;
}
