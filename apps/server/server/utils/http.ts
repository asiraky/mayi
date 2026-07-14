import { DomainError } from "@mayi/domain";
import { createError, getHeader, readBody, type H3Event } from "h3";
import type { z } from "zod";

export async function bodyAs<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readBody(event));
  if (!result.success) throw createError({ statusCode: 422, statusMessage: "Invalid request", data: result.error.flatten() });
  return result.data;
}

export function requireIdempotencyKey(event: H3Event): string {
  const value = getHeader(event, "idempotency-key");
  if (!value || value.length > 200) throw createError({ statusCode: 400, statusMessage: "A valid Idempotency-Key is required" });
  return value;
}

export function asHttpError(error: unknown): never {
  if (error instanceof DomainError) throw createError({ statusCode: error.status, statusMessage: error.message, data: { code: error.code } });
  throw error;
}
