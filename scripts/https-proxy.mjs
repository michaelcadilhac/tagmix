import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { request as requestHttp } from "node:http";
import { resolve } from "node:path";

const listenHost = process.env.TAGMIX_HTTPS_HOST ?? "0.0.0.0";
const listenPort = Number(process.env.TAGMIX_HTTPS_PORT ?? 3443);
const upstream = new URL(process.env.TAGMIX_HTTPS_UPSTREAM ?? "http://127.0.0.1:3000");
const certificatePath = resolve(process.env.TAGMIX_TLS_CERT ?? ".data/tls/tagmix-test.crt");
const keyPath = resolve(process.env.TAGMIX_TLS_KEY ?? ".data/tls/tagmix-test.key");

if (upstream.protocol !== "http:") {
  throw new Error("TAGMIX_HTTPS_UPSTREAM must be an http:// URL.");
}
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
  throw new Error("TAGMIX_HTTPS_PORT must be a valid TCP port.");
}

const [certificate, key] = await Promise.all([
  readFile(certificatePath),
  readFile(keyPath),
]);

const server = createServer({ cert: certificate, key }, (incoming, outgoing) => {
  const forwardedHost = incoming.headers.host ?? "";
  const proxy = requestHttp({
    headers: {
      ...incoming.headers,
      "x-forwarded-host": forwardedHost,
      "x-forwarded-proto": "https",
    },
    hostname: upstream.hostname,
    method: incoming.method,
    path: incoming.url,
    port: upstream.port || 80,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });

  proxy.on("error", (error) => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    outgoing.end(`HTTPS proxy error: ${error.message}\n`);
  });
  incoming.on("aborted", () => proxy.destroy());
  incoming.pipe(proxy);
});

server.listen(listenPort, listenHost, () => {
  console.log(`TagMix HTTPS proxy listening on https://${listenHost}:${listenPort}`);
  console.log(`Forwarding to ${upstream.origin}`);
});
