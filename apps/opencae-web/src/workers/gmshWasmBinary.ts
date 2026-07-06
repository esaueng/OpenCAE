// Deploy-time serving strategy for the ~44 MB gmsh-core.wasm (plan A-M4).
//
// Cloudflare Workers static assets cap out at 25 MiB per file, so production
// builds ship the module gzip-precompressed (~11 MB) plus a tiny stable-named
// manifest (assets/gmsh-wasm.json, written by the compressGmshWasmForDeploy
// vite plugin). This module resolves the Emscripten Module options for each
// gmsh instantiation:
//
// - Manifest found (production build): fetch the hashed .wasm.gz, stream it
//   through DecompressionStream("gzip"), and return { wasmBinary }. Any
//   failure past this point is FATAL — the raw .wasm does not exist in the
//   deploy, so falling back to the glue's own fetch would just 404 later
//   with a far more confusing error.
// - Manifest missing (vite dev server / node): return {} so the Emscripten
//   glue loads the raw .wasm itself (served from node_modules in dev).
//
// The decompressed bytes are memoized per worker so repeated meshes (fresh
// gmsh module per mesh — see @opencae/mesh-intake's loadGmshWasm) pay the
// fetch + gunzip once; the browser HTTP cache holds the .gz across workers.

const MANIFEST_PATH = "assets/gmsh-wasm.json";

let cachedWasmBinaryPromise: Promise<ArrayBuffer | null> | null = null;

export async function gmshWasmModuleOptions(): Promise<Record<string, unknown>> {
  cachedWasmBinaryPromise ??= loadCompressedWasmBinary().catch((error) => {
    cachedWasmBinaryPromise = null; // Allow retry on transient network failures.
    throw error;
  });
  const wasmBinary = await cachedWasmBinaryPromise;
  return wasmBinary ? { wasmBinary } : {};
}

async function loadCompressedWasmBinary(): Promise<ArrayBuffer | null> {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  const manifestUrl = new URL(`${base.endsWith("/") ? base : `${base}/`}${MANIFEST_PATH}`, self.location.href);
  let manifestResponse: Response;
  try {
    manifestResponse = await fetch(manifestUrl, { credentials: "same-origin" });
  } catch {
    return null; // No server to ask (tests) — let the glue use its default loader.
  }
  if (!manifestResponse.ok) return null; // Dev server: raw .wasm is served directly.
  const manifest = (await manifestResponse.json()) as { wasm?: string; encoding?: string };
  if (!manifest.wasm) {
    throw new Error("gmsh wasm manifest (assets/gmsh-wasm.json) is present but has no `wasm` entry; the deploy is broken.");
  }
  if (manifest.encoding !== "gzip") {
    throw new Error(`gmsh wasm manifest declares unsupported encoding "${manifest.encoding}"; this build only decodes gzip.`);
  }
  const wasmUrl = new URL(manifest.wasm, self.location.href);
  const response = await fetch(wasmUrl, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Could not download the gmsh meshing module (${wasmUrl.pathname}: HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  const magic = new Uint8Array(bytes.slice(0, 4));
  // Some static hosts serve `.gz` files with `Content-Encoding: gzip` (e.g.
  // sirv behind `vite preview`), in which case the browser already
  // transparently decoded the body to raw wasm ("\\0asm"); others (Cloudflare
  // static assets) hand back the gzip bytes as-is ("\\x1f\\x8b"). Sniff the
  // magic instead of trusting headers so both deploys work.
  if (magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d) {
    return bytes;
  }
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser lacks DecompressionStream, which is required to load the compressed gmsh meshing module.");
    }
    const decompressed = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
    return new Response(decompressed).arrayBuffer();
  }
  throw new Error(`Downloaded gmsh meshing module is neither wasm nor gzip (${wasmUrl.pathname}); the deploy is broken.`);
}
