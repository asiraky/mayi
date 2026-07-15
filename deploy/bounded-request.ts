const KIB = 1024;
const MIB = 1024 * KIB;
const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

export function cloudflareRequestBodyLimit(request: Request): number | undefined {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return 0;
  const path = new URL(request.url).pathname;
  if (!isApiPath(path)) return MIB;
  if (["/api/oauth/register", "/api/oauth/token", "/api/oauth/consent"].includes(path)) return 32 * KIB;
  if (["/api/forwarding/assertions", "/api/receipts/consume"].includes(path)) return 128 * KIB;
  if (/^\/api\/approvals\/(?:request\/artefacts\/\d+|[^/]+\/artefacts)$/.test(path)) return 25 * MIB;
  return MIB;
}

function error(request: Request, status: number, message: string): Response {
  const api = isApiPath(new URL(request.url).pathname);
  return Response.json({ statusCode: status, statusMessage: message }, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(api ? { "access-control-allow-origin": "*" } : {}),
    },
  });
}

/** Bounds the body before Nitro's Cloudflare adapter materializes request.arrayBuffer(). */
export async function boundCloudflareRequest(request: Request): Promise<Request | Response> {
  const maximum = cloudflareRequestBodyLimit(request);
  if (maximum === undefined || request.body === null) return request;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
    return error(request, /^\d+$/.test(declared) ? 413 : 400, "Request body is invalid or too large");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - length) {
        await reader.cancel().catch(() => undefined);
        return error(request, 413, "Request body is too large");
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { body, headers });
}
