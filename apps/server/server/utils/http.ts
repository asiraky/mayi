import { DomainError } from "@mayi/domain";
import { createError, getHeader, getRequestWebStream, readBody, type H3Event } from "h3";
import type { z } from "zod";

export async function bodyAs<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readBody(event));
  if (!result.success) throw createError({ statusCode: 422, statusMessage: "Invalid request", data: result.error.flatten() });
  return result.data;
}

export async function readBoundedStream(
  stream: ReadableStream,
  maximumBytes: number,
  tooLargeMessage = "Request body is too large",
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError("maximumBytes is invalid");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        throw createError({ statusCode: 400, statusMessage: "Request body must contain bytes" });
      }
      if (value.byteLength > maximumBytes - length) {
        await reader.cancel().catch(() => undefined);
        throw createError({ statusCode: 413, statusMessage: tooLargeMessage });
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
  return body;
}

/** Reads at most `maximumBytes`, rejecting declared oversize before consuming the stream. */
export async function readBoundedBody(
  event: H3Event,
  maximumBytes: number,
  tooLargeMessage = "Request body is too large",
): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError("maximumBytes is invalid");
  const contentLength = getHeader(event, "content-length");
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      throw createError({ statusCode: 400, statusMessage: "Content-Length is invalid" });
    }
    if (BigInt(contentLength) > BigInt(maximumBytes)) {
      throw createError({ statusCode: 413, statusMessage: tooLargeMessage });
    }
  }
  const stream = getRequestWebStream(event);
  return stream ? readBoundedStream(stream, maximumBytes, tooLargeMessage) : undefined;
}

export function requireIdempotencyKey(event: H3Event): string {
  const value = getHeader(event, "idempotency-key");
  if (!value || value.length > 200 || value.trim().length === 0) {
    throw createError({ statusCode: 400, statusMessage: "A valid Idempotency-Key is required" });
  }
  return value;
}

export function asHttpError(error: unknown): never {
  if (error instanceof DomainError) throw createError({ statusCode: error.status, statusMessage: error.message, data: { code: error.code } });
  throw error;
}
