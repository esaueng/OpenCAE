import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const distAssetsDir = new URL("../apps/opencae-web/dist/assets/", import.meta.url);
const INITIAL_JS_GZIP_BUDGET_BYTES = 175 * 1024;

function jsFiles(directoryUrl) {
  return readdirSync(directoryUrl)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(directoryUrl.pathname, name));
}

const candidates = jsFiles(distAssetsDir).filter((file) => /\/index-[^/]+\.js$/.test(file));
if (candidates.length !== 1) {
  console.error(`Expected exactly one initial index bundle, found ${candidates.length}.`);
  process.exit(1);
}

const initialBundle = candidates[0];
const gzipBytes = gzipSync(new Uint8Array(await import("node:fs").then(({ readFileSync }) => readFileSync(initialBundle)))).byteLength;
if (gzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES) {
  console.error(`Initial JS gzip budget exceeded: ${gzipBytes} > ${INITIAL_JS_GZIP_BUDGET_BYTES} bytes (${initialBundle}).`);
  process.exit(1);
}

const totalJsBytes = jsFiles(distAssetsDir).reduce((total, file) => total + statSync(file).size, 0);
console.log(`Initial JS gzip: ${gzipBytes} bytes; total JS: ${totalJsBytes} bytes.`);
