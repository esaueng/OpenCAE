import { createServer } from "node:http";
import { handleRequest } from "./index";

const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
