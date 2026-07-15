import { createId } from "@mayi/contracts";
import { createError, defineEventHandler, getRequestIP, readRawBody } from "h3";
import { z } from "zod";
import { tokenHash } from "../../utils/crypto";
import {
  validatePublicHttpsUrl,
  type ValidatePublicHttpsUrlOptions,
} from "../../utils/public-url";
import { database } from "../../utils/runtime";

export const OAUTH_REGISTRATION_LIMITS = {
  bodyBytes: 32 * 1024,
  clientNameChars: 100,
  redirectUris: 5,
  approvalCallbackUris: 10,
  uriChars: 2048,
  successfulPerIpPerHour: 10,
} as const;

const Uri = z.string().min(1).max(OAUTH_REGISTRATION_LIMITS.uriChars);
const Registration = z.object({
  client_name: z.string().min(1).max(OAUTH_REGISTRATION_LIMITS.clientNameChars),
  redirect_uris: z.array(Uri).min(1).max(OAUTH_REGISTRATION_LIMITS.redirectUris),
  approval_callback_uris: z.array(Uri).min(1).max(OAUTH_REGISTRATION_LIMITS.approvalCallbackUris),
}).strict().superRefine((input, context) => {
  for (const [field, values] of [
    ["redirect_uris", input.redirect_uris],
    ["approval_callback_uris", input.approval_callback_uris],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicate exact URIs` });
    }
  }
});

export type OAuthRegistrationInput = z.infer<typeof Registration>;

function bodyBytes(raw: string | Uint8Array): number {
  return typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
}

export function validateRedirectUri(value: string, production = process.env.NODE_ENV === "production"): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createError({ statusCode: 422, statusMessage: "Redirect URI is invalid" });
  }

  if (url.username || url.password || url.hash) {
    throw createError({ statusCode: 422, statusMessage: "Redirect URIs must not contain credentials or fragments" });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const developmentLoopback = !production && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const defaultHttps = url.protocol === "https:" && !url.port;
  if (!defaultHttps && !developmentLoopback) {
    throw createError({
      statusCode: 422,
      statusMessage: production
        ? "Redirect URIs must use HTTPS on the default port"
        : "Redirect URIs must use HTTPS on the default port (loopback HTTP is allowed in development)",
    });
  }
}

export async function parseAndValidateRegistration(
  raw: string | Uint8Array | null | undefined,
  options: ValidatePublicHttpsUrlOptions & { production?: boolean } = {},
): Promise<OAuthRegistrationInput> {
  if (raw == null) throw createError({ statusCode: 400, statusMessage: "Registration body is required" });
  if (bodyBytes(raw) > OAUTH_REGISTRATION_LIMITS.bodyBytes) {
    throw createError({ statusCode: 413, statusMessage: "Registration body exceeds 32 KiB" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Registration body must be valid JSON" });
  }

  const result = Registration.safeParse(decoded);
  if (!result.success) {
    throw createError({ statusCode: 422, statusMessage: "Invalid OAuth client registration", data: result.error.flatten() });
  }

  for (const value of result.data.redirect_uris) validateRedirectUri(value, options.production);
  for (const value of result.data.approval_callback_uris) {
    try {
      await validatePublicHttpsUrl(value, options);
    } catch (error) {
      throw createError({
        statusCode: 422,
        statusMessage: error instanceof Error ? error.message : "Approval callback URL is not a public HTTPS URL",
      });
    }
  }
  return result.data;
}

export function assertRegistrationRateAllowed(successfulRegistrations: number): void {
  if (successfulRegistrations >= OAUTH_REGISTRATION_LIMITS.successfulPerIpPerHour) {
    throw createError({ statusCode: 429, statusMessage: "OAuth client registration rate limit exceeded" });
  }
}

async function insertRegistration(input: OAuthRegistrationInput, registrationIpHash: string): Promise<string> {
  const id = createId();
  return database().sql.begin("isolation level serializable", async (sql) => {
    // A per-source transaction lock makes the count-and-insert atomic across all
    // application processes without retaining the source IP itself.
    await sql`select pg_advisory_xact_lock(hashtextextended(${registrationIpHash}, 0))`;
    const [rate] = await sql`
      select count(*)::integer as count from oauth_clients
      where registration_ip_hash = ${registrationIpHash} and created_at >= now() - interval '1 hour'
    `;
    assertRegistrationRateAllowed(Number(rate?.count ?? 0));
    await sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${id}, ${input.client_name}, ${input.redirect_uris}, ${input.approval_callback_uris}, ${registrationIpHash})
    `;
    return id;
  });
}

export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event, false);
  const input = await parseAndValidateRegistration(raw);
  const sourceIp = getRequestIP(event, { xForwardedFor: true });
  if (!sourceIp) throw createError({ statusCode: 400, statusMessage: "Registration source IP is unavailable" });
  const id = await insertRegistration(input, await tokenHash(sourceIp));
  return {
    client_id: id,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    approval_callback_uris: input.approval_callback_uris,
    token_endpoint_auth_method: "none",
  };
});
