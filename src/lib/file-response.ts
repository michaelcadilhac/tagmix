import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseByteRange } from "@/lib/http-range";

export async function fileResponse(
  request: Request,
  filePath: string,
  contentType: string,
): Promise<Response> {
  const info = await stat(filePath);
  const etag = `W/\"${info.size}-${Math.round(info.mtimeMs)}\"`;
  const range = parseByteRange(request.headers.get("range"), info.size);
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    "Content-Type": contentType,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...commonHeaders, "Content-Range": `bytes */${info.size}` },
    });
  }

  if (!range && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: commonHeaders });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const nodeStream = createReadStream(filePath, { start, end });
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...commonHeaders,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
    },
  });
}
