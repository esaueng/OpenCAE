import { createServer } from "node:http";
import { handleRequest } from "./index.js";

const port = Number(process.env.PORT ?? 8080);
const maxRequestBytes = 5_000_000;

const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxRequestBytes) {
      outgoing.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(JSON.stringify({ ok: false, error: "Request body is too large." }));
      return;
    }
    chunks.push(buffer);
  }

  const request = new Request(`http://localhost${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined
  });
  const response = await handleRequest(request);

  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`opencae-core-cloud listening on ${port}`);
});
